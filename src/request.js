import fs from 'node:fs'
import path from 'node:path'
import { repeatable } from './args.js'
import { CliError, EXIT, usage } from './errors.js'
import { routeOf } from './manifest.js'
import { USER_AGENT } from './site.js'

// The only routes this CLI calls. A command list naming anything else (a page,
// a file under /data) is refused rather than sent the session.
const API_PREFIX = '/api/'

// Refusals come back in English, as they do to curl: the agent skill's error
// table quotes the English words.
const LANGUAGE = 'en'

// Content types for the files a route takes (videos, audio, images). Anything
// else goes as application/octet-stream and the route decides.
const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}

/** A query value or a form field: text as it is, anything else as its JSON text. */
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

/**
 * The request a command stands for, built from its route alone: path
 * parameters into the path (each segment encoded), query parameters into the
 * query, JSON fields into a JSON body ({} when none is given, so the route
 * names what is missing), form fields and files into a multipart body. Values
 * are not validated here: the route answers 422 for what it refuses.
 */
export async function buildRequest(site, command, args, token) {
  const { method, path: route, params } = routeOf(command)
  const outside = () => usage(`The list of commands sends ${command.name} outside the Riffkit API (${route}). Refused.`)
  // A dot segment ("..", "%2e%2e") would be resolved away, out of /api/.
  if (!route.startsWith(API_PREFIX) || /\.\.|%2e/i.test(route)) throw outside()
  const pathname = route.replace(/\{([^}]+)\}/g, (_, name) => {
    const segment = String(args[name] ?? '')
    // "." and ".." would be resolved away and land on another route.
    if (['', '.', '..'].includes(segment)) throw usage(`<${name}> cannot be "${segment}".`)
    return encodeURIComponent(segment)
  })
  const query = new URLSearchParams()
  const json = {}
  const form = new FormData()
  let takesJson = false
  let hasForm = false
  for (const param of params) {
    if (param.in === 'json') takesJson = true
    const value = args[param.name]
    if (param.in === 'path' || value === undefined) continue
    const items = repeatable(param) ? value : [value]
    if (param.in === 'json') {
      json[param.name] = value
    } else if (param.in === 'query') {
      for (const item of items) query.append(param.name, asText(item))
    } else {
      hasForm = true
      for (const item of items) {
        if (param.type === 'file') form.append(param.name, await fileBlob(item), path.basename(item))
        else form.append(param.name, asText(item))
      }
    }
  }

  const search = query.toString()
  const url = new URL(pathname + (search ? `?${search}` : ''), site.base)
  // The session goes to the site it was issued by, and nowhere else.
  if (url.origin !== site.base) throw usage(`Refusing to send ${command.name} to ${url.origin}.`)
  // Checked again on the path as it is sent, after the URL resolved it.
  if (!url.pathname.startsWith(API_PREFIX)) throw outside()
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Accept-Language': LANGUAGE,
    ...(token ? { Cookie: `vee_session=${token}` } : {}),
  }
  let body
  if (takesJson) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  } else if (hasForm) {
    body = form   // fetch writes the multipart boundary and, every size being known, Content-Length
  }
  return { url, init: { method, headers, body, redirect: 'manual' } }
}

/** A local file for a multipart field, read from disk as it is sent. */
async function fileBlob(file) {
  try {
    return await fs.openAsBlob(file, { type: MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
  } catch {
    throw usage(`Cannot read the file ${file}.`)
  }
}

/** Raised when no HTTP answer came back at all. */
export class NoAnswer extends Error {}

/**
 * Send a built request. Redirects are never followed: no API route answers
 * with one on purpose, and following it could carry the session elsewhere.
 * Returns { status, headers, text, body } (body: the parsed JSON, or undefined).
 */
export async function send({ url, init }) {
  let response
  let text
  try {
    response = await fetch(url, init)
    text = await response.text()
  } catch (err) {
    throw new NoAnswer(err?.cause?.code ?? err?.code ?? 'no connection')
  }
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: response.status, headers: response.headers, text, body }
}

/** Build and send one capability call. */
export async function call(site, command, args, token) {
  return send(await buildRequest(site, command, args, token))
}

/** One readable line for a refusal: the server's own words when it gave some. */
export function reasonOf(answer) {
  const detail = answer.body?.detail
  let reason
  if (typeof detail === 'string') reason = detail
  else if (typeof detail?.message === 'string') reason = detail.message
  else if (Array.isArray(detail)) {
    // FastAPI's validation errors: name the arguments, loc = ["body" | "query" | "path", name, ...].
    const fields = [...new Set(detail.map((e) => (Array.isArray(e?.loc) ? e.loc.slice(1).join('.') : '')).filter(Boolean))]
    reason = fields.length ? `invalid argument(s): ${fields.join(', ')}` : 'invalid arguments'
  } else if (codeOf(detail)) reason = codeOf(detail)
  else if (typeof answer.body?.message === 'string') reason = answer.body.message
  else reason = `HTTP ${answer.status}`
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * A structured refusal that carries no sentence: its code. The amounts it
 * carries (a balance shortfall's) are in the JSON on stdout, as Riffkit sent
 * them; the CLI does no arithmetic of its own on them.
 */
function codeOf(detail) {
  const code = detail?.error ?? detail?.code
  return typeof code === 'string' ? code : undefined
}

/** stdout: compact JSON for a program, indented for a person at a terminal. */
export function printJson(stream, value) {
  stream.write(`${stream.isTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`)
}

/** No answer to a call: Riffkit's own sentence for the command's effect (it
 *  arrives in /cli.json, see manifest.js), with the command and the cause. */
export function noAnswerError(command, reason) {
  const code = command.effect === 'read' ? EXIT.NO_ANSWER_READ : EXIT.NO_ANSWER_WRITE
  return new CliError(code, `${command.name}: ${command.noAnswer} (${reason})`)
}

/**
 * Print a capability's answer the way every command does: the body on stdout
 * (on a refusal, with the HTTP status in it). Returns EXIT.OK for a success and
 * throws the CliError (one line for stderr, its exit code) for anything else.
 */
export function report(io, command, answer) {
  const { status, body, text } = answer
  if (status >= 200 && status < 300) {
    if (body !== undefined) printJson(io.stdout, body)
    else if (text) printJson(io.stdout, { status, text })
    return EXIT.OK
  }
  let shown
  if (body && typeof body === 'object' && !Array.isArray(body)) shown = Object.assign({ status }, body, { status })
  else if (body !== undefined) shown = { status, body }
  else shown = { status, text }
  printJson(io.stdout, shown)
  if (status === 401) {
    throw new CliError(EXIT.SIGNED_OUT, 'Not signed in, or the session has ended: run riffkit login.')
  }
  if (status >= 400 && status < 500) {
    throw new CliError(EXIT.REFUSED, `${command.name} was refused (HTTP ${status}): ${reasonOf(answer)}`)
  }
  throw noAnswerError(command, `HTTP ${status}`)
}
