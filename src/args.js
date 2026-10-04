import fs from 'node:fs'
import { usage } from './errors.js'
import { normalise, routeOf } from './manifest.js'

// Flags every command takes, besides its own.
const GLOBAL = { yes: 'boolean', help: 'boolean' }
const SHORT = { y: 'yes', h: 'help' }

/**
 * Split a command line into positionals and flags. `flags` maps each flag the
 * command takes (snake_case) to 'boolean' or 'value'; `short` maps one-letter
 * aliases. A flag the command does not take is a usage error: a typo must not
 * silently run with the defaults.
 *
 *   --name value   --name=value   --flag (boolean, = true)   --flag false
 *   --             everything after it is a positional
 *
 * Returns { positionals: [...], flags: Map(name -> [raw values in order]) }.
 */
export function parseArgs(argv, flags, short = {}) {
  const types = { ...GLOBAL, ...flags }
  const aliases = { ...SHORT, ...short }
  const positionals = []
  const given = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    let name
    let value
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      name = normalise(eq === -1 ? arg.slice(2) : arg.slice(2, eq))
      if (eq !== -1) value = arg.slice(eq + 1)
    } else {
      name = Object.hasOwn(aliases, arg.slice(1)) ? aliases[arg.slice(1)] : undefined
    }
    if (!name || !Object.hasOwn(types, name)) throw usage(`Unknown option ${arg}. riffkit help <command> lists its options.`)
    if (types[name] === 'boolean') {
      if (value === undefined && (argv[i + 1] === 'true' || argv[i + 1] === 'false')) value = argv[++i]
      value ??= 'true'
    } else if (value === undefined) {
      if (i + 1 >= argv.length) throw usage(`${arg} needs a value.`)
      value = argv[++i]
    }
    given.set(name, [...(given.get(name) ?? []), value])
  }
  return { positionals, flags: given }
}

/** The one value of a flag that is not repeatable. */
export function single(flags, name) {
  const values = flags.get(name)
  if (!values) return undefined
  if (values.length > 1) throw usage(`--${name} is given more than once.`)
  return values[0]
}

/** An option's "@path" reads the file (UTF-8); "@@text" is "@text". */
export function textValue(raw) {
  if (raw.startsWith('@@')) return raw.slice(1)
  if (!raw.startsWith('@')) return raw
  try {
    return fs.readFileSync(raw.slice(1), 'utf8')
  } catch {
    throw usage(`Cannot read the file ${raw.slice(1)}.`)
  }
}

const SCALARS = new Set(['string', 'integer', 'number', 'boolean'])

/** True when a parameter is given by repeating its flag, one item each time. */
export const repeatable = (param) => param.type === 'array' && SCALARS.has(param.items)

/**
 * A flag's raw text as the value the request carries. Numbers and booleans are
 * parsed; text that is not one is sent as it is, and the server's 422 says what
 * is wrong with it. Objects and arrays of objects are JSON text.
 */
export function convert(param, raw, type = param.type) {
  if (type === 'file') return raw
  const text = textValue(raw)
  switch (type) {
    case 'integer':
    case 'number': {
      const number = Number(text)
      return text.trim() !== '' && Number.isFinite(number) ? number : text
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : text
    case 'object':
    case 'array':
      try {
        return JSON.parse(text)
      } catch {
        throw usage(`--${param.name} needs JSON text.`)
      }
    default:
      return text
  }
}

/** The placeholders of a route's path, in order: a command's positionals. */
export const placeholders = (path) => [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])

/**
 * A capability's command line as request arguments: path parameters are
 * positionals in route order, every other parameter is a flag named like it.
 * Returns { args: {name: value}, yes, help }.
 */
export function commandArguments(command, argv) {
  const { path, params } = routeOf(command)
  const flagged = params.filter((param) => param.in !== 'path')
  const { positionals, flags } = parseArgs(
    argv,
    Object.fromEntries(flagged.map((p) => [normalise(p.name), p.type === 'boolean' ? 'boolean' : 'value'])),
  )
  const yes = single(flags, 'yes') === 'true'
  if (single(flags, 'help') === 'true') return { args: {}, yes, help: true }

  const names = placeholders(path)
  if (positionals.length < names.length) {
    throw usage(`${command.name} needs <${names[positionals.length]}>. Usage: riffkit ${command.name} ${names.map((n) => `<${n}>`).join(' ')}`)
  }
  if (positionals.length > names.length) throw usage(`Unexpected argument: ${positionals[names.length]}`)
  // An id is never read from a file: "@" is just a character here.
  const args = Object.fromEntries(names.map((name, i) => [name, positionals[i]]))
  for (const param of flagged) {
    const key = normalise(param.name)
    if (!flags.has(key)) continue
    args[param.name] = repeatable(param)
      ? flags.get(key).map((raw) => convert(param, raw, param.items))
      : convert(param, single(flags, key))
  }
  return { args, yes, help: false }
}
