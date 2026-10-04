import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { usage } from './errors.js'

export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

const DEFAULT_BASE = 'https://riffkit.ai'
// Plain http only where nothing leaves the machine.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True when what goes to a URL never crosses the network in clear: https, or plain http to this machine. */
export const secure = (url) => url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))

/**
 * The server this run talks to and the files kept for it. The default site uses
 * ~/.riffkit/session, the file the agent skill writes too; any other site gets
 * its own session file, so a local server never sees the riffkit.ai session.
 */
export function siteFrom(env) {
  const raw = env.RIFFKIT_BASE_URL || DEFAULT_BASE
  let url
  try {
    url = new URL(raw)
  } catch {
    throw usage(`RIFFKIT_BASE_URL is not a URL: ${raw}`)
  }
  if (!secure(url)) {
    throw usage('RIFFKIT_BASE_URL must start with https:// (plain http only for localhost).')
  }
  const base = url.origin
  const isDefault = base === DEFAULT_BASE
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const key = isDefault ? url.hostname : `${url.hostname.replace(/[^A-Za-z0-9.-]/g, '_')}-${port}`
  const dir = path.join(os.homedir(), '.riffkit')
  return {
    base,
    isDefault,
    dir,
    sessionFile: path.join(dir, isDefault ? 'session' : `session-${key}`),
    // A sign-in started and not approved yet: the next riffkit login waits for that same link.
    pendingFile: path.join(dir, isDefault ? 'login-pending' : `login-pending-${key}`),
    manifestFile: path.join(dir, `cli-manifest-${key}.json`),
  }
}

export const USER_AGENT = `riffkit-cli/${VERSION} node/${process.version} (${process.platform} ${process.arch})`
