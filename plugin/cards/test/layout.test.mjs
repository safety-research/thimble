// The card layout (cards/layout.js): the gallery's views, drawn by the runner, lay out as Claude Code's terminal drew
// them (test/golden/, captured from a real session at each of GOLDEN_WIDTHS). All rows are made up.
//   node --test plugin/cards/test/layout.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startRunner } from './start.mjs'

import { layoutLines } from '../layout.js'
import { GALLERY, GOLDEN_WIDTHS } from './gallery.mjs'

let dir
let runner

const ask = (op, body) => runner.ask(op, body)

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'thimble-layout-'))
  runner = await startRunner(dir)
})

after(() => {
  runner?.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('each gallery view lays out as the terminal drew it, at each width', async () => {
  assert.ok(GALLERY.length >= 15)
  for (const [i, g] of GALLERY.entries()) {
    writeFileSync(join(dir, `${i}.json`), JSON.stringify(g.rows))
    for (const width of GOLDEN_WIDTHS) {
      const r = await ask('load', { id: `c${String(i).padStart(8, '0')}`, version: 1, title: g.title, view: g.view, rows: join(dir, `${i}.json`), width })
      assert.equal(r.ok, true, `${g.name}: ${r.error}`)
      const golden = readFileSync(fileURLToPath(new URL(`./golden/${g.name}@${width}.txt`, import.meta.url)), 'utf8').replace(/\n$/, '').split('\n')
      const lines = r.lines.slice()
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      assert.deepEqual(lines, golden, `${g.name} at ${width}`)
    }
  }
})

test('a wrapped text in a row of parts side by side, or padded into columns, is a row; a sentence alone is not', () => {
  const tree = { t: 'Box', p: { flexDirection: 'column' }, c: [
    { t: 'Text', p: {}, c: ['a sentence that wraps'] },
    { t: 'Text', p: {}, c: ['ada     3 of 9 merged'] },
    { t: 'Box', p: {}, c: [{ t: 'Text', p: {}, c: ['bram'] }, { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: [' 5 of 9 merged'] }] }] },
  ] }
  assert.deepEqual(layoutLines(tree, 12).wrapped.map(w => [w.text, !!w.row]), [['a sentence that wraps', false], ['ada     3 of 9 merged', true], [' 5 of 9 merged', true]])
})
