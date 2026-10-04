import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, single } from '../args.js'
import { CliError, EXIT, usage } from '../errors.js'
import { printJson, report } from '../request.js'

// The pace the server asks of every progress check.
const POLL_SECONDS = 30
const DEFAULT_TIMEOUT = 540

export default {
  usage: 'wait <batch_id> [--timeout seconds]',
  summary: `Wait until no task of a batch is queued or running (checks every ${POLL_SECONDS} seconds, gives up after ${DEFAULT_TIMEOUT} by default; exit ${EXIT.NO_VIDEO} when a task made no video)`,
  details: [
    `Prints the batch as JSON on stdout when it stops waiting. Exit 0: every task made its video (each task's result.asset_id is a video). Exit ${EXIT.WAIT_TIMEOUT}: still running after --timeout; run it again. Exit ${EXIT.NO_VIDEO}: finished, but a task made no video; read that task's error and result.`,
  ],
  async run(ctx, argv) {
    const { positionals, flags } = parseArgs(argv, { timeout: 'value' })
    if (positionals.length !== 1) throw usage(`Usage: riffkit ${this.usage}`)
    const raw = single(flags, 'timeout')
    const timeout = raw === undefined ? DEFAULT_TIMEOUT : Number(raw)
    if (!(timeout > 0)) throw usage('--timeout needs a number of seconds above 0.')
    const [batchId] = positionals
    const getBatch = await ctx.capability('get_batch')
    const token = ctx.token()
    const deadline = Date.now() + timeout * 1000

    for (;;) {
      const answer = await ctx.call(getBatch, { batch_id: batchId }, token)
      if (answer.status !== 200 || !answer.body) return report(ctx.io, getBatch, answer)
      const batch = answer.body
      if (batch.queued === 0 && batch.running === 0) {
        printJson(ctx.io.stdout, batch)
        const missing = withoutVideo(batch)
        if (missing.length) {
          const shown = missing.slice(0, 5).join('; ') + (missing.length > 5 ? `; and ${missing.length - 5} more` : '')
          throw new CliError(
            EXIT.NO_VIDEO,
            `Batch finished, but not every task made its video: ${shown}. The batch on stdout has each task's error.`,
          )
        }
        ctx.say(`Batch finished: ${batch.completed} completed (of ${batch.total}).`)
        return EXIT.OK
      }
      ctx.say(`${batch.total - batch.queued - batch.running} of ${batch.total} finished, ${batch.running} running, ${batch.queued} queued...`)
      const left = deadline - Date.now()
      if (left <= 0) {
        printJson(ctx.io.stdout, batch)
        throw new CliError(EXIT.WAIT_TIMEOUT, `Still in progress after ${timeout} seconds. Run riffkit wait ${batchId} again to keep waiting.`)
      }
      await sleep(Math.min(POLL_SECONDS * 1000, left))
    }
  },
}

/**
 * The tasks of a finished batch that made no video, one phrase each: every one
 * that did not complete (failed, dead, cancelled), and an analysis that
 * completed but never submitted its videos (result.auto_generate_error, such as
 * insufficient_credits).
 */
function withoutVideo(batch) {
  return (Array.isArray(batch.tasks) ? batch.tasks : []).flatMap((task) => {
    if (task?.status !== 'completed') return [`task ${task?.id} ${task?.status}`]
    const skipped = task.result?.auto_generate_error
    return skipped ? [`task ${task.id} submitted no video (auto_generate_error=${skipped})`] : []
  })
}
