// riffkit login / logout: the device authorization state machine, where the
// session is kept, and that it is never printed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIXTURE, POSIX, SENTINEL, runCli, saveSession, startStub, tempDir } from './helpers.js'

const ACCOUNT = { id: 'u1', email: 'maker@example.com', role: 'owner', is_active: true }
const STARTED = {
  device_code: 'device-code-secret',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://riffkit.ai/skill/device',
  verification_uri_complete: 'https://riffkit.ai/skill/device?code=ABCD-EFGH&skill=cli',
  expires_in: 30,
  interval: 0.05,
}

/** A stub running a device flow: /api/skill/device/token answers `polls` in turn. */
async function flowStub(polls, { started = STARTED, account = () => ({ json: ACCOUNT }) } = {}) {
  let n = 0
  return startStub({
    handler(record) {
      if (record.url === '/api/skill/device/authorize') return { json: started }
      if (record.url === '/api/skill/device/token') return polls[Math.min(n++, polls.length - 1)]
      if (record.url === '/api/auth/me') return account(record)
      if (record.url === '/api/auth/logout') return { json: { ok: true } }
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
}

const sessionFile = (home, base) => {
  const port = new URL(base).port
  return path.join(home, '.riffkit', `session-127.0.0.1-${port}`)
}
const pending = { json: { status: 'authorization_pending', interval: 0.05 } }

test('pending, 429, then approved: the session is kept and never printed', async () => {
  const stub = await flowStub([pending, { status: 429, json: { detail: 'slow down' } }, { json: { status: 'approved', token: SENTINEL } }])
  const home = tempDir()
  try {
    const result = await inProcess(['login'], { home, base: stub.base })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), ACCOUNT)
    assert.ok(!result.stdout.includes(SENTINEL) && !result.stderr.includes(SENTINEL))
    assert.match(result.stderr, /skill\/device\?code=ABCD-EFGH/)
    assert.match(result.stderr, /ABCD-EFGH/)
    assert.match(result.stderr, /maker@example\.com/)
    assert.equal(fs.readFileSync(sessionFile(home, stub.base), 'utf8'), SENTINEL)

    const api = stub.api()
    assert.deepEqual(JSON.parse(api[0].body), { client: 'cli' })
    assert.equal(api[0].headers.cookie, undefined)
    const polls = api.filter((r) => r.url === '/api/skill/device/token')
    assert.equal(polls.length, 3)
    for (const poll of polls) assert.deepEqual(JSON.parse(poll.body), { device_code: 'device-code-secret' })
    assert.equal(api.at(-1).headers.cookie, `vee_session=${SENTINEL}`)

    if (POSIX) {
      assert.equal(fs.statSync(path.join(home, '.riffkit')).mode & 0o777, 0o700)
      assert.equal(fs.statSync(sessionFile(home, stub.base)).mode & 0o777, 0o600)
      assert.deepEqual(fs.readdirSync(path.join(home, '.riffkit')).filter((f) => f.endsWith('.tmp')), [])
    }

    // Signed in now: login says so and starts nothing.
    const again = await runCli(['login'], { home, base: stub.base })
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stderr, /Signed in .* as maker@example\.com/)
    assert.equal(stub.api().filter((r) => r.url === '/api/skill/device/authorize').length, 1)
    assert.ok(!again.stdout.includes(SENTINEL) && !again.stderr.includes(SENTINEL))
  } finally {
    await stub.close()
  }
})

test('a wider ~/.riffkit made earlier is narrowed to 0700', { skip: !POSIX }, async () => {
  const stub = await flowStub([{ json: { status: 'approved', token: SENTINEL } }])
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.riffkit'), { mode: 0o755 })
  fs.chmodSync(path.join(home, '.riffkit'), 0o755)
  try {
    assert.equal((await inProcess(['login'], { home, base: stub.base })).code, 0)
    assert.equal(fs.statSync(path.join(home, '.riffkit')).mode & 0o777, 0o700)
  } finally {
    await stub.close()
  }
})

test('a non-JSON 403 while polling is an error, not "still waiting"', async () => {
  const stub = await flowStub([pending, { status: 403, text: '<html>error code: 1010</html>' }, { json: { status: 'approved', token: SENTINEL } }])
  const home = tempDir()
  try {
    const result = await inProcess(['login'], { home, base: stub.base })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /refused \(HTTP 403\)/)
    assert.equal(stub.api().filter((r) => r.url === '/api/skill/device/token').length, 2)
    assert.equal(fs.existsSync(sessionFile(home, stub.base)), false)
    // The flow may be alive: it stays for the next run.
    assert.equal(JSON.parse(fs.readFileSync(pendingFile(home, stub.base), 'utf8')).device_code, 'device-code-secret')
  } finally {
    await stub.close()
  }
})

test('nobody approves: polling stops when the flow runs out', async () => {
  const slow = { json: { status: 'authorization_pending', interval: 0.1 } }
  const stub = await flowStub([slow], { started: { ...STARTED, expires_in: 0.4, interval: 0.1 } })
  const home = tempDir()
  try {
    const started = Date.now()
    const result = await inProcess(['login'], { home, base: stub.base })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no longer valid/)
    assert.ok(Date.now() - started < 5000)
    assert.ok(stub.api().filter((r) => r.url === '/api/skill/device/token').length <= 5)
  } finally {
    await stub.close()
  }
})

for (const status of ['expired', 'denied', 'consumed', 'invalid']) {
  test(`a 400 ${status} ends the sign-in`, async () => {
    const stub = await flowStub([pending, { status: 400, json: { status } }])
    const home = tempDir()
    try {
      const result = await inProcess(['login'], { home, base: stub.base })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /This sign-in has ended: .*riffkit login again/)
      assert.doesNotMatch(result.stderr, /expire/i)
    } finally {
      await stub.close()
    }
  })
}

test('a saved session that no longer works starts a new sign-in over it', async () => {
  const stub = await flowStub([{ json: { status: 'approved', token: 'fresh-session' } }], {
    account: (record) => (record.headers.cookie === 'vee_session=fresh-session' ? { json: ACCOUNT } : { status: 401, json: { detail: 'no' } }),
  })
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.riffkit'))
  fs.writeFileSync(sessionFile(home, stub.base), 'old-session')
  try {
    const result = await inProcess(['login'], { home, base: stub.base })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(fs.readFileSync(sessionFile(home, stub.base), 'utf8'), 'fresh-session')
    assert.ok(!result.stdout.includes('fresh-session') && !result.stderr.includes('fresh-session'))
  } finally {
    await stub.close()
  }
})

test('logout ends the session on the server, then removes the file', async () => {
  const stub = await flowStub([])
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.riffkit'))
  fs.writeFileSync(sessionFile(home, stub.base), SENTINEL)
  try {
    const result = await runCli(['logout'], { home, base: stub.base })
    assert.equal(result.code, 0, result.stderr)
    const [call] = stub.api()
    assert.equal(call.url, '/api/auth/logout')
    assert.equal(call.headers.cookie, `vee_session=${SENTINEL}`)
    assert.equal(fs.existsSync(sessionFile(home, stub.base)), false)
    assert.ok(!result.stderr.includes(SENTINEL))
  } finally {
    await stub.close()
  }
})

test('logout with Riffkit unreachable still removes the file and says the session may be live', async () => {
  const stub = await startStub({ handler: () => 'reset' })
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.riffkit'))
  fs.writeFileSync(sessionFile(home, stub.base), SENTINEL)
  try {
    const result = await runCli(['logout'], { home, base: stub.base })
    assert.equal(result.code, 6)
    assert.match(result.stderr, /may still be live/)
    assert.equal(fs.existsSync(sessionFile(home, stub.base)), false)
    assert.ok(!result.stderr.includes(SENTINEL))
  } finally {
    await stub.close()
  }
})

test('the default site keeps the session in ~/.riffkit/session, the file the skill writes', async () => {
  const { siteFrom } = await import('../src/site.js')
  const site = siteFrom({ RIFFKIT_BASE_URL: 'https://riffkit.ai/' })
  assert.equal(path.basename(site.sessionFile), 'session')
  assert.equal(path.basename(site.manifestFile), 'cli-manifest-riffkit.ai.json')
  assert.equal(path.basename(siteFrom({ RIFFKIT_BASE_URL: 'http://localhost:8000' }).sessionFile), 'session-localhost-8000')
  assert.equal(path.basename(siteFrom({ RIFFKIT_BASE_URL: 'https://staging.example.com' }).sessionFile), 'session-staging.example.com-443')
})

/**
 * Run `riffkit ...argv` in this process against https://riffkit.ai, the one
 * site RIFFKIT_TOKEN goes to, with HOME a fresh directory (`prepare(home)` runs
 * first) and every request but the command list answered by `answer(path,
 * init)` (a Response, or a throw for no answer). Resolves { code, stdout,
 * stderr, home, sent: [{ path, cookie }] }.
 */
async function atRiffkit(argv, env, answer, prepare = () => {}) {
  const { main } = await import('../src/main.js')
  const home = tempDir()
  prepare(home)
  const was = { fetch: globalThis.fetch, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  const sent = []
  process.env.HOME = home
  process.env.USERPROFILE = home
  globalThis.fetch = async (url, init = {}) => {
    const { origin, pathname } = new URL(url)
    assert.equal(origin, 'https://riffkit.ai')
    sent.push({ path: pathname, cookie: init.headers?.Cookie })
    return pathname === '/cli.json' ? Response.json(FIXTURE) : answer(pathname, init)
  }
  const out = { text: '', isTTY: false, write(chunk) { this.text += chunk } }
  const err = { text: '', isTTY: false, write(chunk) { this.text += chunk } }
  try {
    const code = await main(argv, { stdout: out, stderr: err, stdin: null, env, loginMinPollMs: 0 })
    return { code, stdout: out.text, stderr: err.text, home, sent }
  } finally {
    globalThis.fetch = was.fetch
    for (const key of ['HOME', 'USERPROFILE']) {
      if (was[key] === undefined) delete process.env[key]
      else process.env[key] = was[key]
    }
  }
}

const unreachable = () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }

test('a RIFFKIT_TOKEN riffkit.ai refuses: login signs in anyway and says the variable is in the way', async () => {
  const result = await atRiffkit(['login'], { RIFFKIT_TOKEN: SENTINEL }, (where, init) => {
    if (where === '/api/skill/device/authorize') return Response.json(STARTED)
    if (where === '/api/skill/device/token') return Response.json({ status: 'approved', token: 'fresh-session' })
    if (where === '/api/auth/me') {
      return init.headers.Cookie === 'vee_session=fresh-session' ? Response.json(ACCOUNT) : Response.json({ detail: 'no' }, { status: 401 })
    }
    return Response.json({ detail: 'Not Found' }, { status: 404 })
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.sent.find((r) => r.path === '/api/auth/me').cookie, `vee_session=${SENTINEL}`)
  assert.match(result.stderr, /RIFFKIT_TOKEN is set/)
  assert.equal(fs.readFileSync(path.join(result.home, '.riffkit', 'session'), 'utf8'), 'fresh-session')
  assert.ok(!result.stderr.includes(SENTINEL) && !result.stdout.includes(SENTINEL))
})

test('RIFFKIT_TOKEN is the riffkit.ai session: login to another site uses its own file and never sends it', async () => {
  const stub = await flowStub([{ json: { status: 'approved', token: 'fresh-session' } }])
  const home = tempDir()
  try {
    const result = await inProcess(['login'], { home, base: stub.base, env: { RIFFKIT_TOKEN: SENTINEL } })
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /RIFFKIT_TOKEN/)
    assert.equal(fs.readFileSync(sessionFile(home, stub.base), 'utf8'), 'fresh-session')
    for (const request of stub.requests) assert.ok(!JSON.stringify(request.headers).includes(SENTINEL))
  } finally {
    await stub.close()
  }
})

for (const [label, answer, code, said] of [
  ['answers', () => Response.json({ ok: true }), 0, /Signed out the session in RIFFKIT_TOKEN: unset it/],
  ['cannot be reached', unreachable, 6, /session in RIFFKIT_TOKEN may still be live/],
]) {
  test(`logout of RIFFKIT_TOKEN when riffkit.ai ${label}: says what became of that session, keeps the saved file`, async () => {
    const result = await atRiffkit(['logout'], { RIFFKIT_TOKEN: SENTINEL }, answer, (home) => {
      fs.mkdirSync(path.join(home, '.riffkit'))
      fs.writeFileSync(path.join(home, '.riffkit', 'session'), 'saved-session')
    })
    assert.equal(result.code, code, result.stderr)
    assert.match(result.stderr, said)
    assert.doesNotMatch(result.stderr, /Removed the session here/)
    assert.equal(result.sent.find((r) => r.path === '/api/auth/logout').cookie, `vee_session=${SENTINEL}`)
    assert.equal(fs.readFileSync(path.join(result.home, '.riffkit', 'session'), 'utf8'), 'saved-session')
    assert.ok(!result.stderr.includes(SENTINEL))
  })
}

test('on Windows the browser opens through rundll32 named by its full path, never a bare name', async () => {
  const { browserCommand } = await import('../src/own/login.js')
  const url = 'https://riffkit.ai/skill/device?code=ABCD-EFGH&skill=cli'
  assert.deepEqual(browserCommand(url, 'win32', { SystemRoot: 'D:\\WINDOWS' }),
    ['D:\\WINDOWS\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', url]])
  assert.equal(browserCommand(url, 'win32', {})[0], 'C:\\Windows\\System32\\rundll32.exe')
  assert.deepEqual(browserCommand(url, 'darwin', {}), ['open', [url]])
  assert.deepEqual(browserCommand(url, 'linux', {}), ['xdg-open', [url]])
})

// ── Signing in with nobody at the terminal (an agent), and the pending file ──

const pendingFile = (home, base) => path.join(home, '.riffkit', `login-pending-127.0.0.1-${new URL(base).port}`)
const SECRETS = ['device-code-secret', 'old-device-code']
const neverShown = (result) => {
  for (const secret of [...SECRETS, SENTINEL]) {
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), `${secret} was printed`)
  }
}

/** Keep a sign-in an earlier run started, as the CLI writes it. */
function keepPending(home, base, fields = {}) {
  fs.mkdirSync(path.join(home, '.riffkit'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(pendingFile(home, base), JSON.stringify({
    device_code: 'old-device-code',
    user_code: 'WXYZ-2345',
    link: 'https://riffkit.ai/skill/device?code=WXYZ-2345&skill=cli',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    interval: 0.05,
    ...fields,
  }), { mode: 0o600 })
}

/** A stub whose device_token answers by the device code polled: `answers[code]`, else pending. */
async function codeStub(answers) {
  return startStub({
    handler(record) {
      if (record.url === '/api/skill/device/authorize') return { json: STARTED }
      if (record.url === '/api/skill/device/token') return answers[JSON.parse(record.body).device_code]?.() ?? pending
      if (record.url === '/api/auth/me') return { json: ACCOUNT }
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
}
const approved = (token = SENTINEL) => () => ({ json: { status: 'approved', token } })
const authorizeCalls = (stub) => stub.api().filter((r) => r.url === '/api/skill/device/authorize').length
const polledCodes = (stub) => stub.api().filter((r) => r.url === '/api/skill/device/token').map((r) => JSON.parse(r.body).device_code)

/**
 * Run `riffkit ...argv` in this process against `base`, with HOME `home` and,
 * as runCli does, `token` saved as that site's session first. stderr is a
 * terminal when `tty`. `loginWaitMs` stands in for the agent's 90 seconds and
 * `loginMinPollMs` (0 unless given; null for the CLI's own) for the 1-second
 * floor on the poll interval, so a test need not wait them out.
 */
async function inProcess(argv, { home, token, ...options }) {
  if (token) saveSession(home, options.base, token)
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return await mainHere(argv, options)
  } finally {
    for (const key of ['HOME', 'USERPROFILE']) {
      if (was[key] === undefined) delete process.env[key]
      else process.env[key] = was[key]
    }
  }
}

/** Run main in this process, HOME as it is: several can run at once. */
async function mainHere(argv, { base, env = {}, tty = false, loginWaitMs, loginMinPollMs = 0 }) {
  const { main } = await import('../src/main.js')
  const out = { text: '', isTTY: false, write(chunk) { this.text += chunk } }
  const err = { text: '', isTTY: tty, write(chunk) { this.text += chunk } }
  const code = await main(argv, {
    stdout: out,
    stderr: err,
    stdin: null,
    env: { RIFFKIT_BASE_URL: base, RIFFKIT_NO_UPDATE_CHECK: '1', ...env },
    loginWaitMs,
    loginMinPollMs,
  })
  return { code, stdout: out.text, stderr: err.text }
}

/** Run several `riffkit ...argv` at once in this process, all with HOME `home`. */
async function together(home, runs) {
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return await Promise.all(runs.map(([argv, options]) => mainHere(argv, options)))
  } finally {
    for (const key of ['HOME', 'USERPROFILE']) {
      if (was[key] === undefined) delete process.env[key]
      else process.env[key] = was[key]
    }
  }
}

test('an agent waits 90 seconds at most, under the ~120 an agent\'s command may run', async () => {
  const { AGENT_WAIT_SECONDS } = await import('../src/own/login.js')
  assert.equal(AGENT_WAIT_SECONDS, 90)
})

test('no terminal: the link and code are printed, the run exits 12 unapproved, and the next run waits for the same link', async () => {
  let approve = false
  const stub = await codeStub({ 'device-code-secret': () => (approve ? approved()() : pending) })
  const home = tempDir()
  try {
    const started = Date.now()
    const first = await inProcess(['login'], { home, base: stub.base, loginWaitMs: 300 })
    assert.equal(first.code, 12, first.stderr)
    assert.ok(Date.now() - started >= 300)
    assert.equal(first.stdout, '')
    assert.match(first.stderr, /skill\/device\?code=ABCD-EFGH/)
    assert.match(first.stderr, /shows the code ABCD-EFGH/)
    assert.match(first.stderr, /riffkit: No approval yet: after the user approves, run riffkit login again \(the link works for about 1 more minute\)\.\n$/)
    neverShown(first)
    assert.equal(authorizeCalls(stub), 1)
    assert.ok(polledCodes(stub).length >= 2)

    const kept = JSON.parse(fs.readFileSync(pendingFile(home, stub.base), 'utf8'))
    assert.equal(kept.device_code, 'device-code-secret')
    assert.equal(kept.user_code, 'ABCD-EFGH')
    assert.equal(kept.link, STARTED.verification_uri_complete)
    assert.ok(Date.parse(kept.expires_at) > Date.now())
    assert.equal(kept.interval, 0.05)
    if (POSIX) {
      assert.equal(fs.statSync(pendingFile(home, stub.base)).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.join(home, '.riffkit')).mode & 0o777, 0o700)
      assert.deepEqual(fs.readdirSync(path.join(home, '.riffkit')).filter((f) => f.endsWith('.tmp')), [])
    }
    assert.equal(fs.existsSync(sessionFile(home, stub.base)), false)

    // Still not approved: the same link again, no new sign-in.
    const second = await inProcess(['login'], { home, base: stub.base, loginWaitMs: 200 })
    assert.equal(second.code, 12, second.stderr)
    assert.match(second.stderr, /skill\/device\?code=ABCD-EFGH/)
    neverShown(second)
    assert.equal(authorizeCalls(stub), 1)

    // The user approves; the agent runs login again.
    approve = true
    const third = await runCli(['login'], { home, base: stub.base })
    assert.equal(third.code, 0, third.stderr)
    assert.deepEqual(JSON.parse(third.stdout), ACCOUNT)
    assert.match(third.stderr, /Signed in .* as maker@example\.com/)
    neverShown(third)
    assert.equal(authorizeCalls(stub), 1)
    assert.ok(polledCodes(stub).every((code) => code === 'device-code-secret'))
    assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
    assert.equal(fs.readFileSync(sessionFile(home, stub.base), 'utf8'), SENTINEL)
  } finally {
    await stub.close()
  }
})

for (const status of ['denied', 'consumed', 'invalid']) {
  test(`a kept sign-in the server says is ${status}: the pending file goes, and nothing new starts`, async () => {
    const stub = await codeStub({ 'old-device-code': () => ({ status: 400, json: { status } }) })
    const home = tempDir()
    keepPending(home, stub.base)
    try {
      const result = await runCli(['login'], { home, base: stub.base })
      assert.equal(result.code, 1, result.stderr)
      assert.match(result.stderr, /WXYZ-2345/)
      assert.match(result.stderr, /This sign-in has ended: .*riffkit login again/)
      neverShown(result)
      assert.equal(authorizeCalls(stub), 0)
      assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
    } finally {
      await stub.close()
    }
  })
}

for (const [label, fields, answers] of [
  ['the kept sign-in ran out', { expires_at: new Date(Date.now() - 1000).toISOString() }, {}],
  ['the server says the kept sign-in expired', {}, { 'old-device-code': () => ({ status: 400, json: { status: 'expired' } }) }],
  ['the pending file cannot be read', null, {}],
]) {
  test(`${label}: a new sign-in starts, with a new link`, async () => {
    const stub = await codeStub({ ...answers, 'device-code-secret': approved() })
    const home = tempDir()
    if (fields) keepPending(home, stub.base, fields)
    else {
      fs.mkdirSync(path.join(home, '.riffkit'), { recursive: true })
      fs.writeFileSync(pendingFile(home, stub.base), '{"device_code": "old-device-code", ')
    }
    try {
      const result = await inProcess(['login'], { home, base: stub.base })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(authorizeCalls(stub), 1)
      assert.match(result.stderr, /skill\/device\?code=ABCD-EFGH/)
      if (fields) assert.match(result.stderr, /no longer valid\. Here is a new one\./)
      assert.doesNotMatch(result.stderr, /expire/i)
      neverShown(result)
      assert.equal(polledCodes(stub).at(-1), 'device-code-secret')
      assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
      assert.equal(fs.readFileSync(sessionFile(home, stub.base), 'utf8'), SENTINEL)
    } finally {
      await stub.close()
    }
  })
}

test('signed in already: login says who, and drops a sign-in still waiting', async () => {
  const stub = await codeStub({})
  const home = tempDir()
  keepPending(home, stub.base)
  try {
    const result = await runCli(['login'], { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /Signed in .* as maker@example\.com/)
    assert.equal(authorizeCalls(stub), 0)
    assert.equal(polledCodes(stub).length, 0)
    assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
  } finally {
    await stub.close()
  }
})

// A link the CLI does not open in a browser (not http), so these tests open none.
const TTY_STARTED = { ...STARTED, verification_uri_complete: 'riffkit-test:device?code=ABCD-EFGH' }

test('at a terminal: login waits past the agent\'s limit until approved, and clears the pending file', async () => {
  const stub = await flowStub([pending, pending, pending, { json: { status: 'approved', token: SENTINEL } }], { started: TTY_STARTED })
  const home = tempDir()
  try {
    // An agent's run would give up after 1 ms; a person at the terminal is waited for.
    const result = await inProcess(['login'], { home, base: stub.base, tty: true, loginWaitMs: 1 })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /Waiting for the approval\.\.\./)
    assert.match(result.stderr, /Signed in .* as maker@example\.com/)
    neverShown(result)
    assert.equal(stub.api().filter((r) => r.url === '/api/skill/device/token').length, 4)
    assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
    assert.equal(fs.readFileSync(sessionFile(home, stub.base), 'utf8'), SENTINEL)
  } finally {
    await stub.close()
  }
})

test('at a terminal: a kept sign-in is waited for, and one that runs out ends the run and leaves no pending file', async () => {
  const stub = await codeStub({ 'old-device-code': approved() })
  const home = tempDir()
  keepPending(home, stub.base, { link: 'riffkit-test:device?code=WXYZ-2345' })
  try {
    const resumed = await inProcess(['login'], { home, base: stub.base, tty: true })
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.equal(authorizeCalls(stub), 0)
    assert.match(resumed.stderr, /WXYZ-2345/)
    assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
  } finally {
    await stub.close()
  }

  const slow = { json: { status: 'authorization_pending', interval: 0.1 } }
  const lapsing = await flowStub([slow], { started: { ...TTY_STARTED, expires_in: 0.4, interval: 0.1 } })
  const other = tempDir()
  try {
    const result = await inProcess(['login'], { home: other, base: lapsing.base, tty: true })
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, /no longer valid: nobody approved it in time/)
    assert.equal(fs.existsSync(pendingFile(other, lapsing.base)), false)
  } finally {
    await lapsing.close()
  }
})

/**
 * Stub answers held until `n` requests wait for one (or a second has passed),
 * then given all at once: runs that each send one are then at the same point.
 */
function heldUntil(n) {
  const waiting = []
  const release = () => waiting.splice(0).forEach((go) => go())
  return (answer) => new Promise((resolve) => {
    waiting.push(() => resolve(answer))
    if (waiting.length >= n) release()
    else setTimeout(release, 1000)
  })
}

test('two logins started at once, with no sign-in kept: both wait for the one link in the pending file', async () => {
  // Each asks for a sign-in before either has kept one.
  const hold = heldUntil(2)
  let started = 0
  const stub = await startStub({
    handler(record) {
      if (record.url === '/api/skill/device/authorize') {
        const n = ++started
        return hold({ json: { ...STARTED, device_code: `device-code-${n}`, user_code: `CODE-000${n}`, verification_uri_complete: `https://riffkit.ai/skill/device?code=CODE-000${n}&skill=cli` } })
      }
      if (record.url === '/api/skill/device/token') return pending
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
  const home = tempDir()
  try {
    const runs = await together(home, [[['login'], { base: stub.base, loginWaitMs: 400 }], [['login'], { base: stub.base, loginWaitMs: 400 }]])
    for (const run of runs) assert.equal(run.code, 12, run.stderr)
    assert.equal(authorizeCalls(stub), 2)
    const kept = JSON.parse(fs.readFileSync(pendingFile(home, stub.base), 'utf8'))
    // Every poll is for the link the user was given, whichever run they read it from.
    assert.deepEqual([...new Set(polledCodes(stub))], [kept.device_code])
    const other = kept.user_code === 'CODE-0001' ? 'CODE-0002' : 'CODE-0001'
    for (const run of runs) {
      assert.ok(run.stderr.includes(kept.link), run.stderr)
      assert.ok(!run.stderr.includes(other), run.stderr)
    }
  } finally {
    await stub.close()
  }
})

test('two logins waiting for the same link: one gets the approval, and both end signed in', async () => {
  const hold = heldUntil(2)
  let polls = 0
  const stub = await startStub({
    handler(record) {
      if (record.url === '/api/skill/device/token') {
        return hold(++polls === 1 ? { json: { status: 'approved', token: SENTINEL } } : { status: 400, json: { status: 'consumed' } })
      }
      if (record.url === '/api/auth/me') {
        return record.headers.cookie === `vee_session=${SENTINEL}` ? { json: ACCOUNT } : { status: 401, json: { detail: 'no' } }
      }
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
  const home = tempDir()
  keepPending(home, stub.base)
  try {
    const runs = await together(home, [[['login'], { base: stub.base }], [['login'], { base: stub.base }]])
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr)
      assert.deepEqual(JSON.parse(run.stdout), ACCOUNT)
      assert.match(run.stderr, /Signed in .* as maker@example\.com/)
      neverShown(run)
    }
    assert.equal(polls, 2)
    assert.equal(authorizeCalls(stub), 0)
    assert.equal(fs.readFileSync(sessionFile(home, stub.base), 'utf8'), SENTINEL)
    assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
  } finally {
    await stub.close()
  }
})

test('consumed, and another login has saved a session that works: signed in, not an error', async () => {
  const home = tempDir()
  const stub = await startStub({
    handler(record) {
      if (record.url === '/api/skill/device/token') {
        saveSession(home, stub.base, SENTINEL)   // the other run, which got the approval
        return { status: 400, json: { status: 'consumed' } }
      }
      if (record.url === '/api/auth/me') {
        return record.headers.cookie === `vee_session=${SENTINEL}` ? { json: ACCOUNT } : { status: 401, json: { detail: 'no' } }
      }
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
  keepPending(home, stub.base)
  try {
    const result = await runCli(['login'], { home, base: stub.base })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /Signed in .* as maker@example\.com/)
    assert.doesNotMatch(result.stderr, /has ended/)
    neverShown(result)
    assert.equal(authorizeCalls(stub), 0)
    assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
  } finally {
    await stub.close()
  }
})

test('a login whose own link runs out leaves alone a newer sign-in another login kept', async () => {
  const home = tempDir()
  let replaced = false
  const stub = await startStub({
    handler(record) {
      if (record.url === '/api/skill/device/authorize') return { json: { ...TTY_STARTED, expires_in: 0.4, interval: 0.1 } }
      if (record.url === '/api/skill/device/token') {
        if (!replaced) {
          replaced = true
          keepPending(home, stub.base, { device_code: 'newer-device-code' })   // another riffkit login
        }
        return { json: { status: 'authorization_pending', interval: 0.1 } }
      }
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
  try {
    const result = await inProcess(['login'], { home, base: stub.base, tty: true })
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, /nobody approved it in time/)
    assert.equal(JSON.parse(fs.readFileSync(pendingFile(home, stub.base), 'utf8')).device_code, 'newer-device-code')
  } finally {
    await stub.close()
  }
})

test('a poll interval of 0 is not taken at its word', async () => {
  let polls = 0
  const stub = await startStub({
    handler(record) {
      if (record.url === '/api/skill/device/token') {
        return ++polls === 1 ? { json: { status: 'authorization_pending', interval: 0 } } : pending
      }
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
  const home = tempDir()
  keepPending(home, stub.base, { interval: 0 })
  try {
    // The CLI's own floor: polls at 0 s, 1 s, and at the end of the 1.5-second wait.
    const result = await inProcess(['login'], { home, base: stub.base, loginWaitMs: 1500, loginMinPollMs: null })
    assert.equal(result.code, 12, result.stderr)
    assert.ok(polls <= 4, `${polls} polls`)
  } finally {
    await stub.close()
  }
})

test('each 429 doubles the wait before the next poll', async () => {
  let polls = 0
  const stub = await startStub({
    handler(record) {
      if (record.url === '/api/skill/device/token') {
        polls++
        return { status: 429, json: { detail: 'slow down' } }
      }
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
  const home = tempDir()
  keepPending(home, stub.base, { interval: 0.1 })
  try {
    // At 0, 0.2, 0.6 and 1.0 s; polling every 0.1 s would be 11 times.
    const result = await inProcess(['login'], { home, base: stub.base, loginWaitMs: 1000 })
    assert.equal(result.code, 12, result.stderr)
    assert.ok(polls <= 5, `${polls} polls`)
  } finally {
    await stub.close()
  }
})

test('an agent\'s poll that gets no answer still ends the run on time, with the link kept', { timeout: 20_000 }, async () => {
  const stub = await startStub({
    handler(record) {
      if (record.url === '/api/skill/device/token') return new Promise(() => {})   // never answers
      return { status: 404, json: { detail: 'Not Found' } }
    },
  })
  const home = tempDir()
  keepPending(home, stub.base)
  try {
    const started = Date.now()
    const result = await inProcess(['login'], { home, base: stub.base, loginWaitMs: 300 })
    assert.equal(result.code, 12, result.stderr)
    assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`)
    // The time left, not a time of day: the agent's clock may be in another time zone than the user.
    assert.match(result.stderr, /riffkit: No approval yet: after the user approves, run riffkit login again \(the link works for about 4 more minutes\)\.\n$/)
    neverShown(result)
    assert.equal(JSON.parse(fs.readFileSync(pendingFile(home, stub.base), 'utf8')).device_code, 'old-device-code')
  } finally {
    await stub.close()
  }
})

for (const [label, answer] of [
  ['answers 503', () => ({ status: 503, json: { detail: 'down' } })],
  ['drops the connection', () => 'reset'],
]) {
  test(`a kept sign-in whose poll ${label}: exit 5, and the link stays for the next run`, async () => {
    const stub = await codeStub({ 'old-device-code': answer })
    const home = tempDir()
    keepPending(home, stub.base)
    try {
      const result = await runCli(['login'], { home, base: stub.base })
      assert.equal(result.code, 5, result.stderr)
      assert.match(result.stderr, /did not answer the sign-in/)
      neverShown(result)
      assert.equal(authorizeCalls(stub), 0)
      assert.equal(JSON.parse(fs.readFileSync(pendingFile(home, stub.base), 'utf8')).device_code, 'old-device-code')
    } finally {
      await stub.close()
    }
  })
}

test('a kept sign-in the server says expired is replaced once; a replacement said to be expired too ends the run', async () => {
  const expired = () => ({ status: 400, json: { status: 'expired' } })
  const stub = await codeStub({ 'old-device-code': expired, 'device-code-secret': expired })
  const home = tempDir()
  keepPending(home, stub.base)
  try {
    const result = await inProcess(['login'], { home, base: stub.base })
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, /This sign-in has ended: the approval link is no longer valid\. Run riffkit login again\./)
    assert.equal(authorizeCalls(stub), 1)
    assert.deepEqual(polledCodes(stub), ['old-device-code', 'device-code-secret'])
    assert.equal(fs.existsSync(pendingFile(home, stub.base)), false)
  } finally {
    await stub.close()
  }
})

test('a pending path that can be neither read nor removed is named, and no sign-in starts', async () => {
  const stub = await codeStub({})
  const home = tempDir()
  fs.mkdirSync(pendingFile(home, stub.base), { recursive: true })
  try {
    const result = await runCli(['login'], { home, base: stub.base })
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, /^riffkit: Cannot use .*login-pending-127\.0\.0\.1-\d+: remove it, then run riffkit login again\.\n$/)
    assert.equal(authorizeCalls(stub), 0)
  } finally {
    await stub.close()
  }
})

test('--agent at a terminal: no browser, a bounded wait, and exit 12 naming the same command', async () => {
  const stub = await flowStub([pending], { started: TTY_STARTED })
  const home = tempDir()
  try {
    // An agent's shell may give the command a terminal: without --agent this run would wait for a person.
    const result = await inProcess(['login', '--agent'], { home, base: stub.base, tty: true, loginWaitMs: 300 })
    assert.equal(result.code, 12, result.stderr)
    assert.match(result.stderr, /Waiting up to \d+ seconds for the approval/)
    assert.match(result.stderr, /run riffkit login --agent again \(the link works for about 1 more minute\)\.\n$/)
    assert.ok(fs.existsSync(pendingFile(home, stub.base)))
  } finally {
    await stub.close()
  }
})

test('help starts by sending AI agents to the skill', async () => {
  const result = await atRiffkit(['help'], { RIFFKIT_NO_UPDATE_CHECK: '1' }, () => Response.json({ detail: 'Not Found' }, { status: 404 }))
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.split('\n')[0],
    'AI agents: read https://riffkit.ai/SKILL.md in full first (curl -fsSL https://riffkit.ai/SKILL.md); it says how to work with Riffkit.')
})

test('with RIFFKIT_BASE_URL, help sends AI agents to that server\'s skill', async () => {
  const stub = await startStub()
  try {
    const result = await runCli(['help'], { home: tempDir(), base: stub.base })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.split('\n')[0],
      `AI agents: read ${stub.base}/SKILL.md in full first (curl -fsSL ${stub.base}/SKILL.md); it says how to work with Riffkit.`)
  } finally {
    await stub.close()
  }
})

test('the pending sign-in file is named like the session file', async () => {
  const { siteFrom } = await import('../src/site.js')
  assert.equal(path.basename(siteFrom({ RIFFKIT_BASE_URL: 'https://riffkit.ai' }).pendingFile), 'login-pending')
  assert.equal(path.basename(siteFrom({ RIFFKIT_BASE_URL: 'http://localhost:8000' }).pendingFile), 'login-pending-localhost-8000')
})

test('help for the hand-written commands says what they print and how they end', async () => {
  const run = (args) => runCli(args, { home: tempDir() })
  const wait = await run(['help', 'wait'])
  assert.match(wait.stdout, /Exit 0/)
  assert.match(wait.stdout, /Exit 10/)
  assert.match(wait.stdout, /Exit 11/)
  const download = await run(['help', 'download'])
  assert.match(download.stdout, /--output/)
  assert.match(download.stdout, /\{asset_id, path, bytes\}/)
  const login = await run(['help', 'login'])
  assert.match(login.stdout, /exit 0, the account as JSON/)
  assert.match(login.stdout, /same link/)
})
