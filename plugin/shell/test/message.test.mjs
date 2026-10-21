// The citation format in a message (shell/message.js): the marks Claude wrote as offsets into its markdown, and a
// citation's healing as its card draws it (shell/cards.js). node --test plugin/shell/test/message.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { citeCard, citeWords, drawnCard, drawsHyperlinks, explainerCard, fileLink, healMd, linksIn, placeOf, sourceCard } from '../cards.js'
import { linkRuns } from '../carddetail.js'
import { askedRow, engagedText, openedRow } from '../engaged.js'
import { anchorTerm, blocks, findInLink, findTerm, glossesOf, headsOf, healInput, healedRecord, inline, lineOf, linkMarks, marksIn, needsHeal, newRecord, plainWords, placeMarks, recordFor, remark, runsText, seriesRef, shownOf, sparkChars, stemOf, tableOf, textKey, verbsOf, withObserver, wrapRuns } from '../message.js'
import { back, base, open, order, push, step, top } from '../tray.js'
import { citeRef } from '../object.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { frameOf } from '../../panes/tray.js'

const TEXT = 'Mostly notes. Of 9,120 saves, [2,310 notes](q2#label=note@n) [~](q3@n) went to other bots, from [880 senders](q4#row=1@n). I read only **1 of 3 files**, so the `fixture scope` and `rebase loop` are guesses.'
const at = (text, m) => text.slice(m.start, m.end)

test('the record holds the cites and sparks Claude wrote, as offsets into its markdown', () => {
  const rec = newRecord({ row: 'r1', session: 's1', text: TEXT })
  assert.equal(rec.v, 1)
  assert.equal(rec.shown, null)
  assert.deepEqual(rec.marks.map(m => m.kind), ['cite', 'spark', 'cite'])
  assert.equal(at(TEXT, rec.marks[0]), '[2,310 notes](q2#label=note@n)')
  assert.equal(rec.marks[0].label, '2,310 notes')
  assert.equal(rec.marks[1].ref, 'q3@n')
  assert.equal(at(TEXT, rec.marks[2]), '[880 senders](q4#row=1@n)')
  assert.deepEqual(rec.verbs, {})
  assert.deepEqual(rec.glosses, {})
})

test('links inside code, and links to the web, are not marks', () => {
  const t = 'See `[a](q1#row=1@n)` and [docs](https://example.org/x) and\n```\n[b](q2)\n```\nand [c](q3#row=2@n).'
  const marks = linkMarks(t)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].label, 'c')
})

const draw = (part, w = 90, h = 9) => { const d = runProgram(part, { w, h }); assert.equal(d.error, undefined, JSON.stringify(d.error)); return renderTerm(d, { w }) }

test('a citation whose key holds spaces and brackets is one mark, and its card opens the row behind the value it shows', () => {
  // Claude copied the key's words into the ref: still one link, nothing of it spills into the prose
  const text = 'Clean wins took a median of [110](q11#outcome=won (clean ep)@median) calls; all runs [4 failed](q11).'
  const marks = linkMarks(text)
  assert.deepEqual(marks.map(m => [m.ref, m.label]), [['q11#outcome=won (clean ep)@median', '110'], ['q11', '4 failed']])
  assert.equal(text.slice(marks[0].end), ' calls; all runs [4 failed](q11).')
  assert.deepEqual(linkMarks('a median of [110](r11#outcome=won (clean ep)@median) calls').map(m => m.ref), ['r11#outcome=won (clean ep)@median'])
  // the kernel narrowed the whole-query cite to the row holding its value: the card's hot row is that row
  const query = { id: 'q11', about: 'runs by outcome', keys: ['outcome'], table: [{ outcome: 'won (clean ep)', n: 3, median: 110 }, { outcome: 'failed/adversarial', n: 4, median: 165 }, { outcome: 'contested', n: 1, median: 190 }] }
  const resolved = { ref: 'q11#outcome=failed/adversarial@n', narrowed: 'q11#outcome=failed/adversarial@n', wrote: 'q11', count: 4, rows: ['runs.jsonl#L6-9'], records: [], chain: [] }
  const card = sourceCard({ ref: 'q11', label: '4 failed', resolved, query })
  const { rows, hotCol } = card.parts[0].data
  assert.deepEqual(rows.filter(r => r.hot).map(r => [r.cells[0], r.cells[hotCol]]), [['failed/adversarial', '4']])
  // a key written as its slug finds its row in the card too
  const slugged = sourceCard({ ref: 'q11#outcome=won-clean-ep@median', label: '110', resolved: { count: 3, rows: [], records: [], chain: [] }, query })
  const s2 = slugged.parts[0].data
  assert.deepEqual(s2.rows.filter(r => r.hot).map(r => [r.cells[0], r.cells[s2.hotCol]]), [['won (clean ep)', '110']])
})

test("a citation's rows section names the cited files' own entries: records, rows or lines, and none for a whole file", () => {
  const query = { id: 'q4', about: 'survivors by class and sex', keys: ['class', 'sex'], table: [{ class: 3, sex: 'male', n: 347 }, { class: 1, sex: 'female', n: 94 }] }
  const ofRecords = { count: 347, rows: ['revisions.jsonl#L1-347'], records: [], chain: [], unit: 'records', unit_one: 'record' }
  const card = sourceCard({ ref: 'q4#class=3,sex=male@n', label: 'class 3 male', resolved: ofRecords, query })
  const rows = card.sections.find(x => x.id === 'rows')
  assert.equal(rows.key, 'r')
  assert.equal(rows.words, 'records')
  assert.match(rows.parts[0].data.head, /^\*\*347\*\* records of revisions\.jsonl behind /)
  const csv = sourceCard({ ref: 'q4#class=3,sex=male@n', label: 'class 3 male', resolved: { ...ofRecords, rows: ['titanic.csv#L2-348'], unit: 'rows', unit_one: 'row' }, query })
  assert.equal(csv.sections.find(x => x.id === 'rows').words, 'rows')
  // whole files with no entries (an image, a PDF): no rows section, the code section still there
  const img = sourceCard({ ref: 'q4#class=3,sex=male@n', label: 'class 3 male', resolved: { ...ofRecords, rows: ['chart.png'], unit: null, unit_one: null }, query })
  assert.deepEqual(img.sections.map(x => x.id), ['code'])
})

test('a card detail reads a takeaway citation whose ref holds brackets as one link, nothing of it left as words', () => {
  const runs = linkRuns('Girls: [19](r4#age=child%20(0-12)&group=b@kept) of 32, **most** of them.')
  assert.deepEqual(runs, [{ s: 'Girls: ' }, { s: '19', link: 'r4#age=child%20(0-12)&group=b@kept' }, { s: ' of 32, ' }, { s: 'most', bold: true }, { s: ' of them.' }])
})

test('the healing pass in a drawing: a spinner while it runs, a re-pointed citation opens its new place, an unwrapped one is grey, a contradicted one has a red ×', () => {
  const text = 'Busiest: [5](r1#day=a@n). Gone: [12](r9@n). Wrong: [4](r1#day=b@n).'
  const rec = { ...newRecord({ row: 'x', session: 's', text }) }
  assert.equal(needsHeal(rec), true)
  const checking = healedRecord(rec, { checking: true })
  const runs = inline(text, 0, text.length, checking.marks)
  assert.equal(runs.filter(r => r.tag === 'checking').length, 3)
  assert.equal(healInput(rec), text)
  const healed = { ...rec, heal: { key: textKey(text), changes: [
    { label: '5', ref: 'r1#day=a@n', state: 'linked', how: 'cell', to: 'r1#day=c@n' },
    { label: '12', ref: 'r9@n', state: 'quiet', how: 'gone', why: 'the cited place is gone (no query r9)' },
    { label: '4', ref: 'r1#day=b@n', state: 'contradicted', how: 'contradicted', to: 'r1#day=b@n', why: 'the cited place shows 3' },
  ] } }
  assert.equal(needsHeal(healed), false)
  const m = healedRecord(healed).marks
  assert.deepEqual([m[0].ref, m[0].wrote, m[1].heal, m[2].heal, m[2].why], ['r1#day=c@n', 'r1#day=a@n', 'quiet', 'bad', 'the cited place shows 3'])
  const drawn = inline(text, 0, text.length, m)
  assert.deepEqual(drawn.filter(r => r.tag).map(r => r.s), [' ×'])
  // a squeeze's new text is a new key: its own pass, the old result left alone
  assert.equal(needsHeal({ ...healed, shown: 'Busiest: [5](r1#day=a@n).' }), true)
})

test('an explainer and a re-pointed citation\'s card show what the healing pass did: grey, ×, the new place, and where it was moved from', async () => {
  const gloss = { term: 'edits', body: 'Wren made [7](r1#day=a@n) edits, [12](r9@n) in all, and [4](r1#day=b@n) reverts.' }
  const heal = { changes: [
    { label: '7', ref: 'r1#day=a@n', state: 'linked', how: 'cell', to: 'r1#day=c@n' },
    { label: '12', ref: 'r9@n', state: 'quiet', how: 'gone' },
    { label: '4', ref: 'r1#day=b@n', state: 'contradicted', how: 'contradicted', to: 'r1#day=b@n', why: 'the cited place shows 3' },
  ] }
  const card = explainerCard({ gloss, heal })
  const text = card.parts[0].data.text
  assert.ok(text.includes('{dim:12}') && text.includes('{bad: ×}'))
  assert.deepEqual(card.links.map(l => l.ref), ['r1#day=c@n', 'r1#day=b@n'])
  assert.equal(healMd('see [it](auth.py:88)'), 'see [it](auth.py#L88)')
  const rec = { ...newRecord({ row: 'x', session: 's', text: 'Wren made [7](r1#day=a@n) edits.' }) }
  const healed = healedRecord({ ...rec, heal: { key: textKey(rec.text), changes: [heal.changes[0]] } })
  const f = frameOf(healed, 0)
  assert.deepEqual([f.ref, f.heal, f.wrote], ['r1#day=c@n', 'moved', 'r1#day=a@n'])
})
