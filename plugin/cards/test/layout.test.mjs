// The card layout (cards/layout.js): the gallery's views, drawn by the runner, lay out as Claude Code's terminal drew
// them (test/golden/, captured from a real session at each of GOLDEN_WIDTHS), and the text rules on their own. All rows
// are made up.
//   node --test plugin/cards/test/layout.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startRunner } from './start.mjs'

import { textWidth } from '../../core/text.js'
import { layoutLines, wrapText } from '../layout.js'
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

test('text wraps at words, keeps a word whole where it fits, and cuts one longer than the width', () => {
  // after a full row, the space before the next word counts in the next row's length but is not drawn (Claude Code)
  assert.deepEqual(wrapText('the quick brown fox', 9), ['the quick', 'brown ', 'fox'])
  assert.deepEqual(wrapText('the quick brown fox', 10), ['the quick ', 'brown fox'])
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapText('path/to/a/file.jsonl', 10, 'truncate-end'), ['path/to/a…'])
  assert.deepEqual(wrapText('path/to/a/file.jsonl', 10, 'truncate-start'), ['…ile.jsonl'])
  assert.deepEqual(wrapText('path/to/a/file.jsonl', 10, 'truncate-middle'), ['path/…sonl'])
})

test('wide characters take two cells, and a line past the width is cut and named', () => {
  assert.equal(textWidth('名前 ok'), 7)
  const box = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Box', p: { width: 30, flexShrink: 0 }, c: [{ t: 'Text', p: {}, c: ['x'] }] }, { t: 'Text', p: {}, c: ['fits'] }] }
  const r = layoutLines(box, 20)
  assert.deepEqual(r.lines, ['x', 'fits'])
  const wide = layoutLines({ t: 'Box', p: {}, c: [{ t: 'Box', p: { width: 25, flexShrink: 0, borderStyle: 'single' }, c: [] }] }, 20)
  assert.deepEqual(wide.cut, [1, 2])
  assert.equal(wide.lines[0], '┌' + '─'.repeat(19))
})

test('a text that wraps onto more rows than its own lines is named by its first line', () => {
  const tree = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['one\ntwo'] }, { t: 'Text', p: {}, c: ['a row of cells too wide'] }] }
  assert.deepEqual(layoutLines(tree, 30).wrapped, [])
  assert.deepEqual(layoutLines(tree, 12).wrapped, [{ line: 3, text: 'a row of cells too wide' }])
})

test('a wrapped text in a row of parts side by side, or padded into columns, is a row; a sentence alone is not', () => {
  const tree = { t: 'Box', p: { flexDirection: 'column' }, c: [
    { t: 'Text', p: {}, c: ['a sentence that wraps'] },
    { t: 'Text', p: {}, c: ['ada     3 of 9 merged'] },
    { t: 'Box', p: {}, c: [{ t: 'Text', p: {}, c: ['bram'] }, { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: [' 5 of 9 merged'] }] }] },
  ] }
  assert.deepEqual(layoutLines(tree, 12).wrapped.map(w => [w.text, !!w.row]), [['a sentence that wraps', false], ['ada     3 of 9 merged', true], [' 5 of 9 merged', true]])
})
