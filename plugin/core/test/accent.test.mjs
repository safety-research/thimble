// thimble's color (core/theme.ts accent()) is read when a drawing draws, never kept in a constant at load, so a fix
// that changes the color changes core/theme.ts alone and leaves the safety files (fix/, the fix flow) as they are.
//   node --test plugin/core/test/accent.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { askCell } from '../askcell.js'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url))

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === 'test' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}

test('no module keeps the accent in a constant: each drawing calls accent() as it draws, and the fix flow never names the color itself', () => {
  const kept = []
  const named = []
  for (const p of sources(PLUGIN)) {
    const rel = relative(PLUGIN, p)
    const text = readFileSync(p, 'utf8')
    // a module-level constant set from the accent, or the old constant itself
    if (/^(export )?(const|let|var) [^\n]*\baccent\(\)/m.test(text) || /\bACCENT\b/.test(text)) kept.push(rel)
    if (rel.startsWith('fix/') && /['"]merged['"]/.test(text)) named.push(rel)
  }
  assert.deepEqual(kept, [])
  assert.deepEqual(named, [])
  assert.match(readFileSync(join(PLUGIN, 'core/theme.ts'), 'utf8'), /export function accent\(\): string \{/)
})

test('the ask cell draws in the color its caller read, not one of its own', () => {
  const els = { Box: p => ({ type: 'Box', props: p }), Button: p => ({ type: 'Button', props: p }), Text: p => ({ type: 'Text', props: p }) }
  const colors = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(colors) : [...(n.type === 'Text' && n.props.color ? [n.props.color] : []), ...colors(n.props?.children)]
  for (const has of [true, false]) {
    const cell = askCell(els, { key: 'k', label: 'a made-up passage', has, press: () => undefined, color: 'made-up-blue' })
    assert.deepEqual(colors(cell), ['made-up-blue'])
  }
})
