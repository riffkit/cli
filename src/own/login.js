import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, single } from '../args.js'
import { CliError, EXIT, usage } from '../errors.js'
import { readToken, storeToken, usesTokenVariable, writePrivate } from '../files.js'
import { NoAnswer, buildRequest, printJson, reasonOf, report, send } from '../request.js'

// How long an agent's run (--agent, or nobody at the terminal) waits for the
// approval before it exits with EXIT.LOGIN_PENDING: under the ~120 seconds an
// agent's command may run. Counted from the start of the run. The sign-in stays
// in the pending file, and the next riffkit login waits for the same link.
export const AGENT_WAIT_SECONDS = 90
// The longest one sign-in request may take (a stalled connection would hold it
// for minutes), and the time the request an agent's run sends at the end of its
// wait still gets.
const REQUEST_MS = 15_000
const LAST_REQUEST_MS = 2_000
// The approval is asked about once a second at most, whatever interval the
// server or the pending file names.
const MIN_POLL_SECONDS = 1

export default {
  usage: 'login [--agent]',
  summary: `Sign in: approve this terminal once, in the browser (--agent: as an AI agent, wait ${AGENT_WAIT_SECONDS} seconds at most, then exit ${EXIT.LOGIN_PENDING})`,
  details: [
    `Signed in: exit 0, the account as JSON on stdout. Already signed in: says so, exit 0.`,
    `--agent (or no terminal): prints the link and its code on stderr, waits ${AGENT_WAIT_SECONDS} seconds at most, then exits ${EXIT.LOGIN_PENDING}; run it again after the user approves and it keeps waiting on the same link until that link runs out.`,
  ],
  async run(ctx, argv) {
    const { positionals, flags } = parseArgs(argv, { agent: 'boolean' })
    if (positionals.length) throw usage(`Unexpected argument: ${positionals[0]}`)
    const forced = single(flags, 'agent') === 'true'
    // A person at this terminal is waited for. An agent's run is --agent (its
    // shell may give the command a terminal) or one with no terminal on stderr.
    const agent = forced || !ctx.io.stderr.isTTY
    const run = {
      agent,
      // io.loginWaitMs: tests only.
      stopAt: agent ? Date.now() + (ctx.io.loginWaitMs ?? AGENT_WAIT_SECONDS * 1000) : Infinity,
      again: `riffkit login${forced ? ' --agent' : ''}`,
    }
    const account = await ctx.capability('get_account')
    let current = null
    try {
      current = ctx.token()
    } catch {
      // An unusable saved session: sign in again over it.
    }
    if (current) {
      const answer = await ask(ctx, run, account, {}, current)
      if (answer.status === 200) {
        forgetPending(ctx.site)   // signed in already: no sign-in is waiting
        return signedIn(ctx, answer.body)
      }
      if (answer.status !== 401) return report(ctx.io, account, answer)
    }
    const token = await deviceFlow(ctx, run, account)
    storeToken(ctx.site, token)
    if (usesTokenVariable(ctx.site, ctx.env)) {
      ctx.say('Note: RIFFKIT_TOKEN is set and is used instead of the saved session. Unset it to use this sign-in.')
    }
    const answer = await ask(ctx, run, account, {}, token)
    return answer.status === 200 ? signedIn(ctx, answer.body) : report(ctx.io, account, answer)
  },
}

function signedIn(ctx, account) {
  ctx.say(`Signed in to ${ctx.site.base}${account?.email ? ` as ${account.email}` : ''}.`)
  printJson(ctx.io.stdout, account)
  return EXIT.OK
}

// The 400 statuses of a sign-in that cannot continue, in words.
const ENDED = {
  expired: 'the approval link is no longer valid',
  denied: 'this account cannot sign in yet',
  consumed: 'this approval was already used',
  invalid: 'Riffkit does not know this sign-in',
}

const seconds = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)

/** A poll interval in seconds, never under the floor (io.loginMinPollMs: tests only). */
const pollEvery = (ctx, value, fallback) => Math.max(seconds(value, fallback), (ctx.io.loginMinPollMs ?? MIN_POLL_SECONDS * 1000) / 1000)

/**
 * The device authorization the agent skill uses (api/routers/skill_device.py):
 * start a flow, show the user the approval link, poll at the advertised
 * interval until the user approves. Returns the new session token, which is
 * never printed.
 *
 * The flow is kept in the pending file until it is approved or has ended, and
 * a run finding it there waits for that same link instead of starting another.
 * With a person at this terminal the run waits until the link is approved or
 * no longer valid; an agent's run waits until run.stopAt at most, then exits
 * with EXIT.LOGIN_PENDING and the agent runs login again once the user approves.
 */
async function deviceFlow(ctx, run, account) {
  const poll = await ctx.capability('device_token')
  let flow = readPending(ctx)
  // A flow an earlier run started is replaced once when it runs out: that
  // user was given a link, and gets a new one. One this run started ends it.
  let earlier = flow !== null
  let wait = 0   // a flow an earlier run started is asked at once: the user may have approved it
  if (earlier && Date.now() < flow.expiresAt) show(ctx, flow, run)

  for (;;) {
    if (!flow || Date.now() >= flow.expiresAt) {
      if (flow) forgetPending(ctx.site, flow.deviceCode)
      if (flow && !earlier) {
        throw new CliError(EXIT.REFUSED, `The approval link is no longer valid: nobody approved it in time. Run ${run.again} again.`)
      }
      if (flow) ctx.say('The link from the last riffkit login is no longer valid. Here is a new one.')
      earlier = false
      flow = await startFlow(ctx, run)
      show(ctx, flow, run)
      wait = flow.interval
    }
    const left = run.stopAt - Date.now()
    if (left <= 0) throw notApprovedYet(flow, run)
    await sleep(Math.min(wait * 1000, left))
    wait = flow.interval
    if (Date.now() >= flow.expiresAt) continue
    let answer
    try {
      answer = await ask(ctx, run, poll, { device_code: flow.deviceCode })
    } catch (err) {
      // No answer by the end of an agent's wait: the flow is alive, and the next run asks again.
      if (err instanceof CliError && err.code === EXIT.NO_ANSWER_READ && Date.now() >= run.stopAt) throw notApprovedYet(flow, run)
      throw err
    }
    const status = answer.body?.status
    // 429: polled sooner than the server likes. The flow is alive; wait twice as long.
    if (answer.status === 429) {
      wait = flow.interval *= 2
      continue
    }
    if (answer.status === 200 && status === 'authorization_pending') {
      wait = flow.interval = pollEvery(ctx, answer.body.interval, flow.interval)
      continue
    }
    if (answer.status === 200 && status === 'approved') {
      forgetPending(ctx.site, flow.deviceCode)
      return answer.body.token
    }
    if (answer.status === 400 && status === 'expired' && earlier) {
      flow.expiresAt = 0   // ran out by the server's clock: replaced above
      continue
    }
    if (answer.status === 400 && status === 'consumed') {
      // Another riffkit login waiting for the same link got the approval first.
      const saved = await sessionSavedMeanwhile(ctx, run, account)
      if (saved) {
        forgetPending(ctx.site, flow.deviceCode)
        return saved
      }
    }
    if (answer.status === 400 && typeof status === 'string') {
      forgetPending(ctx.site, flow.deviceCode)
      throw new CliError(EXIT.REFUSED, `This sign-in has ended: ${Object.hasOwn(ENDED, status) ? ENDED[status] : status}. Run ${run.again} again.`)
    }
    // Anything else, such as a proxy's HTML 403, is not "still waiting". The
    // flow may be alive, so the pending file stays for the next run.
    refused(answer, run)
  }
}

/**
 * Start a sign-in and keep it in the pending file. When another riffkit login
 * kept one there since this run looked, that one goes on: its link may be the
 * one the user already has, so this run waits for it too.
 */
async function startFlow(ctx, run) {
  const authorize = await ctx.capability('device_authorize')
  // The label the approval records ("which client asked"); it grants nothing.
  const label = authorize.params?.some((p) => p.name === 'client') ? { client: 'cli' } : {}
  const started = await ask(ctx, run, authorize, label)
  if (started.status !== 200) refused(started, run)
  const { device_code: deviceCode, user_code: userCode, verification_uri_complete: link } = started.body ?? {}
  if (typeof deviceCode !== 'string' || !deviceCode || typeof link !== 'string') {
    throw new CliError(EXIT.REFUSED, 'Riffkit started a sign-in this CLI cannot read.')
  }
  const flow = {
    deviceCode,
    userCode,
    link,
    expiresAt: Date.now() + seconds(started.body.expires_in, 600) * 1000,
    interval: pollEvery(ctx, started.body.interval, 5),
  }
  const kept = JSON.stringify({
    device_code: flow.deviceCode,
    user_code: flow.userCode,
    link: flow.link,
    expires_at: new Date(flow.expiresAt).toISOString(),
    interval: flow.interval,
  })
  if (!writePrivate(ctx.site.pendingFile, kept, { exclusive: true })) {
    const other = readPending(ctx)
    if (other && Date.now() < other.expiresAt) return other
    writePrivate(ctx.site.pendingFile, kept)
  }
  return flow
}

/** The link and the code on stderr, never the device code. */
function show(ctx, flow, run) {
  ctx.say(`Open this link and click Approve:\n\n  ${flow.link}\n\nCheck that the page shows the code ${flow.userCode}.\n`)
  // Only when a person is watching this terminal; an agent passes the link on.
  if (!run.agent) openBrowser(flow.link)
  ctx.say(run.agent
    ? `Waiting up to ${Math.ceil(Math.max(0, run.stopAt - Date.now()) / 1000)} seconds for the approval...`
    : 'Waiting for the approval...')
}

/**
 * EXIT.LOGIN_PENDING. The time the link has left is given from now, not as a
 * time of day: the agent's machine and the user may be in different time zones.
 */
function notApprovedYet(flow, run) {
  const minutes = Math.max(1, Math.floor((flow.expiresAt - Date.now()) / 60_000))
  return new CliError(EXIT.LOGIN_PENDING,
    `No approval yet: after the user approves, run ${run.again} again (the link works for about ${minutes} more minute${minutes === 1 ? '' : 's'}).`)
}

/**
 * The sign-in an earlier run kept, or null. A file this CLI cannot read is
 * removed; its contents are never shown (they hold the device code). One that
 * cannot be removed either (a directory, say) ends the run with its name.
 */
function readPending(ctx) {
  const file = ctx.site.pendingFile
  let kept = null
  try {
    kept = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
  }
  const expiresAt = Date.parse(kept?.expires_at)
  if (typeof kept?.device_code !== 'string' || !kept.device_code || typeof kept.link !== 'string' || Number.isNaN(expiresAt)) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      throw new CliError(EXIT.REFUSED, `Cannot use ${file}: remove it, then run riffkit login again.`)
    }
    return null
  }
  return { deviceCode: kept.device_code, userCode: kept.user_code, link: kept.link, expiresAt, interval: pollEvery(ctx, kept.interval, 5) }
}

/**
 * Remove the pending file; given a device code, only while the file still
 * holds that sign-in (another riffkit login may have kept a newer one there).
 * Never fails the run: a file that cannot be removed is readPending's to report.
 */
function forgetPending(site, deviceCode) {
  try {
    if (deviceCode === undefined || JSON.parse(fs.readFileSync(site.pendingFile, 'utf8'))?.device_code === deviceCode) {
      fs.rmSync(site.pendingFile, { force: true })
    }
  } catch {
    // gone already, another run's, or not removable here
  }
}

/**
 * The session another riffkit login saved after it got the approval this run
 * was waiting for, when it works; else null. That run saves it as soon as the
 * approval comes back, so the file is given a moment to appear.
 */
async function sessionSavedMeanwhile(ctx, run, account) {
  for (let check = 0; check < 4; check++) {
    if (check) await sleep(500)
    let token = null
    try {
      token = readToken(ctx.site, {})   // the session file itself, never RIFFKIT_TOKEN
    } catch {
      // not a session
    }
    if (token && (await ask(ctx, run, account, {}, token)).status === 200) return token
  }
  return null
}

/**
 * A sign-in call, with `token` as its session when given. It gets REQUEST_MS at
 * most, and in an agent's run no more than LAST_REQUEST_MS past run.stopAt. A
 * lost answer is safe to start over.
 */
async function ask(ctx, run, command, args, token = null) {
  const request = await buildRequest(ctx.site, command, args, token)
  request.init.signal = AbortSignal.timeout(Math.min(REQUEST_MS, Math.max(LAST_REQUEST_MS, run.stopAt - Date.now())))
  try {
    return await send(request)
  } catch (err) {
    if (err instanceof NoAnswer) {
      throw new CliError(EXIT.NO_ANSWER_READ, `Riffkit did not answer the sign-in (${err.message}). Run ${run.again} again.`)
    }
    throw err
  }
}

function refused(answer, run) {
  if (answer.status >= 400 && answer.status < 500) {
    throw new CliError(EXIT.REFUSED, `The sign-in was refused (HTTP ${answer.status}): ${reasonOf(answer)}`)
  }
  throw new CliError(EXIT.NO_ANSWER_READ, `Riffkit did not answer the sign-in (HTTP ${answer.status}). Run ${run.again} again.`)
}

/**
 * The program that opens `url` in the default browser, and its arguments. The
 * URL goes as one argument to a program, never through a shell (on Windows
 * rundll32 rather than `cmd /c start`, whose parser would read & and % in a
 * URL). rundll32 is named by its full path: Windows looks for a bare name in
 * the current directory first, where anyone could have left one.
 */
export function browserCommand(url, platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') {
    return [path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]]
  }
  return ['xdg-open', [url]]
}

/** Open the approval page in the default browser, best effort. */
function openBrowser(url) {
  if (!/^https?:\/\/[^\s"]+$/.test(url)) return
  const [program, args] = browserCommand(url)
  try {
    const child = spawn(program, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // No browser here: the link above is enough.
  }
}
