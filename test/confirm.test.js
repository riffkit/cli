// At a terminal, a spend asks first. Run in-process, with stand-in terminal streams.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { main } from '../src/main.js'
import { SENTINEL, saveSession, startStub, tempDir } from './helpers.js'

let stub
before(async () => {
  stub = await startStub()
  const home = tempDir()
  process.env.HOME = home
  process.env.USERPROFILE = home
  saveSession(home, stub.base, SENTINEL)
})
after(() => stub.close())

async function atTerminal(argv, typed) {
  const out = { text: '', isTTY: false, write(chunk) { this.text += chunk } }
  const err = { text: '', isTTY: true, write(chunk) { this.text += chunk } }
  const stdin = Readable.from([typed])
  stdin.isTTY = true
  const code = await main(argv, { stdout: out, stderr: err, stdin, env: { RIFFKIT_BASE_URL: stub.base } })
  return { code, stdout: out.text, stderr: err.text }
}

const SPEND = ['remake-video', '--formula-id', 'f1', '--content-anchor', 'beach day, golden light']

test('the question shows the exact command line; yes sends it', async () => {
  const seen = stub.api().length
  const result = await atTerminal(SPEND, 'y\n')
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /riffkit remake-video --formula-id f1 --content-anchor "beach day, golden light"\nRun it\? \[y\/N\]/)
  assert.equal(stub.api().length, seen + 1)
  assert.equal(stub.api().at(-1).headers.cookie, `vee_session=${SENTINEL}`)
  assert.ok(!result.stderr.includes(SENTINEL))
})

for (const typed of ['n\n', '\n', 'sure\n', '']) {
  test(`answering ${JSON.stringify(typed)} sends nothing and exits 3`, async () => {
    const seen = stub.api().length
    const result = await atTerminal(SPEND, typed)
    assert.equal(result.code, 3)
    assert.equal(stub.api().length, seen)
  })
}
