// Pages: a card whose knob turns pages (chapters of a guide) is read one page at a time or every page at once, its keys
// are named by what they do, and its versions count only as the person saw them. node --test draw/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../kit.js'
import { allKnob, ownPart, pageAt, pageId, pageKnob, pageOf, turn } from '../handoff.js'
import { runProgram } from '../sandbox-node.mjs'
import { gridText, renderTerm } from '../term.js'
import { actionsOf, barText, keysOf } from '../../panes/host.js'
import PANES from '../../panes/index.js'
import { editsOf, stepVersion } from '../../shell/carddetail.js'

// a made-up guide in three chapters, written as the guide that started this was: a chapter knob shown as "2 of 3", its
// own keys n and p labelled alike, and parts whose ids repeat from chapter to chapter
const GUIDE = {
  id: '01-orchard', title: 'The orchard in three chapters',
  program: `
const CH = data.chapters
const ch = k.knob('chapter', { values: CH.map((_, i) => i + 1), at: 1, label: 'chapter', fmt: v => v + ' of ' + CH.length })
k.on('n', () => ({ chapter: Math.min(CH.length, ch + 1) }), 'chapter')
k.on('p', () => ({ chapter: Math.max(1, ch - 1) }), 'chapter')
k.on('press:tree-0', () => ({ picked: CH[ch - 1].title }))
const C = CH[ch - 1]
k.cite('count', { text: C.trees.length + ' trees', rows: C.trees.map(t => ({ name: t })) })
return k.stack(
  k.beside(k.text('**' + C.title + '**', { wrap: false }), k.dial('chapter', { label: false }), { gap: 2 }),
  k.text('[' + C.trees.length + ' trees](#count) in [this row](#tree-0).'),
  ...C.trees.map((t, i) => k.region('tree-' + i, { label: t, ref: 'trees.csv#L' + (i + 2) }, k.text(t))),
  { gap: 1 })`,
  data: { chapters: [
    { title: 'Apples', trees: ['Bramley', 'Cox'] },
    { title: 'Pears', trees: ['Conference', 'Comice', 'Williams'] },
    { title: 'Plums', trees: ['Victoria'] },
  ] },
}

test('a knob of pages is known by its name, its "2 of 3" values or pages: true, and pages: false keeps any knob from being one', () => {
  const knob = (o, label = 'x') => runProgram({ program: `const v = k.knob(${JSON.stringify(label)}, ${JSON.stringify(o)}); return k.text(String(v))` }, { w: 40 }).controls[0]
  assert.equal(knob({ values: [1, 2, 3] }, 'chapter').pages, true)
  assert.equal(knob({ values: ['a', 'b'] }, 'Slides').pages, true)
  assert.equal(knob({ values: [1, 2, 3] }, 'step').pages, undefined, 'a step of a run is no page')
  assert.equal(knob({ values: [1, 2, 3], pages: true }, 'view').pages, true)
  assert.equal(knob({ values: [1, 2, 3], pages: false }, 'chapter').pages, undefined)
  assert.equal(knob({ values: [1] }, 'page').pages, undefined, 'one value is no pages')
  assert.equal(pageKnob(runProgram(GUIDE, { w: 60 })).id, 'chapter')
})

test('each key says which knob it turns and which way, so the bar reads "n next chapter · p previous chapter", at either end too', () => {
  for (const chapter of [1, 2, 3]) {
    const d = runProgram(GUIDE, { w: 60, state: { chapter } })
    assert.deepEqual(d.on.filter(h => h.turn).map(h => [h.name, h.turn.knob, h.turn.dir]), [['n', 'chapter', 1], ['p', 'chapter', -1]], `at ${chapter}`)
    assert.equal(barText([d]), 'n next chapter · p previous chapter')
    // the probe kept nothing: no state, no warning, and the card drew at its own chapter
    assert.equal(d.controls[0].i, chapter - 1)
    assert.deepEqual(d.warnings, [])
  }
  // a label that says the way already is kept; a key that turns nothing is named as the program named it
  assert.deepEqual(keysOf({ on: [{ name: 'j', label: 'next run', turn: { knob: 'run', dir: 1 } }, { name: 'f', label: 'flip' }] }), [{ key: 'j', words: 'next run' }, { key: 'f', words: 'flip' }])
  // a key the card above takes is not named again below it, even inside a group of keys
  assert.equal(barText([{ on: [{ name: 'p', label: 'previous chapter' }] }, { on: [{ name: 'p', label: 'program' }, { name: '[', label: 'flip' }, { name: ']', label: 'flip' }] }]), 'p previous chapter · [ ] flip')
})

test('every page at once: each page under its heading, its parts and cites its own, the dial only words, in both renderers', () => {
  const d = runProgram(GUIDE, { w: 60, mode: 'detail', all: true, state: { chapter: 2 } })
  assert.equal(d.error, undefined)
  assert.deepEqual(d.pages, { knob: 'chapter', n: 3, at: 2 })
  assert.equal(allKnob(d).id, 'chapter')
  const t = renderTerm(d, { w: 60 })
  const text = gridText(t)
  assert.match(text, /── chapter 1 of 3 ─+\n\nApples {2}1 of 3/)
  assert.match(text, /── chapter 2 of 3 ─+[\s\S]*Comice[\s\S]*── chapter 3 of 3 ─+[\s\S]*Victoria/)
  assert.ok(!text.includes('◂'), 'a page names itself; its headings turn it')
  // a part on every page is a part of each page; the headings are parts too, in reading order
  assert.deepEqual(t.regions.filter(r => !r.link).map(r => r.id), ['pg1~~', 'pg1~~tree-0', 'pg1~~tree-1', 'pg2~~', 'pg2~~tree-0', 'pg2~~tree-1', 'pg2~~tree-2', 'pg3~~', 'pg3~~tree-0'])
  assert.equal(t.regions.find(r => r.id === 'pg2~~').meta.label, 'chapter 2 of 3')
  assert.deepEqual(t.regions.find(r => r.id === 'pg2~~tree-1').meta.ref, 'trees.csv#L3')
  // a link to a part or a cite goes to that page's: each page's cite says its own count
  assert.equal(d.cites['pg1~~count'].text, '2 trees')
  assert.equal(d.cites['pg2~~count'].text, '3 trees')
  assert.ok(t.regions.some(r => r.id === 'pg2~~count' && r.link))
  // a page's part read back as the card's own: its id, the knob at its page; a heading is its page
  assert.deepEqual(pageOf('pg2~~tree-1'), { page: 2, id: 'tree-1' })
  assert.deepEqual(ownPart(d, 'pg3~~tree-0'), { region: 'tree-0', state: { chapter: 3 } })
  assert.deepEqual(ownPart(d, pageId(1)), { region: null, state: { chapter: 1 } })
  assert.deepEqual(ownPart(d, 'tree-0'), { region: 'tree-0', state: null })
  assert.equal(pageAt(allKnob(d), 3), 3)
})

test('every page at once answers as each page would: a press on page 3 runs at page 3, a key at the page the card is at', () => {
  const press = runProgram(GUIDE, { w: 60, mode: 'detail', all: true, state: { chapter: 1 }, event: { type: 'press', region: 'pg2~~tree-0' } })
  assert.equal(press.handled, 'press:tree-0')
  assert.deepEqual(press.state, { chapter: 2, picked: 'Pears' })
  assert.equal(press.pages.at, 2)
  const key = runProgram(GUIDE, { w: 60, mode: 'detail', all: true, state: { chapter: 2 }, event: { type: 'key', key: 'n', region: 'tree-0' } })
  assert.deepEqual(key.state, { chapter: 3 })
  // a press on a heading turns to its page and runs no handler
  const head = runProgram(GUIDE, { w: 60, mode: 'detail', all: true, state: { chapter: 1 }, event: { type: 'press', region: 'pg3~~' } })
  assert.equal(head.handled, undefined)
  assert.deepEqual(head.state, { chapter: 3 })
  // one page at a time, the card is as it was
  const one = runProgram(GUIDE, { w: 60, mode: 'detail', state: { chapter: 2 } })
  assert.equal(one.pages, undefined)
  assert.match(gridText(renderTerm(one, { w: 60 })), /^Pears {2}◂ 2 of 3 ▸/)
  assert.deepEqual(turn(one, { chapter: 2 }, 'chapter', 1), { chapter: 3 })
})

test('the detail shows every page at once from the one the card is at, and a part named from outside finds its page; one page at a time, a page\'s part is the card\'s own', () => {
  const store = (drawing, state) => PANES.detail.data({ 'card:01-orchard': { object: GUIDE, drawing, versions: [{ v: 1 }], v: 1, state } }, { id: '01-orchard' }, { w: 90, h: 30 })
  const run = (data, o = {}) => globalThis.DrawKit.run(PANES.detail.program, data, { w: 90, h: 30, mode: 'pane', ...o })
  const all = store(runProgram(GUIDE, { w: 80, mode: 'detail', all: true, state: { chapter: 2 } }), { chapter: 2 })
  // at rest: the heading of the page the card is at
  const d = run(all)
  assert.equal(d.selected, 'pg2~~')
  // the detail names no key of its own: the pages turn by the card's own dial and keys, or a press on a heading
  assert.equal(barText([d]), 'esc back')
  // the card's own part, named from outside, is that part on the page the card is at
  assert.equal(run(all, { state: { region: 'tree-2' } }).selected, 'pg2~~tree-2')
  const one = store(runProgram(GUIDE, { w: 80, mode: 'detail', state: { chapter: 2 } }), { chapter: 2 })
  assert.equal(run(one, { state: { region: 'pg2~~tree-1', pages: 'one' } }).selected, 'tree-1')
})

test('versions: none listed by number; the card as first made and after each change the analyst asked for, which Earlier version steps through', () => {
  const o = { version: 7, history: [1, 2, 3, 4, 5, 6, 7].map(v => ({ v, at: String(v) })) }
  // no change the analyst asked for: nothing to step through, whatever the kernel kept
  assert.deepEqual(editsOf(o, []), [])
  // changes that began at v4 and v6: as first made (v3, its first turn's last save), after change 1 (v5), now (v7)
  const vs = editsOf(o, [6, 4, 4, 9])
  assert.deepEqual(vs, [{ v: 3, n: 0 }, { v: 5, n: 1 }, { v: 7, n: 2 }])
  assert.equal(stepVersion(vs, 7), 5)
  assert.equal(stepVersion(vs, 3), 7)
  // the subject: no number; "edited" at the card now, where it stands when stepped back; a step is an action in words
  const data = PANES.detail.data({ 'card:01-orchard': { object: GUIDE, drawing: runProgram(GUIDE, { w: 80, mode: 'detail' }), versions: vs, v: 7, state: {} } }, { id: '01-orchard' }, { w: 90, h: 30 })
  const line = d => gridText(renderTerm(d, { w: 90 })).split('\n')[1]
  const now = globalThis.DrawKit.run(PANES.detail.program, data, { w: 90, h: 30, mode: 'pane' })
  assert.match(line(now), /^▎ card · edited\s*$/)
  assert.ok(!/\bv\d/.test(line(now)), line(now))
  assert.deepEqual(actionsOf(now).map(a => a.words), ['Rows', 'Code', 'Earlier version'])
  assert.deepEqual(globalThis.DrawKit.run(PANES.detail.program, data, { w: 90, h: 30, mode: 'pane', event: { type: 'act:version' } }).effects, [{ v: 5, do: 'version' }])
  assert.match(line(globalThis.DrawKit.run(PANES.detail.program, { ...data, v: 5 }, { w: 90, h: 30, mode: 'pane' })), /after change 1\s*$/)
  const first = globalThis.DrawKit.run(PANES.detail.program, { ...data, v: 3 }, { w: 90, h: 30, mode: 'pane' })
  assert.match(line(first), /as first made\s*$/)
  assert.deepEqual(actionsOf(first).map(a => a.words), ['Rows', 'Code', 'Newest version'])
  // a card never changed so: no word in the subject, and no version action
  const plain = globalThis.DrawKit.run(PANES.detail.program, { ...data, versions: [] }, { w: 90, h: 30, mode: 'pane' })
  assert.ok(!/edited|first made/.test(line(plain)))
  assert.deepEqual(actionsOf(plain).map(a => a.words), ['Rows', 'Code'])
})

test('a page heading is its value when the value is words; a knob only one page has is still a knob of the card', () => {
  const book = {
    program: `
const p = k.knob('page', { values: [0, 1, 2], label: 'page', fmt: v => v ? 'chapter ' + v + ' of 2' : 'contents' })
const parts = [k.text('**' + (p ? 'Chapter ' + p : 'Contents') + '**')]
if (p === 2) { const s = k.knob('step', { values: [0, 1, 2], label: 'step' }); parts.push(k.dial('step'), k.region('box-' + s, { label: 'box ' + s }, k.text('box ' + s))) }
return k.stack(...parts)`,
    data: {},
  }
  const d = runProgram(book, { w: 50, mode: 'detail', all: true })
  const t = renderTerm(d, { w: 50 })
  assert.deepEqual(t.regions.filter(r => /~~$/.test(r.id)).map(r => r.meta.label), ['contents', 'chapter 1 of 2', 'chapter 2 of 2'])
  // page 2's step: its dial is the knob's, and turning it draws page 2 at the new step
  assert.deepEqual(d.controls.map(c => c.id), ['page', 'step'])
  assert.ok(t.regions.some(r => r.id === 'step' && r.meta.knob === 'step'))
  const turned = runProgram(book, { w: 50, mode: 'detail', all: true, state: turn(d, {}, 'step', 1) })
  assert.match(gridText(renderTerm(turned, { w: 50 })), /box 1/)
})
