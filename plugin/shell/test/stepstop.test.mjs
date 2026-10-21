// ] steps through each stop once, though an explainer arrives before the open stop while the person steps.
//   node --test shell/test/stepstop.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markNow, order, stepFrom } from '../tray.js'
import { frameOf } from '../../panes/tray.js'

const cite = (ref, label) => ({ kind: 'cite', ref, label })

test('a stop is found by what it shows, so an explainer saved before it does not bring it back on ]', () => {
  const rec = { row: 'm1', marks: [cite('log.jsonl#L4', 'the revert'), cite('log.jsonl#L9', '14:45'), cite('log.jsonl#L12', 'merged')], glosses: {} }
  // the tray opened on the second stop
  const frame = frameOf(rec, 1)
  // the observer saves an explainer on words before it: every later mark moves on by one
  const now = { ...rec, marks: [rec.marks[0], { kind: 'gloss', gloss: 'g1', label: 'revert' }, ...rec.marks.slice(1)], glosses: { g1: { term: 'revert' } } }
  const list = order([now])
  const at = list.findIndex(p => p.row === 'm1' && p.i === markNow(now, frame))
  assert.equal(now.marks[list[at].i].label, '14:45')
  // ] goes on to the next stop, not to the same stop at its new index
  assert.equal(now.marks[stepFrom(list, at, 1).i].label, 'merged')
  // the old index alone points at the explainer, a step back
  assert.equal(now.marks[frame.i].kind, 'gloss')
  // an explainer by its id; a frame whose mark is gone keeps its index
  assert.equal(markNow(now, frameOf(now, 1)), 1)
  assert.equal(markNow({ row: 'm1', marks: [] }, frame), 1)
})
