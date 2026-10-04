import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs, single } from '../args.js'
import { CliError, EXIT, usage } from '../errors.js'
import { USER_AGENT, secure } from '../site.js'
import { printJson, report } from '../request.js'

export default {
  usage: 'download <asset_id> [-o path]',
  summary: 'Save a finished video to a file (never replaces an existing file)',
  async run(ctx, argv) {
    const { positionals, flags } = parseArgs(argv, { output: 'value' }, { o: 'output' })
    if (positionals.length !== 1) throw usage(`Usage: riffkit ${this.usage}`)
    const [assetId] = positionals
    const getLink = await ctx.capability('get_video_link')
    const answer = await ctx.call(getLink, { asset_id: assetId }, ctx.token())
    if (answer.status !== 200) return report(ctx.io, getLink, answer)
    let link
    try {
      link = new URL(answer.body?.url)
    } catch {
      throw new CliError(EXIT.REFUSED, 'Riffkit sent no link for this video.')
    }
    // The link is a key to the video: it never crosses the network in clear.
    if (!secure(link)) throw new CliError(EXIT.REFUSED, 'Riffkit sent a video link that is not https. Nothing was downloaded.')

    const target = path.resolve(single(flags, 'output') ?? defaultName(assetId, link))
    const taken = () => usage(`${target} already exists. Choose another path with -o.`)
    // Asked now for an early answer; the save below never replaces a file either.
    if (fs.existsSync(target)) throw taken()
    const part = `${target}.${randomBytes(4).toString('hex')}.part`
    try {
      fs.writeFileSync(part, '', { flag: 'wx' })
    } catch {
      throw usage(`Cannot write ${target}.`)
    }
    try {
      // The link is its own key: no session goes with it, wherever it leads.
      const response = await fetch(link, { headers: { 'User-Agent': USER_AGENT } })
      if (!secure(new URL(response.url))) {
        throw new CliError(EXIT.REFUSED, 'The video link led to a plain http address. Nothing was saved.')
      }
      if (!response.ok || !response.body) {
        throw new CliError(
          response.status >= 500 ? EXIT.NO_ANSWER_READ : EXIT.REFUSED,
          `The video link answered HTTP ${response.status}. Run riffkit download ${assetId} again for a fresh link.`,
        )
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part))
      // A second name for the finished file, made only where none exists
      // (EEXIST otherwise): an existing file is never replaced, and a download
      // cut off midway leaves a .part file, never a file at the name itself.
      fs.linkSync(part, target)
    } catch (err) {
      if (err instanceof CliError) throw err
      if (err?.syscall === 'link') throw err.code === 'EEXIST' ? taken() : usage(`Cannot write ${target}.`)
      throw new CliError(EXIT.NO_ANSWER_READ, `The video did not finish downloading (${err?.cause?.code ?? err?.code ?? 'no connection'}). Run riffkit download ${assetId} again.`)
    } finally {
      fs.rmSync(part, { force: true })
    }
    const bytes = fs.statSync(target).size
    ctx.say(`Saved ${target} (${(bytes / 1e6).toFixed(1)} MB).`)
    printJson(ctx.io.stdout, { asset_id: assetId, path: target, bytes })
    return EXIT.OK
  },
}

/** "<asset_id>.mp4" in the current directory (the extension the link's file has). */
function defaultName(assetId, link) {
  const ext = path.extname(link.pathname)
  return `${assetId.replace(/[^A-Za-z0-9._-]/g, '_')}${/^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : '.mp4'}`
}
