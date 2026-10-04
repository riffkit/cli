import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CliError, EXIT } from './errors.js'

const POSIX = process.platform !== 'win32'

/**
 * Write `text` to `file` so that no reader ever sees half of it and nobody but
 * the user can read it: directory 0700, file 0600, a temporary file moved
 * into place. With `exclusive`, a file already at `file` is kept as it is and
 * false comes back; otherwise (and when the text was written) true.
 */
export function writePrivate(file, text, { exclusive = false } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (POSIX) fs.chmodSync(dir, 0o700)   // a directory made earlier by hand may be wider
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
    if (!exclusive) {
      fs.renameSync(tmp, file)
      return true
    }
    // A hard link puts the whole file in place, or fails when one is there already.
    try {
      fs.linkSync(tmp, file)
    } catch (err) {
      if (err.code === 'EEXIST') return false
      fs.renameSync(tmp, file)   // a file system without hard links: written, though not exclusively
    }
    return true
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// What a session token looks like (the server mints URL-safe base64). Checked
// before the token goes into a header: an invalid header value makes fetch
// throw an error that quotes the value.
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,4096}$/

/**
 * True when this run's session is RIFFKIT_TOKEN. The variable holds a
 * riffkit.ai session, so it goes to riffkit.ai only: with RIFFKIT_BASE_URL
 * naming another site, that site's own session file is used.
 */
export const usesTokenVariable = (site, env) => site.isDefault && Boolean(env.RIFFKIT_TOKEN)

/** The session to send: RIFFKIT_TOKEN (riffkit.ai only), else the session file, else null. */
export function readToken(site, env) {
  if (usesTokenVariable(site, env)) return checked(env.RIFFKIT_TOKEN.trim(), 'RIFFKIT_TOKEN')
  let text
  try {
    text = fs.readFileSync(site.sessionFile, 'utf8').trim()
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new CliError(EXIT.SIGNED_OUT, `Cannot read ${site.sessionFile}: run riffkit login.`)
  }
  return text ? checked(text, site.sessionFile) : null
}

function checked(token, where) {
  if (!TOKEN.test(token)) {
    throw new CliError(EXIT.SIGNED_OUT, `${where} does not hold a Riffkit session: run riffkit login.`)
  }
  return token
}

export function storeToken(site, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new CliError(EXIT.REFUSED, 'Riffkit sent a session this CLI cannot use.')
  }
  writePrivate(site.sessionFile, token)
}

/** Remove the session file; true when there was one. */
export function forgetToken(site) {
  try {
    fs.unlinkSync(site.sessionFile)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}
