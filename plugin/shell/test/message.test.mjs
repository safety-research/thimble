// The citation format in a message (shell/message.js): the marks Claude wrote as offsets into its markdown, and a
// citation's healing as its card draws it (shell/cards.js). node --test plugin/shell/test/message.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { citeCard, citeWords, drawnCard, drawsHyperlinks, explainerCard, fileLink, healMd, linksIn, placeOf, sourceCard } from '../cards.js'
import { linkRuns } from '../carddetail.js'
import { askedRow, engagedText, openedRow } from '../engaged.js'
import { anchorTerm, blocks, findInLink, findTerm, glossesOf, headsOf, healInput, healedRecord, inline, lineOf, linkMarks, marksIn, needsHeal, newRecord, plainWords, placeMarks, recordFor, remark, runsText, seriesRef, shownOf, sparkChars, stemOf, tableOf, textKey, verbsOf, withGone, withHeal, withObserver, wrapRuns } from '../message.js'
import { applyRewrite, restore } from '../../squeeze/chips.mjs'
import { back, base, open, order, push, step, stepFrom, top } from '../tray.js'
import { citeRef } from '../object.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { cardBody, frameOf } from '../../panes/tray.js'

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

test('a citation after a fenced block and inline code spans is a mark: the fence\'s backticks never pair with a span\'s', () => {
  const t = '```bash\npkill -f x\n```\n\nThe `pkill -f` ran; the `pkill` calls ended at [step 8,000](a.jsonl#L5) and no `x` ran.'
  const marks = linkMarks(t)
  assert.deepEqual(marks.map(m => [m.kind, m.label]), [['cite', 'step 8,000']])
})

// the message's drawing (view.ts), loaded as TypeScript: its imports name modules without their extension, as the plugin's
// bundler reads them, so a resolve hook adds `.ts`. Skipped on a Node that cannot run TypeScript
register('data:text/javascript,' + encodeURIComponent('export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (/^\\.\\.?\\//.test(s) && !/\\.[cm]?[jt]sx?$/.test(s)) return next(s + ".ts", c); throw e } }'))
const view = await import('../view.ts').catch(() => null)
// Claude Code's elements as plain nodes: each a name and its props
const els = new Proxy({}, { get: (_, type) => props => ({ type, props }) })
const nodes = n => (n == null ? [] : Array.isArray(n) ? n.flatMap(nodes) : typeof n === 'object' ? [n, ...nodes(n.props?.children)] : [])

test('a fenced block keeps its lines: a link in it is no mark, an explainer never lands in it, and the reply draws it as written', { skip: !view && 'this Node runs no TypeScript' }, () => {
  const t = 'A citation is checked in three steps:\n\n```\n┌ claim ┐ ──▶ ┌ query ┐\n│ [352](r3#outcome=approved@n) row sets │\n└───────┘     └───────┘\n```\n\nThe [check](q1#row=1@n) then runs.'
  // the fence holds all three lines: its link is no mark, and an explainer's term said only inside it has no place
  assert.deepEqual(linkMarks(t).map(m => m.label), ['check'])
  assert.equal(anchorTerm(t, 'row sets'), null)
  const code = blocks(t).filter(b => b.type === 'code')
  assert.equal(code.length, 1)
  assert.deepEqual(t.slice(code[0].start, code[0].end).split('\n').slice(1, -1), ['┌ claim ┐ ──▶ ┌ query ┐', '│ [352](r3#outcome=approved@n) row sets │', '└───────┘     └───────┘'])
  // a record whose marks still fall in the block (written before): the block is Claude Code's Markdown, its lines whole
  const rec = newRecord({ row: 'r1', session: 's1', text: t })
  const inBlock = t.indexOf('[352]')
  rec.marks = [{ kind: 'cite', start: inBlock, end: t.indexOf(')', inBlock) + 1, ref: 'r3#outcome=approved@n', label: '352' }, ...rec.marks]
  const drawn = nodes(view.messageEl(els, { rec, key: 'm', cols: 40, first: true, theme: 'dark', focus: null, onMark: () => {} }))
  const md = drawn.filter(n => n.type === 'Markdown').map(n => n.props.text).join('\n')
  assert.match(md, /```\n┌ claim ┐ ──▶ ┌ query ┐\n│ \[352\]\(r3#outcome=approved@n\) row sets │\n└───────┘     └───────┘\n```/)
  assert.ok(!drawn.some(n => n.type === 'Button' && /352/.test(n.props.label)), 'no press on the link in the block')
})

test('a table too wide for its column is drawn as its rows, `header: cell`, each citation in it still a mark that ] stops on', { skip: !view && 'this Node runs no TypeScript' }, () => {
  const t = 'Who saved most:\n\n| Editor | Saves | Last save | What changed |\n|---|---|---|---|\n| Quill Bot | [412](r2#editor=Quill Bot@n) | [this save](wiki/a.jsonl#L88) | Rewrote the intro and removed the [three cited sources](r2#row=4@n) that the talk page asked for |\n| Fern Helper | [97](r2#editor=Fern Helper@n) | [this save](wiki/a.jsonl#L91) | Small fixes |\n'
  const rec = newRecord({ row: 'r1', session: 's1', text: t })
  assert.equal(rec.marks.length, 5)
  const drawn = nodes(view.messageEl(els, { rec, key: 'm', cols: 60, first: true, theme: 'dark', focus: null, onMark: () => {} }))
  assert.ok(!drawn.some(n => n.type === 'Markdown' && /\|/.test(n.props.text)), 'no table left to Claude Code')
  // every citation is a press, and its first run has the key ] scrolls to
  const stops = drawn.filter(n => n.type === 'Button' && /^mk-r1-/.test(n.props.key)).map(n => n.props.label)
  assert.deepEqual(stops, ['cite 412', 'cite this save', 'cite three cited sources', 'cite 97', 'cite this save'])
  const cite = drawn.find(n => n.type === 'Button' && n.props.label === 'cite three cited sources')
  assert.equal(nodes(cite).find(n => n.type === 'Text').props.underline, true)
  // the header beside its cell, bold
  assert.ok(drawn.some(n => n.type === 'Text' && n.props.bold && n.props.children === 'What changed'))
})

test('`__` inside a word stays in the word, and bold closes only on the delimiter that opened it', () => {
  const run = t => inline(t, 0, t.length)
  assert.deepEqual(run('**task-alpha__goal**. It won'), [{ s: 'task-alpha__goal', b: true }, { s: '. It won' }])
  assert.deepEqual(run('kitname__specified took 1.0 h and rl-9z__specified.'), [{ s: 'kitname__specified took 1.0 h and rl-9z__specified.' }])
  assert.deepEqual(run('**a __ b** c'), [{ s: 'a __ b', b: true }, { s: ' c' }])
  assert.deepEqual(run('__d__ and _e_ f'), [{ s: 'd', b: true }, { s: ' and ' }, { s: 'e', it: true }, { s: ' f' }])
})

test('a mark wider than the line breaks at its spaces, each piece still the mark; only a word wider than the line is cut', () => {
  const heads = 'This affects every multi-line code block in a reply.'
  const lines = wrapRuns([{ s: heads, mark: 0 }], 21)
  assert.deepEqual(lines.map(l => runsText(l)), ['This affects every', 'multi-line code block', 'in a reply.'])
  assert.ok(lines.every(l => l.length === 1 && l[0].mark === 0))
  // a mark that fits stays whole on the next line; a single word wider than the line is cut by cells
  assert.deepEqual(wrapRuns([{ s: 'Mostly from ' }, { s: 'the June 18 burst', mark: 1 }], 21).map(l => runsText(l)), ['Mostly from', 'the June 18 burst'])
  assert.deepEqual(wrapRuns([{ s: 'abcdefghijklmnopqrstuvwxyz', mark: 2 }], 10).map(l => runsText(l)), ['abcdefghij', 'klmnopqrst', 'uvwxyz'])
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

test('a column of a one-row table cited as a series is drawn as one value, not a chart of one bar', () => {
  const query = { id: 'r4', about: 'all trips', keys: [], table: [{ group: 'all', n: 640, done: 211, rate: 0.33 }] }
  const card = sourceCard({ ref: 'r4@n', label: '640', resolved: { ref: 'r4@n', count: 640, rows: [], records: [], chain: [] }, query })
  assert.equal(card.parts.length, 1)
  assert.equal(card.parts[0].data.value, '640')
  assert.equal(card.parts[0].data.rows, undefined)
  // two rows are still a series
  const two = { ...query, table: [{ group: 'a', n: 400 }, { group: 'b', n: 240 }] }
  assert.deepEqual(sourceCard({ ref: 'r4@n', label: 'n', resolved: { ref: 'r4@n', rows: [], records: [], chain: [] }, query: two }).parts[0].data.rows.map(x => x.value), [400, 240])
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

test('the healing pass in a drawing: a spinner while it runs, a re-pointed citation opens its new place, one whose place is gone has a grey ?, an unwrapped one is grey, a contradicted one has a red ×', () => {
  const text = 'Busiest: [5](r1#day=a@n). Gone: [12](r9@n). Wrong: [4](r1#day=b@n). Many: [7](r1@n).'
  const rec = { ...newRecord({ row: 'x', session: 's', text }) }
  assert.equal(needsHeal(rec), true)
  const checking = healedRecord(rec, { checking: true })
  const runs = inline(text, 0, text.length, checking.marks)
  assert.equal(runs.filter(r => r.tag === 'checking').length, 4)
  assert.equal(healInput(rec), text)
  const healed = { ...rec, heal: { key: textKey(text), changes: [
    { label: '5', ref: 'r1#day=a@n', state: 'linked', how: 'cell', to: 'r1#day=c@n' },
    { label: '12', ref: 'r9@n', state: 'quiet', how: 'gone', why: 'the cited place is gone (no query r9)' },
    { label: '4', ref: 'r1#day=b@n', state: 'contradicted', how: 'contradicted', to: 'r1#day=b@n', why: 'the cited place shows 3' },
    { label: '7', ref: 'r1@n', state: 'quiet', how: 'several', why: 'several places show 7' },
  ] } }
  assert.equal(needsHeal(healed), false)
  const m = healedRecord(healed).marks
  assert.deepEqual([m[0].ref, m[0].wrote, m[1].heal, m[1].why, m[2].heal, m[2].why, m[3].heal],
    ['r1#day=c@n', 'r1#day=a@n', 'gone', 'the cited place is gone (no query r9)', 'bad', 'the cited place shows 3', 'quiet'])
  // a citation whose place is gone reads as one that failed (a grey ? after its words), never as plain grey words;
  // only a contradicted one has the red ×
  const drawn = inline(text, 0, text.length, m)
  assert.deepEqual(drawn.filter(r => r.tag).map(r => [r.s, r.tag]), [[' ?', 'gone'], [' ×', 'bad']])
  // its card in the tray says what is missing
  const f = frameOf(healedRecord(healed), 1)
  assert.deepEqual([f.heal, f.why], ['gone', 'the cited place is gone (no query r9)'])
  // a squeeze's new text is a new key: its own pass, the old result left alone
  assert.equal(needsHeal({ ...healed, shown: 'Busiest: [5](r1#day=a@n).' }), true)
})

test('an opened citation reaches Claude as written, with what the check found there', () => {
  const text = 'Kept: [5](r1#day=a@n). Moved: [6](r1#day=b@n). Wrong: [4](r1#day=c@n). Not yet: [2](r2@n).'
  const rec = { ...newRecord({ row: 'x', session: 's', text }), heal: { key: textKey(text), changes: [
    { label: '5', ref: 'r1#day=a@n', state: 'linked', how: 'kept', to: 'r1#day=a@n' },
    { label: '6', ref: 'r1#day=b@n', state: 'linked', how: 'cell', to: 'r1#day=d@n' },
    { label: '4', ref: 'r1#day=c@n', state: 'contradicted', how: 'contradicted', to: 'r1#day=c@n', why: 'the cited place shows 3' },
  ] } }
  const healed = healedRecord(rec)
  const row = i => openedRow(frameOf(healed, i)).text
  assert.equal(row(0), 'opened the citation "5" (r1#day=a@n); the citation check kept it as written')
  // the ref Claude wrote, not the place the check moved it to, and the move said
  assert.equal(row(1), 'opened the citation "6" (r1#day=b@n); the citation check re-pointed it to r1#day=d@n')
  assert.equal(row(2), 'opened the citation "4" (r1#day=c@n); the citation check found the cited place contradicts it (the cited place shows 3)')
  // a citation no check has reached yet says nothing of one
  assert.equal(openedRow(frameOf(newRecord({ row: 'y', session: 's', text: 'Not yet: [2](r2@n).' }), 0)).text, 'opened the citation "2" (r2@n)')
})

test('a squeeze and its revert keep each text\'s citation checks: the original\'s red × comes back with it', () => {
  const text = 'Wrong: [4](r1#day=b@n), and more words here.'
  const rec = remark(newRecord({ row: 'x', session: 's', text }))
  const bad = { label: '4', ref: 'r1#day=b@n', state: 'contradicted', how: 'contradicted', to: 'r1#day=b@n', why: 'the cited place shows 3' }
  const healed = withHeal(rec, textKey(text), { of: 'v1', version: 'v1', changes: [bad] })
  // the shorter version, and its own pass (which found the place holds it)
  const short = applyRewrite(healed, { text: 'Wrong: [4](r1#day=b@n).', at: { length: 0 } }, remark)
  assert.equal(needsHeal(short), true)
  const shortHealed = withHeal(short, textKey(shownOf(short)), { changes: [{ ...bad, state: 'linked', how: 'kept' }] })
  assert.equal(healedRecord(shortHealed).marks.find(m => m.kind === 'cite').heal, 'kept')
  // 0: the original again, with its own result, and no new pass
  const back = restore(shortHealed, remark)
  assert.equal(needsHeal(back), false)
  assert.deepEqual([healedRecord(back).marks.find(m => m.kind === 'cite').heal, healedRecord(back).marks.find(m => m.kind === 'cite').why], ['bad', 'the cited place shows 3'])
  // a record kept before results were kept by text reads its one result, and keeps it beside the next
  const old = { ...rec, heal: { key: textKey(text), changes: [bad] } }
  assert.equal(needsHeal(old), false)
  assert.equal(healedRecord(restore(withHeal(applyRewrite(old, { text: 'Wrong: [4](r1#day=b@n).', at: { length: 0 } }, remark), textKey('Wrong: [4](r1#day=b@n).'), { changes: [] }), remark)).marks.find(m => m.kind === 'cite').heal, 'bad')
})

test('an explainer and a re-pointed citation\'s card show what the healing pass did: grey with a ? when its place is gone, ×, the new place, and where it was moved from', async () => {
  const gloss = { term: 'edits', body: 'Wren made [7](r1#day=a@n) edits, [12](r9@n) in all, and [4](r1#day=b@n) reverts.' }
  const heal = { changes: [
    { label: '7', ref: 'r1#day=a@n', state: 'linked', how: 'cell', to: 'r1#day=c@n' },
    { label: '12', ref: 'r9@n', state: 'quiet', how: 'gone' },
    { label: '4', ref: 'r1#day=b@n', state: 'contradicted', how: 'contradicted', to: 'r1#day=b@n', why: 'the cited place shows 3' },
  ] }
  const card = explainerCard({ gloss, heal })
  const text = card.parts[0].data.text
  assert.ok(text.includes('{dim:12}{dim: ?}') && text.includes('{bad: ×}'))
  assert.deepEqual(card.links.map(l => l.ref), ['r1#day=c@n', 'r1#day=b@n'])
  assert.equal(healMd('see [it](auth.py:88)'), 'see [it](auth.py#L88)')
  const rec = { ...newRecord({ row: 'x', session: 's', text: 'Wren made [7](r1#day=a@n) edits.' }) }
  const healed = healedRecord({ ...rec, heal: { key: textKey(rec.text), changes: [heal.changes[0]] } })
  const f = frameOf(healed, 0)
  assert.deepEqual([f.ref, f.heal, f.wrote], ['r1#day=c@n', 'moved', 'r1#day=a@n'])
})

test('a heads-up whose words hold an explainer\'s term keeps its mark, and the explainer stands where its term is said again', () => {
  const text = 'Each surge came from more than a hundred different network ranges. Later, the network ranges are the better clue.'
  const glosses = { ...glossesOf([{ term: 'network ranges', body: 'An address cut to its first two numbers.' }], text), ...headsOf({ term: 'more than a hundred different network ranges', title: 'Most ranges may be one provider', bullets: ['Addresses that start with 20. made most edits.'] }, text) }
  const rec = withObserver(newRecord({ row: 'r1', session: 's', text }), { verbs: {}, glosses })
  const at = id => rec.marks.find(m => m.gloss === id)
  assert.equal(text.slice(at('h1').start, at('h1').end), 'more than a hundred different network ranges')
  assert.equal(text.slice(at('g1').start, at('g1').end), 'network ranges')
  assert.ok(at('g1').start > at('h1').end)
})

test('a heads-up whose words the reader sees across a citation and a code span stands on them, outside the link', () => {
  const text = 'So [5](r7#n=files@n) of the 13 files in `src/notes` mention citations, and the rest do not.'
  const glosses = headsOf({ term: '5 of the 13 files in src/notes mention citations', title: 'Few files mention it', bullets: ['Only five do.'] }, text)
  assert.deepEqual(Object.keys(glosses), ['h1'])
  const rec = withObserver(newRecord({ row: 'r1', session: 's', text }), { verbs: {}, glosses })
  const h = rec.marks.find(m => m.gloss === 'h1')
  const cite = rec.marks.find(m => m.kind === 'cite')
  assert.equal(text.slice(h.start, h.end), 'of the 13 files in `src/notes` mention citations')
  assert.ok(h.start >= cite.end)
  // drawn as the reader reads it: the citation's words, then the heads-up's words without backticks
  assert.equal(runsText(inline(text, 0, text.length, rec.marks)), 'So 5 of the 13 files in src/notes mention citations, and the rest do not.')
})

test('] stops at the newest reply\'s last stop and [ at the oldest reply\'s first: neither runs on into the other end', () => {
  const list = [{ row: 'r1', i: 0 }, { row: 'r1', i: 1 }, { row: 'r2', i: 0 }, { row: 'r2', card: { id: 'c1' } }]
  assert.deepEqual(stepFrom(list, 2, 1), { row: 'r2', card: { id: 'c1' } })
  assert.equal(stepFrom(list, 3, 1), null)
  assert.equal(stepFrom(list, 0, -1), null)
  assert.equal(step(order([{ row: 'r1', marks: [{}] }, { row: 'r2', marks: [{}, {}] }]), { row: 'r2', i: 1 }, 1), null)
})

test('a citation whose place goes away after its check: its card names the ref once and says what is missing, and its mark is drawn gone', () => {
  const ref = 'r21#sex=male&class=1@survived'
  const card = sourceCard({ ref, label: '5', resolved: { ref, error: `${ref}: no query r21` } })
  assert.deepEqual([card.unresolved, card.gone, card.parts.length, card.right], [true, 'no query r21', 0, `cite · ${ref}`])
  const k = { text: s => s, escape: s => s }
  const text = 'Men with a title: [5](' + ref + ') survived.'
  const rec = remark(newRecord({ row: 'x', session: 's', text }))
  const checked = withHeal(rec, textKey(text), { changes: [{ label: '5', ref, state: 'linked', how: 'kept', to: ref }] })
  const top = frameOf(healedRecord(checked), 0)
  const body = cardBody(k, card, top, null)
  assert.deepEqual(body, ['{dim:? the cited place is gone (no query r21)}'])
  assert.equal([card.right, ...body].join('\n').split(ref).length - 1, 1)
  // the card's finding is kept in the record: the mark has the grey ? of a citation that failed, once
  const gone = withGone(checked, ref, card.gone)
  const m = healedRecord(gone).marks.find(x => x.kind === 'cite')
  assert.deepEqual([m.heal, m.why], ['gone', 'the cited place is gone (no query r21)'])
  assert.equal(withGone(gone, ref, card.gone), null)
  // a text no pass has read is left to its pass
  assert.equal(withGone(rec, ref, card.gone), null)
})
