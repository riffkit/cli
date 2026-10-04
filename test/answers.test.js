// What each answer turns into: the exit code table, stdout/stderr, and the
// session never showing up in either or going anywhere but the base origin.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { SENTINEL, runCli, startStub, tempDir } from './helpers.js'
import { readFileSync } from 'node:fs'

const MANIFEST = JSON.parse(readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'))

let stub
let other
let home
// What the stub answers next, per test.
let answer = () => ({ json: { ok: true } })
before(async () => {
  stub = await startStub({ handler: (record) => answer(record) })
  other = await startStub()
  home = tempDir()
})
after(async () => {
  await stub.close()
  await other.close()
})

const BODIES = {
  200: { json: { items: [], total: 0 } },
  400: { json: { detail: 'Bad source' } },
  401: { json: { detail: '请先登录' } },
  // Exactly what credit_service.insufficient_credits_detail sends: no message, internal units.
  402: { json: { detail: { error: 'insufficient_credits', required_credits: 150050, available_credits: 99999, topup_url: 'https://riffkit.ai/app/settings?tab=billing' } } },
  403: { text: '<html><body>Access denied</body></html>' },
  409: { json: { detail: 'Already running' } },
  422: { json: { detail: [{ loc: ['query', 'limit'], msg: 'Input should be a valid integer', type: 'int_parsing', input: 'ten' }] } },
  429: { json: { detail: '请求过于频繁，请稍后再试（60 秒内最多 60 次）', code: 'server_busy' } },
  500: { text: 'Internal Server Error' },
}

// [status, exit code for a read, for a write, for a spend]
const TABLE = [
  [200, 0, 0, 0],
  [400, 1, 1, 1],
  [401, 4, 4, 4],
  [402, 1, 1, 1],
  [403, 1, 1, 1],
  [409, 1, 1, 1],
  [422, 1, 1, 1],
  [429, 1, 1, 1],
  [500, 5, 6, 6],
  ['reset', 5, 6, 6],
]
const COMMANDS = {
  read: ['get_credits'],
  write: ['cancel_task', 'task-1'],
  spend: ['remake_video', '--formula-id', 'f1', '--mode', 'swap', '--yes'],
}

for (const [status, ...codes] of TABLE) {
  for (const [i, effect] of ['read', 'write', 'spend'].entries()) {
    test(`${status} to a ${effect} exits ${codes[i]}, and the session shows nowhere`, async () => {
      answer = () => (status === 'reset' ? 'reset' : { status, ...BODIES[status] })
      const result = await runCli(COMMANDS[effect], { home, base: stub.base, token: SENTINEL })
      assert.equal(result.code, codes[i], result.stderr)
      assert.ok(!result.stdout.includes(SENTINEL) && !result.stderr.includes(SENTINEL))
      if (status === 200) {
        assert.deepEqual(JSON.parse(result.stdout), BODIES[200].json)
        assert.equal(result.stderr, '')
        return
      }
      assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr)
      if (status === 'reset') {
        assert.equal(result.stdout, '')
      } else {
        const shown = JSON.parse(result.stdout)
        assert.equal(shown.status, status)
        if (BODIES[status].text) assert.equal(shown.text, BODIES[status].text)
        else assert.deepEqual({ ...shown, status: undefined }, { ...BODIES[status].json, status: undefined })
      }
      if (status === 401) assert.match(result.stderr, /riffkit login/)
      // No answer: Riffkit's own sentence for the effect, from the command list (manifest.no_answer).
      if (codes[i] === 5) assert.ok(result.stderr.includes(MANIFEST.no_answer.read), result.stderr)
      if (codes[i] === 6) assert.ok(result.stderr.includes(MANIFEST.no_answer.write), result.stderr)
      if (status === 402) assert.match(result.stderr, /refused \(HTTP 402\): insufficient_credits$/m)
      if (status === 422) assert.match(result.stderr, /invalid argument\(s\): limit/)
    })
  }
}

test('the session goes to the base origin as a cookie, the command list gets none', async () => {
  answer = () => ({ json: { ok: true } })
  const seen = stub.requests.length
  await runCli(['get_credits'], { home: tempDir(), base: stub.base, token: SENTINEL })
  const sent = stub.requests.slice(seen)
  assert.equal(sent.find((r) => r.url === '/cli.json').headers.cookie, undefined)
  assert.equal(sent.find((r) => r.url !== '/cli.json').headers.cookie, `vee_session=${SENTINEL}`)
})

test('a redirect is not followed: the session never reaches its target', async () => {
  answer = () => ({ status: 302, headers: { Location: `${other.base}/api/usage/credits` } })
  const result = await runCli(['get_credits'], { home, base: stub.base, token: SENTINEL })
  assert.equal(result.code, 5)
  assert.equal(other.requests.length, 0)
  const spend = await runCli(COMMANDS.spend, { home, base: stub.base, token: SENTINEL })
  assert.equal(spend.code, 6)
  assert.equal(other.requests.length, 0)
})

test('a spend without --yes and no terminal exits 3 and sends nothing at all', async () => {
  const quiet = await startStub({ cacheControl: 'max-age=60' })
  const fresh = tempDir()
  try {
    // A read first, so the command list is kept and fresh.
    assert.equal((await runCli(['get_credits'], { home: fresh, base: quiet.base, token: SENTINEL })).code, 0)
    const before = quiet.requests.length
    for (const argv of [['remake_video', '--formula-id', 'f1'], ['retry-task', 'task-1'], ['add_ratios', '--yes', 'false']]) {
      const result = await runCli(argv, { home: fresh, base: quiet.base, token: SENTINEL })
      assert.equal(result.code, 3, result.stderr)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /--yes.*price.*go-ahead/)
    }
    assert.equal(quiet.requests.length, before)
  } finally {
    await quiet.close()
  }
})

test('no session at all: the call goes without a cookie and 401 says to log in', async () => {
  answer = (record) => (record.headers.cookie ? { json: { ok: true } } : { status: 401, ...BODIES[401] })
  const result = await runCli(['get_credits'], { home: tempDir(), base: stub.base })
  assert.equal(result.code, 4)
  assert.match(result.stderr, /run riffkit login/)
})

test('a structured refusal with no sentence is named by its code', async () => {
  answer = () => ({ status: 403, json: { detail: { code: 'subscription_required', plan: 'lite' } } })
  const result = await runCli(['get_credits'], { home, base: stub.base, token: SENTINEL })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /refused \(HTTP 403\): subscription_required$/m)
})

test('RIFFKIT_TOKEN is the riffkit.ai session: another site never gets it', async () => {
  answer = (record) => (record.headers.cookie ? { json: { ok: true } } : { status: 401, ...BODIES[401] })
  const seen = stub.requests.length
  const result = await runCli(['get_credits'], { home: tempDir(), base: stub.base, env: { RIFFKIT_TOKEN: SENTINEL } })
  assert.equal(result.code, 4)
  for (const request of stub.requests.slice(seen)) assert.ok(!JSON.stringify(request.headers).includes(SENTINEL))
})

test('an unusable saved session is refused before sending, without being shown', async () => {
  const bad = `${SENTINEL}\r\nX-Evil: 1`
  const seen = stub.api().length
  const result = await runCli(['get_credits'], { home, base: stub.base, token: bad })
  assert.equal(result.code, 4)
  assert.ok(!result.stderr.includes(SENTINEL) && !result.stdout.includes(SENTINEL))
  assert.equal(stub.api().length, seen)
})

test('plain http is refused for anything but localhost', async () => {
  const result = await runCli(['get_credits'], { home, base: 'http://riffkit.example' })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /https/)
})
