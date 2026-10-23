// The Labels pane's ledger (labels/ledger.mjs) as text, in each state: at rest (a table per label), many labels (one
// line each), a value open (its examples one line each), an example picked (open in place with its check keys), and
// one label. Every row fits the pane. All data is made up.
//   node --test plugin/labels/test/ledger.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { textWidth } from '../../core/text.js'
import { chosenOf, definition, examples, isNegative, ledgerTop, partOf, rowText, toneOf, valueOrder, whoOf, wrapRuns } from '../ledger.mjs'

const W = 74
const ROWS = 37
const label = (name, kind, counts, more = {}) => ({
  name, kind, rule: kind === 'code' ? 'def label(u):\n    return "yes"' : 'stuck|blocked', values: Object.keys(counts), in: 'runs/*/board.jsonl',
  records: Object.values(counts).reduce((a, b) => a + b, 0), counts, waiting: 0, failed: 0, checked: 0, ...more,
})
const STUCK = label('stuck', 'regex', { yes: 1175, no: 8746 })
const ASKS = label('asks_review', 'code', { yes: 2165, no: 7756 })
const KIND = label('post_kind', 'prompt', { status: 62, review: 37, claim: 14, question: 0, other: 7 }, { trial: true, matched: 9921 })
const OUTCOME = label('outcome', 'code', { merged: 2963, closed: 878, open: 846 })
const TONE = label('tone', 'prompt', { friendly: 8, neutral: 46, terse: 6 }, { trial: true, matched: 9921 })
const AREA = label('area', 'prompt', Object.fromEntries(['io', 'groupby', 'indexing', 'reshape', 'datetime', 'strings', 'plotting', 'docs', 'ci', 'other'].map((v, i) => [v, 10 + i])))
const FIVE = [STUCK, ASKS, KIND, OUTCOME, TONE]

const text = rows => rows.map(rowText)
const fits = rows => text(rows).forEach(t => assert.ok(textWidth(t) <= W, `wider than ${W}: ${JSON.stringify(t)}`))
const recs = n => Array.from({ length: n }, (_, i) => ({
  ref: `runs/a/board.jsonl#L${i + 1}`, i, value: 'yes', by: 'code', meta: `wren-${i + 1}`,
  words: `post ${i + 1}: please take a look, REVIEW WANTED for my change to the reader, thanks in advance to whoever has time today`,
  hit: { before: `post ${i + 1}: please take a look, `, match: 'REVIEW WANTED', after: ' for my change to the reader, thanks in advance to whoever has time today' },
}))
const place = r => r.ref.replace(/#L(\d+)$/, ':$1')

test('at rest each label is a table: its name and records, then each value with its bar, count and share', () => {
  const top = ledgerTop(FIVE, null, { w: W, rows: ROWS })
  assert.equal(rowText(top.head), 'Labels · 5 labels')
  const t = text(top.rows)
  assert.match(t[0], /^stuck {2,}9,921$/)
  assert.match(t[1], /^ {2}yes {7}▅+ +1,175 +12%$/)
  assert.match(t[2], /^ {2}no {8}▅+ +8,746 +88%$/)
  // a trial says so; a value with no records shows its 0 with no bar
  assert.ok(t.some(x => /^post_kind +120 of 9,921 at random$/.test(x)))
  assert.ok(t.some(x => /^ {2}question {9} +0 +0%$/.test(x)))
  assert.ok(!t.some(x => x.includes('▸')))
  fits(top.rows)
  // no is the gray of a yes/no label, its bar a track; other values their own colors
  assert.equal(toneOf(['yes', 'no'], 'no'), 'neg')
  assert.equal(toneOf(['merged', 'closed'], 'closed'), 'v1')
  assert.equal(isNegative(['no', 'maybe'], 'no'), false)
  const no = top.rows[2]
  assert.deepEqual([no.find(r => r.s.startsWith('no'))?.tone, no.find(r => r.s.startsWith('▅'))?.tone], ['neg', 'track'])
})

test('many labels: when the tables do not fit, each label is one line, its values wrapped under its bar', () => {
  const many = [...FIVE, AREA, label('verdict', 'code', { approve: 8639, request_changes: 1389 })]
  const top = ledgerTop(many, null, { w: W, rows: ROWS })
  const t = text(top.rows)
  assert.equal(t[0], 'stuck        ▅▅▅▅▅▅▅▅▅▅  yes 1,175   no 8,746')
  const area = t.findIndex(x => x.startsWith('area '))
  assert.ok(t[area + 1].startsWith(' '.repeat(25)), 'the values go on under the bar')
  assert.ok(!t.some(x => x.includes('…')), 'at rest no value is cut')
  assert.equal(t.filter(x => /^\S/.test(x)).length, many.length)
  fits(top.rows)
})

test('a value open: its label a table with the ▸, the others one line each, its examples one line each', () => {
  const chosen = chosenOf(FIVE, { label: 'asks_review', value: 'yes' })
  const top = ledgerTop(FIVE, chosen, { w: W, rows: ROWS })
  const t = text(top.rows)
  assert.deepEqual(t.slice(0, 3).map(x => x.split(/\s+/)[0]), ['stuck', '', 'asks_review'])
  assert.match(t[3], /^▸ yes +▅+ +2,165 +22%$/)
  // a label folded to one line is cut with … where its values do not fit
  assert.ok(t.find(x => x.startsWith('post_kind')).endsWith('…'))
  const ex = examples(ASKS, 'yes', { at: 0, total: 2165, records: recs(30) }, { w: W, rows: 20, sel: null, place })
  const e = text(ex.rows)
  assert.match(e[0], /^yes · 2,165 +1–18 of 2,165$/)
  // the match within the first third, the words before it cut at a word's edge
  assert.match(e[1], /^ {2}wren-1 {3}…please take a look, REVIEW WANTED for my change to the…$/)
  assert.equal(e.at(-1), '  ↓ 2,147 more')
  assert.equal(e.length, 20)
  // the match bold in the value's color
  assert.deepEqual(ex.rows[1].filter(r => r.bold).map(r => [r.s, r.tone]), [['REVIEW WANTED', 'v0']])
  fits([...top.rows, ...ex.rows])
  // a press: a value row opens it, an example picks it
  assert.deepEqual(partOf(top.rows[3][0].part), ['v', 'asks_review', 'yes'])
  assert.deepEqual(partOf(ex.rows[1][0].part), ['r', 'runs/a/board.jsonl#L1'])
})

test('an example picked opens in place: its words over up to five lines, where it is, and the check keys', () => {
  const page = { at: 0, total: 2165, records: recs(30) }
  const ex = examples(ASKS, 'yes', page, { w: W, rows: 20, sel: 'runs/a/board.jsonl#L3', place })
  const e = text(ex.rows)
  const at = e.findIndex(x => x.startsWith('▸ wren-3'))
  assert.ok(at > 0)
  assert.match(e[at + 1], /^ {11}\S/)
  const where = e.find(x => x.includes('runs/a/board.jsonl:3'))
  assert.match(where, /^ {11}runs\/a\/board\.jsonl:3 +1: yes {2}2: no$/)
  assert.deepEqual(ex.rows.flat().filter(r => r.hotkey).map(r => [r.hotkey, r.s]), [['1', 'yes'], ['2', 'no']])
  fits(ex.rows)
  // the last one shown, picked: the list moves so it shows whole, `↑ N earlier` above
  const last = examples(ASKS, 'yes', page, { w: W, rows: 20, sel: 'runs/a/board.jsonl#L18', place })
  const l = text(last.rows)
  assert.match(l[1], /^ {2}↑ \d+ earlier$/)
  assert.ok(l.some(x => x.includes('board.jsonl:18')))
  assert.ok(l.length <= 20)
  // a checked example says the person's value, and 0 takes it back
  const checked = examples(ASKS, 'yes', { ...page, records: [{ ...recs(1)[0], checked: true, value: 'no' }] }, { w: W, rows: 20, sel: 'runs/a/board.jsonl#L1', place })
  assert.deepEqual(checked.rows.flat().filter(r => r.hotkey).map(r => [r.hotkey, r.s]), [['1', 'yes'], ['2', 'no'], ['0', 'take back']])
  assert.ok(text(checked.rows).some(x => /board\.jsonl:1 +✓ you: no {3}1: yes {2}2: no {2}0: take back$/.test(x)))
  assert.match(rowText(checked.rows[1]), /^▸ wren-1 /)
  // a model's example: its confidence at the right; picked, its reason
  const model = { ref: 'runs/a/board.jsonl#L9', value: 'friendly', by: 'model', confidence: 0.55, meta: 'moss', words: 'Thanks all, merged.', reason: 'says thanks' }
  const m = examples(TONE, 'friendly', { at: 0, total: 8, records: [model] }, { w: W, rows: 10, sel: null, place })
  assert.match(rowText(m.rows[1]), /^ {2}moss {2}Thanks all, merged\. +55%$/)
  const mp = text(examples(TONE, 'friendly', { at: 0, total: 8, records: [model] }, { w: W, rows: 10, sel: model.ref, place }).rows)
  assert.ok(mp.some(x => x.trim() === 'the model: says thanks'))
})

test('one label opens on its first value with records; d shows the definition whole and what it went over', () => {
  const chosen = chosenOf([TONE], {})
  assert.deepEqual([chosen.lab.name, chosen.value], ['tone', 'friendly'])
  const t = text(ledgerTop([TONE], chosen, { w: W, rows: ROWS }).rows)
  assert.match(t[0], /^tone +60 of 9,921 at random$/)
  assert.match(t[1], /^▸ friendly/)
  assert.equal(t.filter(x => /^[^\s▸]/.test(x)).length, 1)
  // nothing named and more than one label: at rest
  assert.equal(chosenOf(FIVE, {}), null)
  // a value named that the label does not have: its first with records
  assert.equal(chosenOf(FIVE, { label: 'post_kind', value: 'gone' }).value, 'status')
  const d = definition(ASKS, W)
  assert.equal(rowText(d[0]), 'definition · code')
  assert.deepEqual(d[1], { code: 'def label(u):\n    return "yes"' })
  assert.equal(rowText(d.at(-1)), '9,921 records in runs/*/board.jsonl')
  assert.equal(rowText(definition(STUCK, W)[1]), '  stuck|blocked')
})

test('p n walk every value in reading order; a row names a table row by its key, a line by who wrote it', () => {
  assert.deepEqual(valueOrder([STUCK, TONE]), [['stuck', 'yes'], ['stuck', 'no'], ['tone', 'friendly'], ['tone', 'neutral'], ['tone', 'terse']])
  assert.equal(whoOf({ ref: 'runs/a/forge.db#prs/65559', meta: 'gh:someone' }), '#65559')
  assert.equal(whoOf({ ref: 'runs/a/board.jsonl#L4', meta: 'wren' }), 'wren')
  assert.equal(whoOf({ ref: 'runs/a/board.jsonl#L4' }), 'line 4')
  // a word longer than a line is cut across lines; the styles stay with their words
  assert.deepEqual(wrapRuns([{ s: 'ab cd ' }, { s: 'efghij', bold: true }], 4).map(l => l.map(r => r.s)), [['ab'], ['cd'], ['efgh'], ['ij']])
})
