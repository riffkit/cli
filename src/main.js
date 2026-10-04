import { createInterface } from 'node:readline'
import { commandArguments } from './args.js'
import { CliError, EXIT, usage } from './errors.js'
import { readToken } from './files.js'
import { capability, findCommand, loadManifest, normalise } from './manifest.js'
import download from './own/download.js'
import help from './own/help.js'
import login from './own/login.js'
import logout from './own/logout.js'
import wait from './own/wait.js'
import { NoAnswer, call, noAnswerError, report } from './request.js'
import { VERSION, siteFrom } from './site.js'
import { updateNotice } from './update.js'

// Commands written here rather than listed by the server. Each calls
// capabilities by name, through the same request builder.
export const own = { login, logout, wait, download, help }

const USAGE = 'Usage: riffkit <command> [arguments] [--option value ...]. riffkit help lists the commands.'

/** Run one command line; returns the exit code. Nothing it prints holds the session token. */
export async function main(argv, io) {
  let code
  try {
    code = await run(argv, io)
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`riffkit: ${err.message}\n`)
      code = err.code
    } else {
      io.stderr.write(`riffkit: unexpected error: ${err?.message ?? err}\n`)
      code = EXIT.REFUSED
    }
  }
  // After the command, so its own output comes first and the line goes to stderr only.
  await updateNotice(io.env ?? {}, io.stderr)
  return code
}

async function run(argv, io) {
  const [first, ...rest] = argv
  if (first === '--version' || first === '-v') {
    io.stdout.write(`${VERSION}\n`)
    return EXIT.OK
  }
  if (first === undefined) throw usage(USAGE)
  if (first === '--help' || first === '-h') return run(['help', ...rest], io)

  const ctx = context(siteFrom(io.env), io)
  const name = normalise(first)
  if (Object.hasOwn(own, name)) {
    if (rest.includes('--help') || rest.includes('-h')) return own.help.run(ctx, [name])
    return own[name].run(ctx, rest)
  }
  if (first.startsWith('-')) throw usage(USAGE)

  const command = findCommand(await ctx.manifest(), name)
  if (!command) throw usage(`Unknown command ${first}. riffkit help lists the commands.`)
  if (command.consumed_by) throw usage(`${command.name} is part of riffkit ${command.consumed_by}; run that instead.`)
  const { args, yes, help: wantsHelp } = commandArguments(command, rest)
  if (wantsHelp) return own.help.run(ctx, [command.name])
  if (command.effect === 'spend' && !yes) await confirmSpend(io, command, argv)
  return report(io, command, await ctx.call(command, args, ctx.token()))
}

function context(site, io) {
  let manifest
  const ctx = {
    site,
    io,
    env: io.env,
    own,
    say: (line) => io.stderr.write(`${line}\n`),
    manifest: () => (manifest ??= loadManifest(site)),
    token: () => readToken(site, io.env),
    capability: async (name) => capability(await ctx.manifest(), name, site),
    /** One capability call; a lost answer becomes the exit code for its effect. */
    async call(command, args, token) {
      try {
        return await call(site, command, args, token)
      } catch (err) {
        if (err instanceof NoAnswer) throw noAnswerError(command, err.message)
        throw err
      }
    },
  }
  return ctx
}

/**
 * A spend runs only with the user's go-ahead: asked here when a person is at
 * the terminal, otherwise given as --yes by an agent that has quoted the price
 * and heard yes. Nothing is sent before that.
 */
async function confirmSpend(io, command, argv) {
  if (!io.stdin.isTTY || !io.stderr.isTTY) {
    throw new CliError(
      EXIT.NOT_CONFIRMED,
      `${command.name} spends credits, so it runs only with --yes. Get the price first with the quote command ` +
      '(riffkit help lists the quote_ commands), restate the plan and the price to the user, get their go-ahead, ' +
      'then run the same command again with --yes.',
    )
  }
  const shown = ['riffkit', ...argv].map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ')
  const answer = await new Promise((resolve) => {
    // terminal: false keeps the terminal's own line editing (and works on any stream).
    const prompt = createInterface({ input: io.stdin, output: io.stderr, terminal: false })
    prompt.once('close', () => resolve(''))   // Ctrl-D, or the input ended: no
    prompt.question(`This spends credits:\n  ${shown}\nRun it? [y/N] `, (line) => {
      resolve(line)
      prompt.close()
    })
  })
  if (!/^y(es)?$/i.test(answer.trim())) throw new CliError(EXIT.NOT_CONFIRMED, 'Not run. Nothing was sent.')
}
