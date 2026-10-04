// The daily "a newer CLI is out" line: stderr only, once a day at most, silent
// when the registry does not answer, never sent the session.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { newer } from '../src/update.js'
import { VERSION } from '../src/site.js'
import { SENTINEL, runCli, startStub, tempDir } from './helpers.js'

let registry
let answer = () => ({ json: { version: '9.9.9' } })
before(async () => {
  registry = await startStub({ handler: () => answer() })
})
after(async () => {
  await registry.close()
})

// The check on, aimed at the stub registry; CI cleared (GitHub Actions sets it).
const on = () => ({ RIFFKIT_NO_UPDATE_CHECK: '', CI: '', RIFFKIT_UPDATE_URL: `${registry.base}/latest` })
const asked = () => registry.requests.filter((r) => r.url === '/latest').length

test('newer compares released versions only', () => {
  assert.equal(newer('0.1.1', '0.1.0'), true)
  assert.equal(newer('1.0.0', '0.9.9'), true)
  assert.equal(newer('0.10.0', '0.9.0'), true)
  assert.equal(newer('0.1.0', '0.1.0'), false)
  assert.equal(newer('0.0.9', '0.1.0'), false)
  assert.equal(newer('0.2.0-beta.1', '0.1.0'), false)
  assert.equal(newer('nonsense', '0.1.0'), false)
})

test('a newer version is named on stderr after the output, and asked once a day', async () => {
  answer = () => ({ json: { version: '9.9.9' } })
  const home = tempDir()
  const before = asked()
  const first = await runCli(['--version'], { home, token: SENTINEL, env: on() })
  assert.equal(first.code, 0)
  assert.equal(first.stdout, `${VERSION}\n`)
  assert.match(first.stderr, /version 9\.9\.9 is out \(this is .*\)\. Update with: npm i -g @riffkit\/cli@latest/)
  assert.equal(asked(), before + 1)
  const ask = registry.requests.filter((r) => r.url === '/latest').at(-1)
  assert.equal(ask.headers.cookie, undefined)
  assert.ok(!JSON.stringify(ask.headers).includes(SENTINEL))
  // Within the day: the kept answer, no second request.
  const second = await runCli(['--version'], { home, token: SENTINEL, env: on() })
  assert.match(second.stderr, /version 9\.9\.9 is out/)
  assert.equal(asked(), before + 1)
})

test('the same version says nothing', async () => {
  answer = () => ({ json: { version: VERSION } })
  const result = await runCli(['--version'], { home: tempDir(), env: on() })
  assert.equal(result.stderr, '')
})

test('no answer from the registry is silent and does not change the exit code', async () => {
  for (const reply of [() => ({ status: 500, text: 'down' }), () => 'reset', () => ({ text: 'not json' })]) {
    answer = reply
    const result = await runCli(['--version'], { home: tempDir(), env: on() })
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
  }
})

test('RIFFKIT_NO_UPDATE_CHECK and CI turn it off: nothing is asked', async () => {
  answer = () => ({ json: { version: '9.9.9' } })
  const before = asked()
  const off = await runCli(['--version'], { home: tempDir(), env: { ...on(), RIFFKIT_NO_UPDATE_CHECK: '1' } })
  const ci = await runCli(['--version'], { home: tempDir(), env: { ...on(), CI: 'true' } })
  assert.equal(off.stderr + ci.stderr, '')
  assert.equal(asked(), before)
})
