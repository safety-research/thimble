// Visualize (v): the request it sends Claude (another view, the proposals, the card guide read only now), and the card
// guide's worked programs (skills/thimble/forms), which must draw as the guide shows them, under a reply and in the
// detail.
//   node --test shell/test/visualize.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'
import { viewRequest } from '../visualize.js'

const FORMS_DIR = fileURLToPath(new URL('../../skills/thimble/forms/', import.meta.url))
const GUIDE = fileURLToPath(new URL('../../skills/thimble/cards.md', import.meta.url))
const FORMS = ['bars', 'trend', 'records', 'map', 'table', 'knob', 'guide', 'timeline', 'weeks', 'trail', 'curves', 'diffmap', 'strips', 'unfold']
// the forms the card guide shows, without their opening comment lines
const V3 = ['bars', 'trend', 'records', 'map', 'table', 'knob', 'timeline']

test('v asks Claude for another view of the answer, with the proposal the person picked first and the card guide to read', () => {
  const message = { text: '[840](q3#n) of the 2,143 steps were **reruns**; the cause was a shared fixture.', objects: ['r17-trail@1'],
    verbs: { v: { lit: true, note: '2 views ready', proposals: ['trail of the run', 'failures by test order'] } } }
  const ask = viewRequest({ message, choice: 'failures by test order', guide: '/plugin/skills/thimble/cards.md' })
  assert.match(ask, /^The analyst pressed v \(visualize\) on your answer that begins "840 of the 2,143 steps were reruns; the cause was a shared fixture\."/)
  assert.match(ask, /another view of it: a card in the form that shows what it says, as "failures by test order"/)
  assert.match(ask, /It has the card r17-trail already: make a different view, not a copy\./)
  assert.match(ask, /Also proposed for it: trail of the run\./)
  assert.match(ask, /Read the card guide first, unless you have it from earlier in this session: \/plugin\/skills\/thimble\/cards\.md\./)
  assert.match(ask, /thimble save <name> --from FILE/)
  // no proposals and no card: the plain request
  const plain = viewRequest({ message: { text: 'Done.' }, guide: 'g' })
  assert.doesNotMatch(plain, /Proposed|already/)
  assert.match(viewRequest({ message, guide: 'g' }), /Proposed for it: trail of the run; failures by test order\./)
})

test('v on a catch-up names it as the catch-up the squeeze chips wrote of its replies, not as an answer of Claude\'s', () => {
  const message = { text: 'one\n\n---\n\ntwo', shown: 'The empty label has [741 IPs](q4#label=@ips).', objects: [], verbs: {}, catchup: { host: 'r2', rows: ['r1', 'r2'], replies: 2, question: 'q', prompt: 'p1' } }
  const ask = viewRequest({ message, guide: 'g' })
  assert.match(ask, /^The analyst pressed v \(visualize\) on the catch-up of your 2 replies since their last prompt that the squeeze chips wrote, which begins "The empty label has 741 IPs\."\. They want another view of it/)
})

for (const name of FORMS) {
  test(`the ${name} form draws as the card guidance shows it, under a reply and in the detail, its parts selectable`, () => {
    const program = readFileSync(join(FORMS_DIR, `${name}.program.js`), 'utf8').trimEnd()
    if (V3.includes(name)) assert.ok(readFileSync(GUIDE, 'utf8').includes(program.replace(/^(\/\/[^\n]*\n)+/, '')), `the card guide holds ${name}.program.js`)
    const data = JSON.parse(readFileSync(join(FORMS_DIR, `${name}.data.json`), 'utf8'))
    for (const [w, mode] of [[96, 'inline'], [98, 'detail'], [60, 'inline']]) {
      const d = runProgram({ id: name, v: 1, program, data }, { w, h: mode === 'detail' ? 30 : 24, mode })
      assert.equal(d.error, undefined, `${name} at ${w} ${mode}: ${JSON.stringify(d.error)}`)
      assert.deepEqual(d.warnings, [], `${name} at ${w} ${mode}`)
      const g = renderTerm(d, { w })
      assert.ok(g.regions.filter(r => r.rects.length).length >= 3, `${name} has parts to select`)
      if (w >= 96) assert.deepEqual(g.cut.filter(c => c.k === 'clip'), [], `${name} fits ${w} columns`)
    }
  })
}

test('a knob inside a card changes its words: the curves meet at ×8, and the number unfolds another way', () => {
  const load = n => ({ id: n, v: 1, program: readFileSync(join(FORMS_DIR, `${n}.program.js`), 'utf8'), data: JSON.parse(readFileSync(join(FORMS_DIR, `${n}.data.json`), 'utf8')) })
  const text = d => gridText(renderTerm(d, { w: 96 }))
  assert.match(text(runProgram(load('curves'), { w: 96 })), /◂ ×8 ▸ +max gap 1\.0 pts/)
  assert.match(text(runProgram(load('curves'), { w: 96, state: { scale: 1 } })), /◂ ×1 ▸ +max gap 26\.6 pts/)
  assert.match(text(runProgram(load('unfold'), { w: 96, state: { by: 'day' } })), /1,662 \+ 861 \+ 559 \+ 497 \+ 459 = 4,038/)
  // the trail zooms into a station, one tick per step, and filters to its failures
  const zoomed = runProgram(load('trail'), { w: 96, mode: 'detail', state: { zoom: 'rerun-loop', filter: 'failures only' } })
  assert.match(text(zoomed), /overview › Rerun loop · steps 881–1720 · one tick per step · 101 failures · failures only/)
  assert.deepEqual(zoomed.controls.map(c => c.id), ['zoom', 'filter'])
  assert.equal(renderTerm(zoomed, { w: 96 }).regions.filter(r => r.rects.length && !r.link).length, 14)
})
