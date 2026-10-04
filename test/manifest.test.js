// The command list: kept with its ETag, used offline, refused when it is newer
// than this CLI understands or names a route outside the API.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIXTURE, ROOT, SENTINEL, runCli, startStub, tempDir } from './helpers.js'

const keptFile = (home, base) => path.join(home, '.riffkit', `cli-manifest-127.0.0.1-${new URL(base).port}.json`)

test('the list is kept with its ETag, revalidated with If-None-Match, and used offline', async () => {
  const stub = await startStub()
  const home = tempDir()
  const first = await runCli(['help'], { home, base: stub.base })
  assert.equal(first.code, 0, first.stderr)
  assert.equal(stub.requests[0].headers['if-none-match'], undefined)
  assert.equal(JSON.parse(fs.readFileSync(keptFile(home, stub.base), 'utf8')).etag, '"m1"')

  const second = await runCli(['help'], { home, base: stub.base })
  assert.equal(second.code, 0, second.stderr)
  assert.equal(stub.requests[1].headers['if-none-match'], '"m1"')
  assert.equal(second.stdout, first.stdout)

  const base = stub.base
  await stub.close()
  const offline = await runCli(['help'], { home, base })
  assert.equal(offline.code, 0, offline.stderr)
  assert.equal(offline.stdout, first.stdout)
})

test('a 304 renews the kept list for the max-age it carries', async () => {
  const stub = await startStub({ cacheControl: 'public, max-age=60' })
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.riffkit'))
  fs.writeFileSync(keptFile(home, stub.base), JSON.stringify({ etag: '"m1"', fetchedAt: 0, maxAge: 60, manifest: FIXTURE }))
  try {
    assert.equal((await runCli(['help'], { home, base: stub.base })).code, 0)
    assert.equal(stub.requests.length, 1)
    assert.equal(stub.requests[0].headers['if-none-match'], '"m1"')
    // Fresh again for 60 seconds: the next run asks nothing.
    assert.equal((await runCli(['help'], { home, base: stub.base })).code, 0)
    assert.equal(stub.requests.length, 1)
  } finally {
    await stub.close()
  }
})

test('within the server\'s max-age the kept list is used without asking', async () => {
  const stub = await startStub({ cacheControl: 'public, max-age=300' })
  const home = tempDir()
  await runCli(['help'], { home, base: stub.base })
  await runCli(['help'], { home, base: stub.base })
  assert.equal(stub.requests.length, 1)
  await stub.close()
})

test('no list and no server: exit 5', async () => {
  const stub = await startStub()
  const base = stub.base
  await stub.close()
  const result = await runCli(['get_credits'], { home: tempDir(), base })
  assert.equal(result.code, 5)
  assert.match(result.stderr, /Could not reach/)
})

test('a list newer than this CLI: update it, exit 2', async () => {
  const stub = await startStub({ manifest: { ...FIXTURE, schema: 2 } })
  try {
    const result = await runCli(['get_credits'], { home: tempDir(), base: stub.base, token: SENTINEL })
    assert.equal(result.code, 2)
    assert.match(result.stderr, /npm i -g @riffkit\/cli@latest/)
    assert.equal(stub.api().length, 0)
  } finally {
    await stub.close()
  }
})

test('a route outside /api/ is refused, and the session goes nowhere', async () => {
  const commands = [
    { name: 'read_file', route: 'GET /data/tasks/{task_id}/out.json', effect: 'read', title: 'x', description: 'x', consumed_by: null, params: [{ name: 'task_id', in: 'path', type: 'string', items: null, required: true, description: '', enum: null, default: null }] },
    { name: 'escape', route: 'GET //evil.example/api/x', effect: 'read', title: 'x', description: 'x', consumed_by: null, params: [] },
    // Inside /api/ as written, outside once the URL resolves the dot segments.
    ...['/api/../data/tasks/x', '/api/%2e%2e/cli.json', '/api/%2E%2E/x', '/api/.%2e/x', '/api/..\\x'].map((route, i) => (
      { name: `dots_${i}`, route: `GET ${route}`, effect: 'read', title: 'x', description: 'x', consumed_by: null, params: [] })),
  ]
  const stub = await startStub({ manifest: { ...FIXTURE, commands: [...FIXTURE.commands, ...commands] } })
  try {
    for (const argv of [['read_file', 't1'], ['escape'], ...[0, 1, 2, 3, 4].map((i) => [`dots_${i}`])]) {
      const result = await runCli(argv, { home: tempDir(), base: stub.base, token: SENTINEL })
      assert.equal(result.code, 2)
      assert.match(result.stderr, /outside the Riffkit API/)
    }
    assert.equal(stub.api().length, 0)
  } finally {
    await stub.close()
  }
})

// test/fixtures/manifest.json stands in for the list Riffkit serves (the app's
// api/cli_commands.generated.json). Given the app's checkout, this holds the two
// equal, so the request tests above run against what is actually served.
test('the fixture is the command list the app serves, byte for byte', {
  skip: !process.env.RIFFKIT_APP_ROOT && 'set RIFFKIT_APP_ROOT to an app checkout to compare',
}, () => {
  const served = fs.readFileSync(path.join(process.env.RIFFKIT_APP_ROOT, 'api', 'cli_commands.generated.json'))
  assert.ok(served.equals(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'manifest.json'))),
    'Replace test/fixtures/manifest.json with the app\'s api/cli_commands.generated.json.')
})
