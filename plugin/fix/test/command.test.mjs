// thimble's slash commands are the hooks module's ($.command.register), each one command. A host that runs Claude Code
// through its SDK (the desktop app's Code tab) lists every command a plugin gives, a command file's as `thimble:<name>`
// beside the registered ones, and never asks the hooks which to leave out of the menu: a command file of a registered
// command's name showed the command twice there.
//   node --test plugin/fix/test/command.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The plugin's hooks sources' texts. */
function sources(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return d.name === 'node_modules' || d.name === 'tests' || d.name === 'test' ? [] : sources(p)
    return /\.(ts|tsx|mjs|js)$/.test(d.name) ? [readFileSync(p, 'utf8')] : []
  })
}

test('no command file has the name of a command the hooks module registers, so a host lists each of them once', () => {
  const registered = sources().flatMap(src => [...src.matchAll(/\$\.command\.register\(\{ name: '([^']+)'/g)].map(m => m[1]))
  assert.ok(registered.includes('thimble-fix') && registered.includes('thimble-settings'), registered.join(', '))
  const dir = join(ROOT, 'commands')
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')) : []
  for (const name of files) assert.ok(!registered.includes(name), `commands/${name}.md is listed as /thimble:${name} beside the registered /${name}`)
})
