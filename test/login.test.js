// riffkit login / logout: the device authorization state machine, where the
// session is kept, and that it is never printed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIXTURE, POSIX, SENTINEL, runCli, startStub, tempDir } from './helpers.js'

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
    const result = await runCli(['login'], { home, base: stub.base })
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
    assert.equal((await runCli(['login'], { home, base: stub.base })).code, 0)
    assert.equal(fs.statSync(path.join(home, '.riffkit')).mode & 0o777, 0o700)
  } finally {
    await stub.close()
  }
})

test('a non-JSON 403 while polling is an error, not "still waiting"', async () => {
  const stub = await flowStub([pending, { status: 403, text: '<html>error code: 1010</html>' }, { json: { status: 'approved', token: SENTINEL } }])
  const home = tempDir()
  try {
    const result = await runCli(['login'], { home, base: stub.base })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /refused \(HTTP 403\)/)
    assert.equal(stub.api().filter((r) => r.url === '/api/skill/device/token').length, 2)
    assert.equal(fs.existsSync(sessionFile(home, stub.base)), false)
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
    const result = await runCli(['login'], { home, base: stub.base })
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
      const result = await runCli(['login'], { home, base: stub.base })
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
    const result = await runCli(['login'], { home, base: stub.base })
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
    const code = await main(argv, { stdout: out, stderr: err, stdin: null, env })
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
    const result = await runCli(['login'], { home, base: stub.base, env: { RIFFKIT_TOKEN: SENTINEL } })
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
