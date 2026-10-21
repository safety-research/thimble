// The card detail's action for the selected part's entries (panes/detail.js): it names them in the cited files' own
// word, as a citation's section does (shell/cards.js entryWords), and is left out when they are whole files.
//   node --test plugin/panes/test/detail.test.mjs
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { program } from '../detail.js'

const DK = globalThis.DrawKit
const DRAWING = { kit: 1, w: 20, h: 1, root: { t: 'text', runs: [{ s: 'share by user', tone: 'ink' }] }, cites: {}, examples: {}, regions: [], warnings: [] }
const DATA = { id: 'c1', title: 'Share by user', text: '', drawing: DRAWING, parts: [{ id: 'bar-a', label: 'Kestrel 41%', cite: null, examples: null }],
  refs: { 'bar-a': ['q4#row=2'] }, order: ['bar-a'], cites: {}, examples: {}, controls: [], versions: [], labels: [] }

// the action's label as drawn, with `thimble resolve`'s answer for the rows behind the part (none: not in hand yet)
const action = resolved => {
  const got = resolved ? { [DK.wantKey({ rows: ['q4#row=2'], n: 8 })]: resolved } : {}
  const d = DK.run(program, DATA, { w: 60, h: 30, mode: 'pane', got })
  assert.equal(d.error, undefined, d.error && d.error.message)
  return (d.on || []).find(h => h.name === 'act:rows')?.label ?? null
}

test("the selected part's action names its entries in the cited files' own word, and is left out for whole files", () => {
  assert.equal(action({ rows: ['revisions.jsonl#L28-31'], count: 4, unit: 'records', unit_one: 'record' }), 'Records')
  assert.equal(action({ rows: ['people.csv#row=2-5'], count: 4, unit: 'rows', unit_one: 'row' }), 'Rows')
  assert.equal(action({ rows: ['notes.txt#L3-9'], count: 7, unit: 'lines', unit_one: 'line' }), 'Lines')
  // a picture cited whole, and a table cited as a whole file: no entries to show
  assert.equal(action({ rows: ['plot.png'], count: null, unit: null, unit_one: null }), null)
  assert.equal(action({ rows: ['people.csv'], count: null, unit: 'rows', unit_one: 'row' }), null)
  // until resolve answers, the action keeps its plain word
  assert.equal(action(null), 'Rows')
})
