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

test('a citation the healing pass re-pointed is found by the ref as written, so ] goes on past it', () => {
  // the third citation was written as row=3 and re-pointed to row=4, the place the second one names
  const rec = { row: 'm1', marks: [cite('r2#row=1@pct', '97%'), cite('r2#row=4@pct', 'half'), cite('r2#row=1@pct', '37%'), cite('r2#row=3@pct', '16%'), cite('r2#row=6@pct', '14%')], glosses: {} }
  const healed = { ...rec, marks: rec.marks.map((m, i) => (i === 2 ? { ...m, ref: 'r2#row=2@pct', wrote: m.ref, heal: 'moved' } : i === 3 ? { ...m, ref: 'r2#row=4@pct', wrote: m.ref, heal: 'moved' } : m)) }
  const list = order([rec])
  const seen = []
  let at = 0
  for (let k = 0; k < 8 && at >= 0; k++) {
    seen.push(rec.marks[list[at].i].label)
    const frame = frameOf(healed, list[at].i)
    const here = list.findIndex(p => p.row === 'm1' && p.i === markNow(rec, frame))
    const next = stepFrom(list, here, 1)
    at = next ? list.indexOf(next) : -1
  }
  assert.deepEqual(seen, ['97%', 'half', '37%', '16%', '14%'])
})
