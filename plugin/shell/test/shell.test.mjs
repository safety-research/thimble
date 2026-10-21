// The shell's Node side: what the shell says of an object, and the drawing a child prepares.
//   node --test shell/test/shell.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { barParts, isRef, objectRefs, partLines, recordRefs, regionRefs, rowByName, splitsNote } from '../object.js'
import { viewMade } from '../visualize.js'
import { prep } from '../node/prep.mjs'
import { bodyRows, frameLines } from '../cardframe.js'
import { gridText, renderTerm } from '../../draw/term.js'

const OBJ = {
  id: '01-saves', version: 1, title: 'Saves',
  data: { days: [{ day: '2026-06-17', n: 3, _rows: ['r.jsonl#L1-3'] }, { day: '2026-06-18', n: 2, _rows: ['r.jsonl#L4-5'] }] },
  lineage: { cites: [{ ref: 'q1#day=2026-06-18@n', label: '2' }, { ref: 'not a ref', label: 'x' }] },
}
const DRAWING = {
  regions: [
    { id: 'named', meta: { ref: 'q1#day=2026-06-17@n' } },
    { id: 'viacite', meta: { cite: 'c1' } },
    { id: 'day-2026-06-18', meta: { label: 'Jun 18', examples: 'ex' } },
    { id: 'nothing', meta: {} },
  ],
  cites: { c1: { text: 't', ref: ['obj:01-saves#/days/0/n'] } },
  examples: { ex: { total: 2, records: [{ ref: 'r.jsonl#L4', text: 'four' }, { text: 'no ref' }] } },
}

test('a region rests on the refs the program named, or on the data row its id names, never on a guess between two', () => {
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'named'), { refs: ['q1#day=2026-06-17@n'], how: 'named' })
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'viacite').refs, ['obj:01-saves#/days/0/n'])
  const m = regionRefs(OBJ, DRAWING, 'day-2026-06-18')
  assert.deepEqual(m.refs, ['obj:01-saves#/days/1'])
  assert.match(m.how, /matched by name: day = 2026-06-18/)
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'nothing').refs, [])
  const twins = { id: 'o', data: { a: [{ k: 'xy', _rows: ['f#L1'] }, { k: 'xy', _rows: ['f#L2'] }] } }
  assert.equal(rowByName(twins, 'part-xy'), null)
  assert.deepEqual(recordRefs(DRAWING, 'day-2026-06-18'), [{ ref: 'r.jsonl#L4', text: 'four' }])
  assert.deepEqual(objectRefs(OBJ).map(c => c.ref), ['q1#day=2026-06-18@n'])
  assert.ok(isRef('revisions.jsonl#L28') && isRef('q12') && isRef('obj:01-a#/x') && !isRef('hello') && !isRef('https://x.org/#a'))
  assert.ok(isRef('r12') && isRef('r1#day=2026-06-18@n') && !isRef('r17-trail'))
})

test('every state key the plugin keeps is named in its types contract', () => {
  const here = new URL('../../', import.meta.url).pathname
  const declared = new Set([...readFileSync(join(here, 'types', 'index.d.ts'), 'utf8').split("'thimble': {")[1].matchAll(/^ {6}(\w+):/gm)].map(m => m[1]))
  const used = new Set()
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'app' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) for (const m of readFileSync(p, 'utf8').matchAll(/plugin: 'thimble', key: '(\w+)'/g)) used.add(m[1])
    }
  }
  walk(here)
  assert.ok(used.size > 20)
  assert.deepEqual([...used].filter(k => !declared.has(k)), [])
})

test('a diagram under a reply is drawn whole when it fits on the screen; a taller drawing says how many rows are below', async () => {
  // three groups, each split in two: a tree as tall as the one a 46-row screen once cut at its foot
  const groups = [['north', 210, 130], ['south', 190, 90], ['west', 480, 120]]
  const object = { id: '02-tree', title: 'How did the 880 visitors split?', data: { groups }, program: `
    const nodes = [{ id: 'all', label: '880 visitors' }], edges = []
    for (const [g, n, stayed] of data.groups) {
      nodes.push({ id: g, label: g + ': ' + n, note: 'a region' })
      edges.push({ from: 'all', to: g })
      for (const [o, m] of [['stayed', stayed], ['left', n - stayed]]) { nodes.push({ id: g + '-' + o, label: o + ': ' + m, note: 'of ' + g }); edges.push({ from: g, to: g + '-' + o }) }
    }
    return k.graph({ nodes, edges }, { dir: 'right' })` }
  const { drawing } = await prep({ object, w: 116 })
  const lines = gridText(renderTerm(drawing, { w: 116 })).split('\n')
  assert.ok(lines.length > 25, `the tree is ${lines.length} rows`)
  const fit = bodyRows(lines.length, 46)
  assert.deepEqual(fit, { rows: lines.length, more: 0 })
  const framed = frameLines({ w: 120, title: object.title, text: '' }, lines.slice(0, fit.rows))
  assert.match(framed.join('\n'), /left: 360/)
  // a drawing taller than the screen keeps its last row for the line that says what is below
  const tall = bodyRows(80, 46)
  assert.deepEqual(tall, { rows: 31, more: 49 })
  const cut = frameLines({ w: 60, title: 'A long list', text: '', more: tall.more }, Array.from({ length: tall.rows }, (_, i) => `row ${i}`))
  assert.match(cut.at(-2), /↓ 49 more rows · open the card to see all/)
})

test('the plain text of a stacked bar card names each part and its value, and v names the card by its title', async () => {
  // three stages that split each measure: every bar fills to 100, so its text alone shows only full rows of one glyph
  const stages = [{ stage: 'early', time: 10, done: 30 }, { stage: 'middle', time: 20, done: 15 }, { stage: 'late', time: 70, done: 5 }]
  const object = { id: '05-stage-share', title: 'Where the time went', data: { stages }, program: `
    const M = [['time', 'time'], ['done', 'tasks done']]
    return k.bars(M.map(([key, label]) => { const tot = data.stages.reduce((s, r) => s + r[key], 0)
      return { id: 'm-' + key, label, parts: data.stages.map(r => ({ value: r[key] / tot * 100, label: r.stage })) } }), { max: 100 })` }
  const { drawing } = await prep({ object, w: 96 })
  const grid = renderTerm(drawing, { w: 96 })
  assert.match(gridText(grid), /time +▆+ +100/)
  assert.deepEqual(barParts(drawing), ['time: early 10, middle 20, late 70', 'tasks done: early 60, middle 30, late 10'])
  const note = splitsNote(drawing)
  assert.match(note, /no colors/)
  assert.match(note, /- tasks done: early 60, middle 30, late 10/)
  assert.deepEqual(partLines(object, drawing, ['m-time', 'm-done']), ['- time 100', '- tasks done 100'])
  // a card with no stacked bar adds nothing to its text
  const plain = await prep({ object: { id: 'x', title: 'x', data: {}, program: "return k.bars([['a', 2], ['b', 3]])" }, w: 96 })
  assert.equal(splitsNote(plain.drawing), '')
  // what main reads once v's card is saved names no card id
  const made = viewMade({ about: 'The runs went in three stages.', cards: [{ id: '05-stage-share', v: 2, root: '/data' }] })
  assert.doesNotMatch(made, /05-stage-share/)
  assert.match(made, /made a card for it/)
  assert.match(made, /no colors/)
})

test('records of one set are named by one field, never by whichever field is longest in one of them', async () => {
  const { examplesView, wordKeyOf } = await import('../carddetail.js')
  // made-up passengers: the third one's ticket is longer than its name
  const recs = [
    { Name: 'Lindqvist, Mr. Osmo Rainer', Ticket: 'A 1234', Fare: '7.25', Cabin: '', Embarked: 'S', Pclass: '3', Sex: 'male' },
    { Name: 'Varga, Mrs. Ilona Petra', Ticket: 'B 22', Fare: '71.3', Cabin: 'C85', Embarked: 'C', Pclass: '1', Sex: 'female' },
    { Name: 'Aho, Mr. Tuomo K', Ticket: 'QX/R.S. 7700123 ZZ', Fare: '8.05', Cabin: '', Embarked: 'S', Pclass: '3', Sex: 'male' },
  ]
  assert.equal(wordKeyOf(recs), 'Name')
  const view = examplesView(recs, { at: 2, fit: 6 })
  assert.equal(view.kind, 'lines')
  assert.deepEqual(view.rows.map(r => r.words), ['Lindqvist, Mr. Osmo Rainer', 'Varga, Mrs. Ilona Petra', 'Aho, Mr. Tuomo K'])
})
