import { parseArgs } from '../args.js'
import { CliError, EXIT, usage } from '../errors.js'
import { forgetToken, usesTokenVariable } from '../files.js'
import { NoAnswer, call } from '../request.js'

export default {
  usage: 'logout',
  summary: 'Sign out and remove the saved session',
  async run(ctx, argv) {
    const { positionals } = parseArgs(argv, {})
    if (positionals.length) throw usage(`Unexpected argument: ${positionals[0]}`)
    let token = null
    try {
      token = ctx.token()
    } catch {
      // An unusable saved session: there is nothing to end, only a file to remove.
    }
    if (!token) {
      ctx.say(forgetToken(ctx.site) ? 'Removed the saved session.' : 'Not signed in.')
      return EXIT.OK
    }

    // End the session on the server first; the file goes whatever the answer.
    let failure
    try {
      const answer = await call(ctx.site, await ctx.capability('sign_out'), {}, token)
      // 401: the server had already ended it.
      if ((answer.status < 200 || answer.status >= 300) && answer.status !== 401) {
        failure = new CliError(answer.status < 500 ? EXIT.REFUSED : EXIT.NO_ANSWER_WRITE, `HTTP ${answer.status}`)
      }
    } catch (err) {
      failure = new CliError(err instanceof CliError ? err.code : EXIT.NO_ANSWER_WRITE, err instanceof NoAnswer ? err.message : 'no answer')
    }
    // RIFFKIT_TOKEN is not this CLI's to remove: the saved session file stays as it is.
    const fromVariable = usesTokenVariable(ctx.site, ctx.env)
    if (!fromVariable) forgetToken(ctx.site)
    if (!failure) {
      ctx.say(fromVariable
        ? 'Signed out the session in RIFFKIT_TOKEN: unset it. The saved session file was left as it is.'
        : 'Signed out.')
      return EXIT.OK
    }
    throw new CliError(
      failure.code,
      (fromVariable
        ? `Riffkit did not confirm the sign-out (${failure.message}), so the session in RIFFKIT_TOKEN may still be live. `
        : `Removed the session here, but Riffkit did not confirm the sign-out (${failure.message}), so it may still be live. `) +
      'To end it, use "Sign out other devices" in the Riffkit settings.',
    )
  },
}
