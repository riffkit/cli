// riffkit wait and riffkit download.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { POSIX, SENTINEL, runCli, startStub, tempDir } from './helpers.js'

const batch = (running, queued) => ({
  batch_id: 'b1', total: 2, completed: 2 - running - queued, failed: 0, running, queued, tasks: [],
})

test('wait returns the batch once nothing is queued or running', async () => {
  let n = 0
  const stub = await startStub({ handler: () => ({ json: n++ === 0 ? batch(1, 1) : batch(0, 0) }) })
  try {
    const result = await runCli(['wait', 'b1', '--timeout', '3'], { home: tempDir(), base: stub.base, token: SENTINEL })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), batch(0, 0))
    assert.match(result.stderr, /0 of 2 finished, 1 running, 1 queued/)
    assert.match(result.stderr, /Batch finished: 2 completed \(of 2\)/)
    assert.deepEqual(stub.api().map((r) => r.url), ['/api/tasks/batch/b1', '/api/tasks/batch/b1'])
  } finally {
    await stub.close()
  }
})

// A finished batch in which some task made no video: one that failed, was
// stopped or died, or an analysis that completed but never submitted its videos.
const settled = (tasks) => ({
  batch_id: 'b1', total: tasks.length, running: 0, queued: 0, tasks,
  completed: tasks.filter((t) => t.status === 'completed').length,
  failed: tasks.filter((t) => t.status === 'failed').length,
})
for (const [label, task, said] of [
  ['a failed task', { id: 't2', status: 'failed', result: null }, /task t2 failed/],
  ['a cancelled task', { id: 't2', status: 'cancelled', result: null }, /task t2 cancelled/],
  ['a dead task', { id: 't2', status: 'dead', result: null }, /task t2 dead/],
  ['an analysis that submitted no video', { id: 't2', status: 'completed', result: { auto_generate_error: 'insufficient_credits' } },
    /task t2 submitted no video \(auto_generate_error=insufficient_credits\)/],
]) {
  test(`wait on a batch with ${label} exits 11, the batch still on stdout`, async () => {
    const batch = settled([{ id: 't1', status: 'completed', result: { asset_id: 'a1' } }, task])
    const stub = await startStub({ handler: () => ({ json: batch }) })
    try {
      const result = await runCli(['wait', 'b1'], { home: tempDir(), base: stub.base, token: SENTINEL })
      assert.equal(result.code, 11)
      assert.deepEqual(JSON.parse(result.stdout), batch)
      assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr)
      assert.match(result.stderr, said)
      assert.doesNotMatch(result.stderr, /task t1/)
    } finally {
      await stub.close()
    }
  })
}

test('wait gives up at --timeout with exit 10 and the last state on stdout', async () => {
  const stub = await startStub({ handler: () => ({ json: batch(1, 0) }) })
  try {
    const result = await runCli(['wait', 'b1', '--timeout', '0.3'], { home: tempDir(), base: stub.base, token: SENTINEL })
    assert.equal(result.code, 10)
    assert.deepEqual(JSON.parse(result.stdout), batch(1, 0))
    assert.match(result.stderr, /riffkit wait b1 again/)
  } finally {
    await stub.close()
  }
})

test('wait on a batch that does not exist is a refusal', async () => {
  const stub = await startStub({ handler: () => ({ status: 404, json: { detail: 'Batch not found' } }) })
  try {
    const result = await runCli(['wait', 'nope'], { home: tempDir(), base: stub.base, token: SENTINEL })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Batch not found/)
  } finally {
    await stub.close()
  }
})

/** A Riffkit stub whose video link points at `files`, another origin (or is `url` itself). */
function linkStub(files, url = `${files.base}/data/tasks/t1/generated_video_sub.mp4?exp=1&sig=abc`) {
  return startStub({
    handler: () => ({ json: { url, expires_at: '2026-10-04T18:00:00', seconds_valid: 21600 } }),
  })
}

test('download saves the video, with no session on the file request', async () => {
  const files = await startStub({
    handler: (record) => (record.url.startsWith('/data/')
      ? { status: 302, headers: { Location: '/media/final.mp4' } }
      : { text: 'MP4-BYTES-'.repeat(1000) }),
  })
  const stub = await linkStub(files)
  const home = tempDir()
  try {
    const result = await runCli(['download', 'asset-1'], { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 0, result.stderr)
    const saved = JSON.parse(result.stdout)
    assert.equal(path.basename(saved.path), 'asset-1.mp4')
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'MP4-BYTES-'.repeat(1000))
    assert.equal(saved.bytes, 10000)
    assert.equal(stub.api()[0].headers.cookie, `vee_session=${SENTINEL}`)
    assert.deepEqual(files.requests.map((r) => r.url), ['/data/tasks/t1/generated_video_sub.mp4?exp=1&sig=abc', '/media/final.mp4'])
    for (const request of files.requests) assert.equal(request.headers.cookie, undefined)
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.part')), [])

    // An existing file is never replaced.
    const again = await runCli(['download', 'asset-1'], { home, base: stub.base, token: SENTINEL })
    assert.equal(again.code, 2)
    assert.match(again.stderr, /already exists/)
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'MP4-BYTES-'.repeat(1000))
  } finally {
    await stub.close()
    await files.close()
  }
})

test('download from a link on the base origin still carries no session', async () => {
  const stub = await startStub({
    handler: (record) => (record.url.startsWith('/api/')
      ? { json: { url: `${stubBase}/data/v.mp4?sig=1`, expires_at: 'x', seconds_valid: 1 } }
      : { text: 'VIDEO' }),
  })
  const stubBase = stub.base
  const home = tempDir()
  try {
    const result = await runCli(['download', 'a2', '-o', 'clip.mp4'], { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(fs.readFileSync(path.join(home, 'clip.mp4'), 'utf8'), 'VIDEO')
    const file = stub.requests.find((r) => r.url.startsWith('/data/'))
    assert.equal(file.headers.cookie, undefined)
  } finally {
    await stub.close()
  }
})

test('a failed download leaves no file behind', async () => {
  const files = await startStub({ handler: () => ({ status: 403, text: 'Signature no longer valid' }) })
  const stub = await linkStub(files)
  const home = tempDir()
  try {
    const result = await runCli(['download', 'asset-1'], { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /fresh link/)
    assert.deepEqual(fs.readdirSync(home).filter((f) => !f.startsWith('.')), [])
  } finally {
    await stub.close()
    await files.close()
  }
})

test('a video link that is not https is refused, and nothing is fetched', async () => {
  const stub = await linkStub(null, 'http://riffkit.example/data/tasks/t1/generated_video_sub.mp4?exp=1&sig=abc')
  const home = tempDir()
  try {
    const result = await runCli(['download', 'asset-1'], { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not https/)
    assert.deepEqual(fs.readdirSync(home).filter((f) => !f.startsWith('.')), [])
  } finally {
    await stub.close()
  }
})

// 0.0.0.0 reaches this machine, but is not one of the local names plain http is allowed for.
test('a link that redirects to plain http is not saved', { skip: !POSIX }, async () => {
  const files = await startStub({
    handler: (record) => (record.url.startsWith('/data/')
      ? { status: 302, headers: { Location: `http://0.0.0.0:${new URL(files.base).port}/media/final.mp4` } }
      : { text: 'SWAPPED-BYTES' }),
  })
  const stub = await linkStub(files)
  const home = tempDir()
  try {
    const result = await runCli(['download', 'asset-1'], { home, base: stub.base, token: SENTINEL })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /plain http/)
    assert.deepEqual(fs.readdirSync(home).filter((f) => !f.startsWith('.')), [])
  } finally {
    await stub.close()
    await files.close()
  }
})

test('a download cut off midway leaves nothing at the name, so running it again works', async () => {
  const half = 'MP4-BYTES-'.repeat(1000)
  let cut = true
  let sent
  const halfSent = new Promise((resolve) => { sent = resolve })
  const files = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(half.length * 2) })
    if (!cut) return res.end(half + half)
    res.write(half)   // and then nothing more, until the process is killed
    sent()
  })
  await new Promise((resolve) => files.listen(0, '127.0.0.1', resolve))
  const stub = await linkStub({ base: `http://127.0.0.1:${files.address().port}` })
  const home = tempDir()
  try {
    let child
    const first = runCli(['download', 'asset-1'], { home, base: stub.base, token: SENTINEL, onSpawn: (c) => { child = c } })
    await halfSent
    await sleep(300)   // the first half reaches the .part file
    child.kill('SIGKILL')
    await first
    assert.equal(fs.existsSync(path.join(home, 'asset-1.mp4')), false)

    cut = false
    const again = await runCli(['download', 'asset-1'], { home, base: stub.base, token: SENTINEL })
    assert.equal(again.code, 0, again.stderr)
    assert.equal(fs.readFileSync(path.join(home, 'asset-1.mp4'), 'utf8'), half + half)
  } finally {
    files.closeAllConnections()
    await new Promise((resolve) => files.close(resolve))
    await stub.close()
  }
})
