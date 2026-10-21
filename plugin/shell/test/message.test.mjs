// The citation format in a message (shell/message.js): the marks Claude wrote as offsets into its markdown, and a
// citation's healing as its card draws it (shell/cards.js). node --test plugin/shell/test/message.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { citeCard, citedForm, citeWords, distinctCut, drawnCard, drawsHyperlinks, explainerCard, fileLink, healMd, inForm, linksIn, placeOf, sourceCard } from '../cards.js'
import { linkRuns } from '../carddetail.js'
import { askedRow, engagedText, openedRow } from '../engaged.js'
import { anchorTerm, blocks, findInLink, findTerm, glossesOf, headsOf, healInput, healedRecord, inline, lineOf, linkMarks, marksIn, needsHeal, newRecord, plainWords, placeMarks, recordFor, remark, runsText, seriesRef, shownOf, sparkChars, stemOf, tableOf, textKey, verbsOf, withCheck, withGone, withHeal, withObserver, wrapRuns } from '../message.js'
import { applyRewrite, restore } from '../../squeeze/chips.mjs'
import { back, base, open, order, push, step, stepFrom, top } from '../tray.js'
import { citeRef } from '../object.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { cardBody, cutTitle, frameOf, placeWords } from '../../panes/tray.js'

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

test('a link target in angle brackets, as markdown writes one with spaces, is a citation without the brackets', () => {
  const text = 'The other days had [3,693](<r9#span=other days@n>) edits.'
  const [m] = linkMarks(text)
  assert.equal(m.kind, 'cite')
  assert.equal(m.ref, 'r9#span=other days@n')
  assert.equal(m.label, '3,693')
  assert.equal(text.slice(m.start, m.end), '[3,693](<r9#span=other days@n>)')
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

test('a line with a citation cuts its words at the end when its column narrows, never wraps them in narrow columns', { skip: !view && 'this Node runs no TypeScript' }, () => {
  const t = 'Most saves came from **Quill Bot**: [412](r2#editor=Quill Bot@n) of them, then Fern Helper with a few.'
  const rec = newRecord({ row: 'r1', session: 's1', text: t })
  const drawn = nodes(view.messageEl(els, { rec, key: 'm', cols: 60, first: true, theme: 'dark', focus: null, onMark: () => {} }))
  const kids = n => [n.props.children].flat().filter(k => k && typeof k === 'object')
  const rows = drawn.filter(n => n.type === 'Box' && n.props.flexDirection === 'row' && kids(n).some(k => k.type === 'Button' && /^mk-/.test(k.props.key)))
  assert.ok(rows.length >= 1)
  const words = rows.flatMap(r => kids(r).filter(k => k.type === 'Text'))
  assert.ok(words.length >= 2)
  for (const w of words) assert.equal(w.props.wrap, 'truncate-end')
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

test('a cited value shows as the reply wrote it: a share as a percent with its digits, never rounded away', () => {
  // made-up eval files: a share column, cited as percents
  const query = { id: 'r7', about: 'win rate per eval file', keys: ['system'], table: [
    { system: 'base_eval', win_rate: 0.0037, games: 272 }, { system: 'base_train', win_rate: 0, games: 320 },
    { system: 'tuned_eval', win_rate: 0.055, games: 200 }, { system: 'tuned_train', win_rate: 0.97753, games: 320 }] }
  const cell = (ref, label) => {
    const { rows, hotCol } = sourceCard({ ref, label, resolved: { ref, count: 0, rows: [], records: [], chain: [] }, query }).parts[0].data
    return { hot: rows.find(r => r.hot).cells[hotCol], col: rows.map(r => r.cells[hotCol]) }
  }
  // 0.4% written for 0.0037: 0.37%, not 0; the whole column in the same form
  assert.deepEqual(cell('r7#system=base_eval@win_rate', '0.4%'), { hot: '0.37%', col: ['0.37%', '0.0%', '5.5%', '97.8%'] })
  assert.equal(cell('r7#system=tuned_eval@win_rate', '5.5%').hot, '5.5%')
  assert.equal(cell('r7#system=tuned_train@win_rate', '97.75%').hot, '97.75%')
  // words that write no number the value rounds to: the value with two significant digits, never 0 for 0.0037
  assert.equal(cell('r7#system=base_eval@win_rate', 'almost never').hot, '0.0037')
  assert.equal(citedForm(0.0037, '9%'), null)
  assert.deepEqual(citedForm(1268, '1,268 files'), { scale: 1, d: 0, pct: false })
  assert.equal(inForm(0.3489, citedForm(0.3489, 'cut it from 35% to 2.8%')), '35%')
  // one value alone reads the same way
  const one = sourceCard({ ref: 'r8@share', label: '2.6%', resolved: { ref: 'r8@share', rows: [], records: [], chain: [] }, query: { id: 'r8', table: [{ share: 0.0257 }] } })
  assert.equal(one.parts[0].data.value, '2.6%')
})

test('long names in a tray table are cut where the rows still differ, and shown whole where there is room', () => {
  // made-up revert pairs: the first words of two rows are the same
  const pairs = [['Alpha13 reverted Bravo771', 82], ['Bravo771 reverted Alpha13', 82], ['Alpha13 reverted Charliex', 69], ['Bravo771 reverted Charliex', 48]]
  const query = { id: 'r3', about: 'who reverted whom', keys: ['pair'], table: pairs.map(([pair, n], i) => ({ pair, n, index: 90 + i })) }
  const card = sourceCard({ ref: 'r3#pair=Bravo771 reverted Alpha13@n', label: '82', resolved: { ref: 'r3', count: 0, rows: [], records: [], chain: [] }, query })
  const rowsAt = w => gridText(draw(card.parts[0], w)).split('\n').map(l => l.trim()).filter(l => /\d$/.test(l) && !l.startsWith('pair'))
  // room enough: every name whole
  assert.ok(pairs.every(([p]) => rowsAt(60).some(l => l.includes(p))), rowsAt(60).join('\n'))
  // too little room: the column is cut, and the four rows still read four different ways, each name's end kept
  const narrow = rowsAt(28).map(l => l.replace(/^▌\s*/, '').replace(/\s+\d+\s+\d+$/, ''))
  assert.equal(new Set(narrow).size, 4, narrow.join('\n'))
  assert.ok(narrow.some(l => l.endsWith('Alpha13')) && narrow.some(l => l.endsWith('Bravo771')), narrow.join('\n'))
  // the cut alone: at the end when that keeps values apart, else in the middle
  assert.deepEqual(distinctCut(['abcdefgh', 'xyzdefgh'], 5), ['abcd…', 'xyzd…'])
  assert.deepEqual(distinctCut(['abcdefgh', 'abcdxyzq'], 5), ['a…fgh', 'a…yzq'])
})

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

test("a code citation's preview keeps every line's indent: the cited lines and the lines around them", () => {
  const lines = [
    { n: 10, text: 'def walk(node):' },
    { n: 11, text: '    if node is None:' },
    { n: 12, text: '        return 0' },
    { n: 13, text: '\tfor kid in node.kids:' },
    { n: 14, text: '        total += walk(kid)' },
    { n: 15, text: '    return total' },
  ]
  // the kernel's span of a quote, and the code file's lines read by the card: both keep the spaces
  for (const card of [
    sourceCard({ ref: 'pkg/tree.py#L12-13', label: 'the base case', resolved: { span: { rows: lines.map(l => ({ ...l, hot: l.n === 12 || l.n === 13 })), cited: 2 } } }),
    sourceCard({ ref: 'pkg/tree.py#L12-13', label: 'the base case', resolved: {}, lines }),
  ]) {
    const t = gridText(draw(card.parts[0], 60, 12)).split('\n').map(l => l.trimEnd())
    assert.deepEqual(t.slice(0, 6), [
      '10   def walk(node):',
      '11       if node is None:',
      '12 ▌         return 0',
      '13 ▌     for kid in node.kids:',
      '14           total += walk(kid)',
      '15       return total',
    ])
  }
})

test("a citation's rows section, when asked for, names the cited files' own entries: records, rows or lines, and none for a whole file", () => {
  const query = { id: 'q4', about: 'survivors by class and sex', keys: ['class', 'sex'], table: [{ class: 3, sex: 'male', n: 347 }, { class: 1, sex: 'female', n: 94 }] }
  const ofRecords = { count: 347, rows: ['revisions.jsonl#L1-347'], records: [], chain: [], unit: 'records', unit_one: 'record' }
  // by default the card has the code section alone
  assert.deepEqual(sourceCard({ ref: 'q4#class=3,sex=male@n', label: 'class 3 male', resolved: ofRecords, query }).sections.map(x => x.id), ['code'])
  const card = sourceCard({ ref: 'q4#class=3,sex=male@n', label: 'class 3 male', resolved: ofRecords, query, rows: true })
  const rows = card.sections.find(x => x.id === 'rows')
  assert.equal(rows.key, 'r')
  assert.equal(rows.words, 'records')
  assert.match(rows.parts[0].data.head, /^\*\*347\*\* records of revisions\.jsonl behind /)
  const csv = sourceCard({ ref: 'q4#class=3,sex=male@n', label: 'class 3 male', resolved: { ...ofRecords, rows: ['titanic.csv#L2-348'], unit: 'rows', unit_one: 'row' }, query, rows: true })
  assert.equal(csv.sections.find(x => x.id === 'rows').words, 'rows')
  // whole files with no entries (an image, a PDF): no rows section, the code section still there
  const img = sourceCard({ ref: 'q4#class=3,sex=male@n', label: 'class 3 male', resolved: { ...ofRecords, rows: ['chart.png'], unit: null, unit_one: null }, query, rows: true })
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

test('a result an older version of the check kept is checked again, and the marks it placed are placed again', () => {
  const text = 'Busiest: [5](r1#day=a@n). Many: [7](r1@n).'
  const moved = { label: '5', ref: 'r1#day=a@n', state: 'linked', how: 'cell', to: 'r5#day=a@n' }
  // kept by a version that wrote no `check`, its marks one short and placed by that version
  const old = withHeal({ ...newRecord({ row: 'x', session: 's', text }), marks: newRecord({ row: 'x', session: 's', text }).marks.slice(0, 1) }, textKey(text), { changes: [moved] })
  assert.equal(healedRecord(old).marks[0].heal, 'moved')
  const now = withCheck(old, 'c2')
  // the old result is gone, so the text is checked again and the old re-pointing is not drawn
  assert.equal(needsHeal(now), true)
  assert.equal(healedRecord(now).marks[0].heal, undefined)
  assert.equal(healedRecord(now).marks[0].ref, 'r1#day=a@n')
  assert.equal(now.marked, 'c2')
  assert.equal(now.marks.filter(m => m.kind === 'cite').length, 2)
  // the new pass's result names its version: it stands, and the record is the same one
  const again = withHeal(now, textKey(text), { changes: [{ ...moved, to: 'r1#day=a@n', how: 'kept' }], check: 'c2' })
  assert.equal(withCheck(again, 'c2'), again)
  assert.equal(needsHeal(withCheck(again, 'c2')), false)
  // a newer version checks it again; with no version known, the kept result stands
  assert.equal(needsHeal(withCheck(again, 'c3')), true)
  assert.equal(withCheck(old, null), old)
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

test('a tray title and a record\'s place keep their line number whole and lose the start of the path first', () => {
  assert.equal(cutTitle('engine/kernel/lineage.py:463', 20), '…rnel/lineage.py:463')
  assert.ok(cutTitle('engine/kernel/lineage.py:463', 20).endsWith('lineage.py:463'))
  assert.equal(cutTitle('runs/abcdef0123456789.jsonl#L20288', 18), '…6789.jsonl#L20288')
  assert.equal(cutTitle('the swarm stalled on day two', 12), 'the swarm s…')
  // a record whose place is long, beside long words: the place stays whole, never "lineage.py#L…"
  const recs = { count: 1, records: [{ ref: 'engine/kernel/lineage.py#L463', text: 'def resolve(st: Store, ref: str, n: int = 5, pick: str = "spread", label: str | None = None) -> dict[str, Any]:' }], chain: [] }
  const card = sourceCard({ ref: 'engine/kernel/lineage.py:463', label: 'engine/kernel/lineage.py:463', resolved: recs })
  const out = gridText(draw(card.parts[0], 70))
  assert.ok(out.includes('lineage.py#L463'), out)
  const long = { count: 1, records: [{ ref: 'agents/agent-05/session-abcdef0123456789abcdef.jsonl#L20288', text: 'pushed the branch again after the reviewer asked for a smaller change set and more tests' }], chain: [] }
  assert.ok(gridText(draw(sourceCard({ ref: "x", label: "x", resolved: long }).parts[0], 70)).includes("#L20288"))
})

test('a code path written from the folder Claude ran cd into opens its place with no moved note', () => {
  const text = 'The turn ends [here](util/clock.ts#L12).'
  const rec = remark(newRecord({ row: 'x', session: 's', text }))
  const checked = withHeal(rec, textKey(text), { changes: [{ label: 'here', ref: 'util/clock.ts#L12', state: 'linked', how: 'folder', to: 'app/util/clock.ts#L12' }] })
  const top = frameOf(healedRecord(checked), 0)
  assert.equal(top.ref, 'app/util/clock.ts#L12')
  assert.equal(top.heal, 'kept')
  assert.equal(top.wrote, undefined)
  assert.deepEqual(cardBody({ text: s => s, escape: s => s }, { drawings: [] }, top, null), [])
  // a mistyped path the pass re-pointed to its sibling still says where it pointed
  const typo = withHeal(rec, textKey(text), { changes: [{ label: 'here', ref: 'util/clock.ts#L12', state: 'linked', how: 'path', to: 'util/clocks.ts#L12' }] })
  assert.equal(frameOf(healedRecord(typo), 0).heal, 'moved')
  // a card's words: the link opens the place, with no `wrote`
  const links = linksIn('See [here](util/clock.ts#L12).', () => ({ label: 'here', ref: 'util/clock.ts#L12', state: 'linked', how: 'folder', to: 'app/util/clock.ts#L12' }))
  assert.equal(links[0].ref, 'app/util/clock.ts#L12')
  assert.equal(links[0].wrote, undefined)
})

test('a re-pointed citation\'s card says where it pointed in words, never in the ref\'s own syntax', () => {
  const text = 'Kestrel made [41](r2#user=Kestrel%20B@n) edits.'
  const rec = remark(newRecord({ row: 'x', session: 's', text }))
  const checked = withHeal(rec, textKey(text), { changes: [{ label: '41', ref: 'r2#user=Kestrel%20B@n', state: 'linked', how: 'cell', to: 'r2#user=Wren@n', source: '12' }] })
  const top = frameOf(healedRecord(checked), 0)
  const k = { text: s => s, escape: s => s }
  const body = cardBody(k, { drawings: [] }, top, null)
  // it says the citation was corrected, and what the place as written shows: no wording of an error
  assert.deepEqual(body, ['{dim:corrected: the citation pointed at the row with user Kestrel B (column n), which shows 12}'])
  // a quote the pass found on another line of the same file
  const qt = 'The goal was ["Each agent: do well"](goals.jsonl#L50).'
  const qrec = withHeal(remark(newRecord({ row: 'y', session: 's', text: qt })), textKey(qt), { changes: [{ label: '"Each agent: do well"', ref: 'goals.jsonl#L50', state: 'linked', how: 'quote', to: 'goals.jsonl#L23' }] })
  const qtop = frameOf(healedRecord(qrec), 0)
  assert.equal(qtop.ref, 'goals.jsonl#L23')
  assert.deepEqual(cardBody(k, { drawings: [] }, qtop, null), ['{dim:corrected: the citation pointed at goals.jsonl:50, which does not hold these words}'])
  assert.ok(!/r2|#|@/.test(body[0]))
  assert.equal(placeWords('r5#team=north&day=mon@edits'), 'the row with team north and day mon (column edits)')
  assert.equal(placeWords('r5#row=3@edits'), "row 3 of a query's result (column edits)")
  assert.equal(placeWords('r5@edits'), "column edits of a query's result")
  assert.equal(placeWords('q7'), "a query's whole result")
  assert.equal(placeWords('card:ab12#/rows/0/n'), 'a value of another card')
  assert.equal(placeWords('logs/edits.jsonl#L41'), 'logs/edits.jsonl:41')
  assert.equal(placeWords('runs.csv#row=3'), 'runs.csv row 3')
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

test('a whole file\'s card counts its lines as the file has them: the newline that ends it starts no line', async () => {
  const io = { resolve: async () => ({}), read: async () => 'one\ntwo\nthree\n' }
  const card = await citeCard({ ref: 'notes/plan.md', label: 'the plan', root: '/data', room: 2 }, io)
  assert.equal(card.parts[0].data.more, 'the first 2 of its 3 lines')
  const all = await citeCard({ ref: 'notes/plan.md', label: 'the plan', root: '/data', room: 9 }, io)
  assert.equal(all.parts[0].data.rows.length, 3)
  assert.equal(all.parts[0].data.more, '')
})
