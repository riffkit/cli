// Properties of the package itself.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ROOT } from './helpers.js'

function sources(dir = path.join(ROOT, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? sources(full) : entry.name.endsWith('.js') ? [full] : []
  })
}

test('no route is spelled out in src/: requests come from the command list', () => {
  const hits = sources().flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
    .map((line, i) => ({ where: `${path.relative(ROOT, file)}:${i + 1}`, line }))
    .filter(({ line }) => line.includes('/api/') && !line.trimStart().startsWith('//')))
  // The single exception: the prefix every route must start with.
  assert.deepEqual(hits.map((h) => h.line.trim()), ["const API_PREFIX = '/api/'"])
})

test('zero dependencies and no install scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
    assert.equal(pkg[key], undefined, key)
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[hook], undefined, hook)
  assert.equal(pkg.name, '@riffkit/cli')
  assert.equal(pkg.bin.riffkit, 'bin/riffkit.js')
})

test('the words Riffkit is never described with stay out of user-facing text', () => {
  for (const file of [path.join(ROOT, 'README.md'), ...sources()]) {
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /\b(copy|copies|copied|copying|clone|cloned|cloning|steal|stealing)\b/i, file)
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /expir/i)
})
