import { parseArgs, placeholders } from '../args.js'
import { usage } from '../errors.js'
import { findCommand, normalise, routeOf } from '../manifest.js'

const EFFECTS = [
  ['read', 'Read (changes nothing)'],
  ['write', 'Write (changes something in the account)'],
  ['spend', 'Spend (uses credits: asks first, or needs --yes)'],
]

export default {
  usage: 'help [command]',
  summary: 'List the commands, or show one command\'s options',
  async run(ctx, argv) {
    const { positionals } = parseArgs(argv, {})
    if (positionals.length > 1) throw usage(`Unexpected argument: ${positionals[1]}`)
    const { own } = ctx
    const name = positionals[0] && normalise(positionals[0])
    if (name && Object.hasOwn(own, name)) {
      ctx.io.stdout.write(`riffkit ${own[name].usage}\n\n${own[name].summary}.\n`)
      return 0
    }
    const manifest = await ctx.manifest()
    if (!name) {
      ctx.io.stdout.write(overview(manifest, own))
      return 0
    }
    const command = findCommand(manifest, name)
    if (!command || command.consumed_by) throw usage(`Unknown command ${positionals[0]}. riffkit help lists the commands.`)
    ctx.io.stdout.write(commandHelp(command))
    return 0
  },
}

/** A command's title as a heading: the name a person reads, without a closing full stop. */
const titleOf = (command) => String(command.title || command.name).replace(/\.$/, '')

/** Lines of cells in aligned columns, the last cell of each left as it is. */
function rows(lines) {
  const widths = lines[0].map((_, i) => Math.max(...lines.map((line) => line[i].length)) + 2)
  return lines.map((line) => `  ${line.map((cell, i) => (i < line.length - 1 ? cell.padEnd(widths[i]) : cell)).join('')}`).join('\n')
}

function overview(manifest, own) {
  // Each command next to its route: the agent skill names routes, and this is where they meet.
  const sections = EFFECTS.map(([effect, heading]) => {
    const commands = manifest.commands.filter((c) => c.effect === effect && !c.consumed_by)
    return commands.length ? `${heading}:\n${rows(commands.map((c) => [c.name, String(c.route), titleOf(c)]))}` : ''
  }).filter(Boolean)
  sections.push(`This CLI:\n${rows(Object.values(own).map((c) => [c.usage, c.summary]))}`)
  return [
    'riffkit: Riffkit from the terminal (https://riffkit.ai)',
    '',
    'Usage: riffkit <command> [<path arguments>] [--option value ...]',
    '',
    sections.join('\n\n'),
    '',
    'Each command calls the route next to it and takes that route\'s parameters. Names work in kebab-case',
    'too (remake-video, --formula-id). riffkit help <command> shows its options.',
    '',
  ].join('\n')
}

function commandHelp(command) {
  const { method, path, params } = routeOf(command)
  const positionals = placeholders(path).map((name) => `<${name}>`)
  const flagged = params.filter((p) => p.in !== 'path')
  const lines = [
    `riffkit ${[command.name, ...positionals].join(' ')}${flagged.length ? ' [--option value ...]' : ''}`,
    '',
    `${titleOf(command)}. ${method} ${path} (${command.effect})`,
    '',
    command.description ?? '',
  ]
  const described = params.filter((p) => p.in === 'path').concat(flagged)
  if (described.length) lines.push('', 'Arguments:')
  for (const param of described) {
    const label = param.in === 'path' ? `<${param.name}>` : `--${param.name}`
    const facts = [kind(param), param.required ? 'required' : '']
    if (param.enum) facts.push(`one of ${param.enum.join(', ')}`)
    if (param.default !== null && param.default !== undefined && param.default !== '') {
      facts.push(`default ${JSON.stringify(param.default)}`)
    }
    lines.push(`  ${label} (${facts.filter(Boolean).join('; ')})`)
    if (param.description) lines.push(`      ${param.description}`)
  }
  if (command.effect === 'spend') lines.push('', '--yes  run without asking (only after the user has agreed to the price)')
  return `${lines.join('\n')}\n`
}

function kind(param) {
  if (param.type === 'file') return 'a local file path'
  if (param.type === 'array') {
    return ['string', 'integer', 'number', 'boolean'].includes(param.items)
      ? `${param.items}, repeat the flag for each item`
      : 'JSON array'
  }
  if (param.type === 'object') return 'JSON object'
  return param.type
}
