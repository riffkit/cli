import fs from 'node:fs'
import { CliError, EXIT, usage } from './errors.js'
import { writePrivate } from './files.js'
import { USER_AGENT, VERSION } from './site.js'

// The command list's shape this CLI reads. The server raises it only when an
// older CLI would misread the list; then the user has to update.
export const SCHEMA = 1
const PLACES = new Set(['path', 'query', 'json', 'form'])

/**
 * The command list the server publishes at /cli.json: every capability an agent
 * may call, with its route and parameters. A new capability on the server is a
 * new command here without a new release of this package.
 *
 * Kept in ~/.riffkit/cli-manifest-<site>.json with its ETag and revalidated with
 * If-None-Match (for as long as the server's Cache-Control max-age says, not at
 * all). With no answer from the server the kept list is used.
 */
export async function loadManifest(site) {
  const kept = readKept(site.manifestFile)
  if (kept && Date.now() - kept.fetchedAt < kept.maxAge * 1000) return checked(kept.manifest, site)

  let response
  try {
    response = await fetch(`${site.base}/cli.json`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(kept?.etag ? { 'If-None-Match': kept.etag } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    if (kept) return checked(kept.manifest, site)
    throw new CliError(EXIT.NO_ANSWER_READ, `Could not reach ${site.base} for the list of commands. Try again in a moment.`)
  }
  // Best effort: a home directory that cannot be written only costs the next run a download.
  const keep = (manifest, etag) => {
    try {
      writePrivate(site.manifestFile, JSON.stringify({
        etag,
        fetchedAt: Date.now(),
        maxAge: maxAge(response.headers.get('cache-control')),
        manifest,
      }))
    } catch {
      // not kept
    }
  }
  if (response.status === 304 && kept) {
    keep(kept.manifest, response.headers.get('etag') ?? kept.etag)
    return checked(kept.manifest, site)
  }
  let manifest
  try {
    if (response.status !== 200) throw new Error()
    manifest = await response.json()
  } catch {
    if (kept) return checked(kept.manifest, site)
    throw new CliError(EXIT.NO_ANSWER_READ, `${site.base} did not send its list of commands (HTTP ${response.status}). Try again in a moment.`)
  }
  checked(manifest, site)
  keep(manifest, response.headers.get('etag'))
  return manifest
}

function readKept(file) {
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'))
    return kept && typeof kept.fetchedAt === 'number' && wellFormed(kept.manifest) ? kept : null
  } catch {
    return null
  }
}

function maxAge(cacheControl) {
  if (!cacheControl || /no-cache|no-store/i.test(cacheControl)) return 0
  const match = /max-age=(\d+)/i.exec(cacheControl)
  return match ? Number(match[1]) : 0
}

function wellFormed(manifest) {
  return Boolean(manifest) && Number.isInteger(manifest.schema) && Array.isArray(manifest.commands) &&
    typeof manifest.no_answer?.read === 'string' && typeof manifest.no_answer?.write === 'string'
}

function checked(manifest, site) {
  if (!wellFormed(manifest)) {
    throw new CliError(EXIT.NO_ANSWER_READ, `${site.base} sent a list of commands this CLI cannot read.`)
  }
  if (manifest.schema > SCHEMA) {
    throw usage(
      `This riffkit (${VERSION}) is too old for the commands ${site.base} offers now. ` +
      'Update it: npm i -g @riffkit/cli@latest',
    )
  }
  // What a command says when it gets no answer: Riffkit's own words, the ones
  // its connector uses (manifest `no_answer`), by the command's effect.
  for (const command of manifest.commands) {
    command.noAnswer = manifest.no_answer[command.effect === 'read' ? 'read' : 'write']
  }
  return manifest
}

/** "remake-video" and "remake_video" are the same name. */
export const normalise = (name) => name.replaceAll('-', '_')

export function findCommand(manifest, name) {
  const wanted = normalise(name)
  return manifest.commands.find((command) => command.name === wanted) ?? null
}

/** A capability a hand-written command relies on. */
export function capability(manifest, name, site) {
  const command = findCommand(manifest, name)
  if (!command) {
    throw usage(`${site.base} does not offer ${name}. Update riffkit: npm i -g @riffkit/cli@latest`)
  }
  return command
}

/** Method, path and the parameters of a command, refusing what this CLI would
 *  send somewhere it should not. */
export function routeOf(command) {
  const [method, path] = String(command.route).split(' ')
  const params = Array.isArray(command.params) ? command.params : []
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || typeof path !== 'string' || params.some((p) => !PLACES.has(p?.in))) {
    throw usage(`The list of commands describes ${command.name} in a way this CLI cannot send. Update riffkit: npm i -g @riffkit/cli@latest`)
  }
  return { method, path, params }
}
