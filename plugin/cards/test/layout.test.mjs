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

import { layoutLines, pressAt } from '../layout.js'
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

// A click on a cell presses the Button that stands there, wherever the layout places it: a strip of one Button per run
// beside its label (B32: the card tool's click test found only a Button around lines, said no Button stood there, and
// Claude drew the card again without its Buttons)
test('a click on a cell finds the Button there: a Button of words in a row beside Texts or alone on its line, the innermost, and with inline false only a Button around lines', () => {
  const B = (n, label, more = { plain: true }) => ({ t: 'Button', p: { onPress: n, ...more }, c: [{ t: 'Text', p: {}, c: [label] }] })
  const T = s => ({ t: 'Text', p: {}, c: [s] })
  const tree = { t: 'Box', p: { flexDirection: 'column' }, c: [
    T('Runs'),
    { t: 'Box', p: {}, c: [T('result '), B(0, '✓'), B(1, '×'), T('┃'), B(2, '×')] },
    B(3, 'add ten', {}),
    { t: 'Box', p: { flexDirection: 'column', onPress: 4 }, c: [{ t: 'Box', p: {}, c: [T('group '), B(5, 'inner')] }] },
  ] }
  assert.deepEqual(layoutLines(tree, 30).lines, ['Runs', 'result ✓×┃×', '[ add ten ]', 'group inner'])
  const at = (x, y, o) => pressAt(tree, 30, x, y, o)
  // the strip: each run's Button, and nothing on the label or the line between
  assert.deepEqual([0, 6, 7, 8, 9, 10, 11].map(x => at(x, 1)), [null, null, 0, 1, null, 2, null])
  assert.equal(at(0, 0), null)
  // a Button alone on its line takes the cells of its brackets too, and no more
  assert.deepEqual([0, 10, 11].map(x => at(x, 2)), [3, 3, null])
  // a Button of words inside a Button around lines: the innermost, and the outer one around it
  assert.deepEqual([0, 6, 10, 20].map(x => at(x, 3)), [4, 5, 5, 4])
  // only the Buttons around lines
  assert.deepEqual([at(8, 1, { inline: false }), at(0, 2, { inline: false }), at(6, 3, { inline: false })], [null, null, 4])
})
