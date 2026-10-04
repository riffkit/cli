import { spawn } from 'node:child_process'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from '../args.js'
import { CliError, EXIT, usage } from '../errors.js'
import { storeToken, usesTokenVariable } from '../files.js'
import { NoAnswer, call, printJson, reasonOf, report } from '../request.js'

export default {
  usage: 'login',
  summary: 'Sign in: approve this terminal once, in the browser',
  async run(ctx, argv) {
    const { positionals } = parseArgs(argv, {})
    if (positionals.length) throw usage(`Unexpected argument: ${positionals[0]}`)
    const account = await ctx.capability('get_account')
    let current = null
    try {
      current = ctx.token()
    } catch {
      // An unusable saved session: sign in again over it.
    }
    if (current) {
      const answer = await ctx.call(account, {}, current)
      if (answer.status === 200) return signedIn(ctx, answer.body)
      if (answer.status !== 401) return report(ctx.io, account, answer)
    }
    const token = await deviceFlow(ctx)
    storeToken(ctx.site, token)
    if (usesTokenVariable(ctx.site, ctx.env)) {
      ctx.say('Note: RIFFKIT_TOKEN is set and is used instead of the saved session. Unset it to use this sign-in.')
    }
    const answer = await ctx.call(account, {}, token)
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

/**
 * The device authorization the agent skill uses (api/routers/skill_device.py):
 * start a flow, show the user the approval link, poll at the advertised
 * interval until the user approves. Returns the new session token, which is
 * never printed.
 */
async function deviceFlow(ctx) {
  const authorize = await ctx.capability('device_authorize')
  const poll = await ctx.capability('device_token')
  // The label the approval records ("which client asked"); it grants nothing.
  const label = authorize.params?.some((p) => p.name === 'client') ? { client: 'cli' } : {}
  const started = await ask(ctx, authorize, label)
  if (started.status !== 200) refused(started)
  const { device_code: deviceCode, user_code: userCode, verification_uri_complete: link } = started.body ?? {}
  if (typeof deviceCode !== 'string' || typeof link !== 'string') {
    throw new CliError(EXIT.REFUSED, 'Riffkit started a sign-in this CLI cannot read.')
  }
  let interval = seconds(started.body.interval, 5)
  const deadline = Date.now() + seconds(started.body.expires_in, 600) * 1000

  ctx.say(`Open this link and click Approve:\n\n  ${link}\n\nCheck that the page shows the code ${userCode}.\n`)
  // Only when a person is watching this terminal; an agent passes the link on.
  if (ctx.io.stderr.isTTY) openBrowser(link)
  ctx.say('Waiting for the approval...')

  for (;;) {
    await sleep(interval * 1000)
    if (Date.now() >= deadline) {
      throw new CliError(EXIT.REFUSED, 'The approval link is no longer valid: nobody approved it in time. Run riffkit login again.')
    }
    const answer = await ask(ctx, poll, { device_code: deviceCode })
    const status = answer.body?.status
    // 429: polled sooner than the server likes. The flow is alive; wait again.
    if (answer.status === 429) continue
    if (answer.status === 200 && status === 'authorization_pending') {
      interval = seconds(answer.body.interval, interval)
      continue
    }
    if (answer.status === 200 && status === 'approved') return answer.body.token
    if (answer.status === 400 && typeof status === 'string') {
      throw new CliError(EXIT.REFUSED, `This sign-in has ended: ${Object.hasOwn(ENDED, status) ? ENDED[status] : status}. Run riffkit login again.`)
    }
    // Anything else, such as a proxy's HTML 403, is not "still waiting".
    refused(answer)
  }
}

/** A sign-in call. No session goes with it, and a lost answer is safe to start over. */
async function ask(ctx, command, args) {
  try {
    return await call(ctx.site, command, args, null)
  } catch (err) {
    if (err instanceof NoAnswer) {
      throw new CliError(EXIT.NO_ANSWER_READ, `Riffkit did not answer the sign-in (${err.message}). Run riffkit login again.`)
    }
    throw err
  }
}

function refused(answer) {
  if (answer.status >= 400 && answer.status < 500) {
    throw new CliError(EXIT.REFUSED, `The sign-in was refused (HTTP ${answer.status}): ${reasonOf(answer)}`)
  }
  throw new CliError(EXIT.NO_ANSWER_READ, `Riffkit did not answer the sign-in (HTTP ${answer.status}). Run riffkit login again.`)
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
