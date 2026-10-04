// Every command of the fixture command list becomes the request its route
// declares: path, query, JSON body, multipart form (files included).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { FIXTURE, SENTINEL, parseMultipart, runCli, startStub, tempDir } from './helpers.js'

let stub
let home
before(async () => {
  stub = await startStub()
  home = tempDir()
})
after(() => stub.close())

const SCALARS = new Set(['string', 'integer', 'number', 'boolean'])

/** Flags for one parameter and the value the request must then carry. */
function sample(param) {
  const flag = `--${param.name}`
  switch (param.type) {
    case 'integer': return { argv: [flag, '7'], value: 7 }
    case 'number': return { argv: [flag, '1.5'], value: 1.5 }
    case 'boolean': return { argv: [flag], value: true }
    case 'object': return { argv: [flag, '{"k":1}'], value: { k: 1 } }
    case 'file': {
      const file = path.join(home, `${param.name}.mp4`)
      fs.writeFileSync(file, `bytes of ${param.name}`)
      return { argv: [flag, file], file }
    }
    case 'array':
      if (SCALARS.has(param.items)) {
        const items = param.items === 'string' ? ['a1', 'a2'] : param.items === 'boolean' ? ['true', 'false'] : ['1', '2']
        return { argv: items.flatMap((item) => [flag, item]), value: items.map((item) => (param.items === 'string' ? item : JSON.parse(item))) }
      }
      return { argv: [flag, '[{"k":1}]'], value: [{ k: 1 }] }
    default: {
      const text = param.enum ? param.enum[0] : `v ${param.name} ü`
      return { argv: [flag, text], value: text }
    }
  }
}

const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

for (const command of FIXTURE.commands.filter((c) => !c.consumed_by)) {
  test(`${command.name} sends ${command.route}`, async () => {
    const [method, route] = command.route.split(' ')
    const names = [...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
    const positionals = names.map((name) => `id ${name}/x?`)
    const samples = command.params.filter((p) => p.in !== 'path').map((p) => ({ param: p, ...sample(p) }))
    const argv = [command.name, ...positionals, ...samples.flatMap((s) => s.argv)]
    if (command.effect === 'spend') argv.push('--yes')

    const seen = stub.requests.length
    const result = await runCli(argv, { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, '{"ok":true}\n')
    const sent = stub.api().filter((r) => stub.requests.indexOf(r) >= seen)
    assert.equal(sent.length, 1)
    const [request] = sent
    const url = new URL(request.url, stub.base)

    assert.equal(request.method, method)
    let expectedPath = route
    names.forEach((name, i) => { expectedPath = expectedPath.replace(`{${name}}`, encodeURIComponent(positionals[i])) })
    assert.equal(url.pathname, expectedPath)
    assert.equal(request.headers.cookie, `vee_session=${SENTINEL}`)
    assert.match(request.headers['user-agent'], /^riffkit-cli\/\d+\.\d+\.\d+ node\/v\d+\.\d+\.\d+ \(\w+ \w+\)$/)
    // English, as curl gets: the skill quotes the English refusals.
    assert.equal(request.headers['accept-language'], 'en')

    const byPlace = (place) => samples.filter((s) => s.param.in === place)
    assert.deepEqual([...new Set(url.searchParams.keys())].sort(), byPlace('query').map((s) => s.param.name).sort())
    for (const { param, value } of byPlace('query')) {
      assert.deepEqual(url.searchParams.getAll(param.name), (Array.isArray(value) && SCALARS.has(param.items) ? value : [value]).map(asText))
    }

    if (command.params.some((p) => p.in === 'json')) {
      assert.equal(request.headers['content-type'], 'application/json')
      assert.deepEqual(JSON.parse(request.body.toString('utf8')), Object.fromEntries(byPlace('json').map((s) => [s.param.name, s.value])))
    } else if (byPlace('form').length) {
      assert.equal(Number(request.headers['content-length']), request.body.length)
      const parts = parseMultipart(request)
      assert.deepEqual(parts.map((p) => p.name).sort(), byPlace('form').flatMap((s) => (Array.isArray(s.value) && SCALARS.has(s.param.items) ? s.value.map(() => s.param.name) : [s.param.name])).sort())
      for (const { param, value, file } of byPlace('form')) {
        const mine = parts.filter((p) => p.name === param.name)
        if (file) {
          assert.equal(mine[0].filename, path.basename(file))
          assert.equal(mine[0].type, 'video/mp4')
          assert.equal(mine[0].value.toString('utf8'), fs.readFileSync(file, 'utf8'))
        } else {
          assert.deepEqual(mine.map((p) => p.value.toString('utf8')), (Array.isArray(value) && SCALARS.has(param.items) ? value : [value]).map(asText))
        }
      }
    } else {
      assert.equal(request.body.length, 0)
    }
  })
}

test('a JSON route given no fields gets {} so the route names what is missing', async () => {
  const seen = stub.requests.length
  const result = await runCli(['create_product'], { home, base: stub.base, token: SENTINEL })
  assert.equal(result.code, 0, result.stderr)
  const [request] = stub.api().filter((r) => stub.requests.indexOf(r) >= seen)
  assert.equal(request.body.toString('utf8'), '{}')
})

test('kebab-case names, @file values and @@ text', async () => {
  const file = path.join(home, 'anchor.txt')
  fs.writeFileSync(file, 'Line one\nline two ü')
  const seen = stub.requests.length
  const result = await runCli(
    ['create-product', '--name', '@@handle', '--description', `@${file}`, '--target-audience=makers'],
    { home, base: stub.base, token: SENTINEL },
  )
  assert.equal(result.code, 0, result.stderr)
  const [request] = stub.api().filter((r) => stub.requests.indexOf(r) >= seen)
  assert.deepEqual(JSON.parse(request.body.toString('utf8')), { name: '@handle', description: 'Line one\nline two ü', target_audience: 'makers' })
})

test('a path argument starting with @ is the id itself, never a file read', async () => {
  fs.writeFileSync(path.join(home, 'notes.txt'), 'FILE-CONTENTS')
  const seen = stub.requests.length
  const result = await runCli(['get_task', '@notes.txt'], { home, base: stub.base, token: SENTINEL })
  assert.equal(result.code, 0, result.stderr)
  const [request] = stub.api().filter((r) => stub.requests.indexOf(r) >= seen)
  assert.equal(request.url, '/api/tasks/%40notes.txt')
  assert.ok(!JSON.stringify(request).includes('FILE-CONTENTS'))
})

test('text that is not a number is sent as it is, for the server to refuse', async () => {
  const seen = stub.requests.length
  const result = await runCli(['list_tasks', '--limit', 'ten', '--offset', '3'], { home, base: stub.base, token: SENTINEL })
  assert.equal(result.code, 0, result.stderr)
  const [request] = stub.api().filter((r) => stub.requests.indexOf(r) >= seen)
  const url = new URL(request.url, stub.base)
  assert.equal(url.searchParams.get('limit'), 'ten')
  assert.equal(url.searchParams.get('offset'), '3')
})

for (const [label, argv] of [
  ['an unknown flag', ['list_tasks', '--limitt', '5']],
  ['a flag given twice', ['list_tasks', '--limit', '5', '--limit', '6']],
  ['a missing path argument', ['get_batch']],
  ['an extra positional', ['get_batch', 'a', 'b']],
  ['a path argument of ..', ['get_batch', '..']],
  ['a flag without its value', ['list_tasks', '--status']],
  ['JSON text that is not JSON', ['save_subtitles', 'asset1', '--entities', 'not json']],
  ['an unreadable @file', ['create_product', '--name', '@/no/such/file']],
  ['a command the server does not list', ['make_me_a_video']],
  ['a command the CLI runs itself', ['device_token', '--device-code', 'x']],
]) {
  test(`${label} is a usage error and sends nothing`, async () => {
    const seen = stub.api().length
    const result = await runCli(argv, { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^riffkit: /)
    assert.equal(stub.api().length, seen)
  })
}

test('help lists the commands by effect, without the ones login and logout use', async () => {
  const result = await runCli(['help'], { home, base: stub.base })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Spend \(uses credits/)
  // Each command next to its route, so a route the skill names finds its command.
  assert.match(result.stdout, /\n {2}remake_video +POST \/api\/riffs +Remake a video/)
  assert.match(result.stdout, /\n {2}quote_remake +GET \/api\/riffs\/quote +Price a remake/)
  assert.doesNotMatch(result.stdout, /device_token|sign_out/)
  const one = await runCli(['help', 'remake-video'], { home, base: stub.base })
  assert.equal(one.code, 0, one.stderr)
  assert.match(one.stdout, /POST \/api\/riffs \(spend\)/)
  assert.match(one.stdout, /--formula_id/)
  assert.match(one.stdout, /--video \(a local file path\)/)
  const flag = await runCli(['remake_video', '--help'], { home, base: stub.base })
  assert.equal(flag.stdout, one.stdout)
})
