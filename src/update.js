import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { USER_AGENT, VERSION } from './site.js'

// Where the newest published version is read: npm's registry. Never sent the session.
const LATEST_URL = 'https://registry.npmjs.org/@riffkit/cli/latest'
const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 1500

/** "1.2.3" as numbers; anything else (a pre-release, nonsense) is null. */
function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version))
  return match ? match.slice(1).map(Number) : null
}

/** Whether `latest` is a later release than `current`. */
export function newer(latest, current) {
  const a = parts(latest)
  const b = parts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/**
 * One line on stderr when npm has a newer @riffkit/cli than this one. The
 * commands themselves need no update (they come from Riffkit's list); this is
 * for the CLI's own code. Asked at most once a day (~/.riffkit/cli-update.json,
 * even when the answer did not come), never for longer than 1.5 seconds, silent
 * on any failure, and never installs anything. Off with
 * RIFFKIT_NO_UPDATE_CHECK=1, and in CI.
 */
export async function updateNotice(env, stderr, now = Date.now()) {
  if (env.RIFFKIT_NO_UPDATE_CHECK || env.CI) return
  const dir = path.join(os.homedir(), '.riffkit')
  const file = path.join(dir, 'cli-update.json')
  let kept = {}
  try {
    kept = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}
  } catch {}
  let latest = typeof kept.latest === 'string' ? kept.latest : null
  if (!(Number.isFinite(kept.checked_at) && now - kept.checked_at >= 0 && now - kept.checked_at < DAY_MS)) {
    try {
      const answer = await fetch(env.RIFFKIT_UPDATE_URL || LATEST_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (answer.ok) {
        const version = (await answer.json())?.version
        if (typeof version === 'string') latest = version
      }
    } catch {}
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify({ checked_at: now, latest }))
    } catch {}
  }
  if (latest && newer(latest, VERSION)) {
    stderr.write(`riffkit: version ${latest} is out (this is ${VERSION}). Update with: npm i -g @riffkit/cli@latest\n`)
  }
}
