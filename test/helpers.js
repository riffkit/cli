// Shared by the tests: a stub Riffkit server and a way to run the CLI against it.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteFrom } from '../src/site.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'riffkit.js')
export const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'manifest.json'), 'utf8'))

// A fake session. No test may ever see it on stdout or stderr.
export const SENTINEL = 'rk-sentinel-TOKEN-4f9c2b7e1d3a-never-printed'

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'riffkit-cli-test-'))
}

/**
 * A server standing in for Riffkit. /cli.json serves `manifest` with an ETag
 * (304 on a matching If-None-Match); every other request goes to `handler`,
 * which returns { status, json | text, headers }, or 'reset' to drop the
 * connection without an answer. Every request is recorded.
 */
export async function startStub({ manifest = FIXTURE, etag = '"m1"', cacheControl, handler } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
    requests.push(record)
    if (req.url === '/cli.json') {
      const headers = { 'Content-Type': 'application/json', ETag: etag, ...(cacheControl ? { 'Cache-Control': cacheControl } : {}) }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end()
      } else {
        res.writeHead(200, headers).end(JSON.stringify(manifest))
      }
      return
    }
    const answer = (handler && (await handler(record))) ?? { json: { ok: true } }
    if (answer === 'reset') {
      req.socket.destroy()
      return
    }
    const body = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.text ?? '')
    res.writeHead(answer.status ?? 200, {
      'Content-Type': answer.json !== undefined ? 'application/json' : 'text/html',
      ...answer.headers,
    }).end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    requests,
    api: () => requests.filter((r) => r.url !== '/cli.json'),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

/** Keep `token` as the saved session for `base` in `home`, the file the CLI reads for that site. */
export function saveSession(home, base, token) {
  const file = path.join(home, '.riffkit', path.basename(siteFrom({ RIFFKIT_BASE_URL: base }).sessionFile))
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, token, { mode: 0o600 })
  return file
}

/**
 * Run `riffkit ...args` in a child process; resolves { code, stdout, stderr }.
 * `token` is saved as the stub's session first (RIFFKIT_TOKEN goes to
 * riffkit.ai only); `onSpawn` gets the child process.
 */
export function runCli(args, { home, base, token, env = {}, cwd, onSpawn } = {}) {
  const childEnv = { ...process.env }
  for (const key of Object.keys(childEnv)) if (key.startsWith('RIFFKIT_')) delete childEnv[key]
  // The daily update check is off unless a test sets it up (test/update.test.js).
  Object.assign(childEnv, { HOME: home, USERPROFILE: home, RIFFKIT_BASE_URL: base, RIFFKIT_NO_UPDATE_CHECK: '1' }, env)
  if (token) saveSession(home, base, token)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, cwd: cwd ?? home, stdio: ['pipe', 'pipe', 'pipe'] })
    onSpawn?.(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end()
  })
}

/** The parts of a multipart/form-data body: [{ name, filename, type, value: Buffer }]. */
export function parseMultipart(record) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(record.headers['content-type'] ?? '')
  if (!match) throw new Error('not multipart')
  const delimiter = Buffer.from(`--${match[1] ?? match[2]}`)
  const parts = []
  let start = record.body.indexOf(delimiter)
  for (;;) {
    const next = record.body.indexOf(delimiter, start + delimiter.length)
    if (next === -1) break
    const chunk = record.body.subarray(start + delimiter.length + 2, next - 2)   // past "\r\n", before "\r\n"
    const split = chunk.indexOf('\r\n\r\n')
    const head = chunk.subarray(0, split).toString('utf8')
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1],
      filename: /filename="([^"]*)"/.exec(head)?.[1],
      type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1],
      value: chunk.subarray(split + 4),
    })
    start = next
  }
  return parts
}

export const POSIX = process.platform !== 'win32'
