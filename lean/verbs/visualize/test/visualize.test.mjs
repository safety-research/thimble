// Visualize (v): the request it sends Claude (another view, the proposals, the card guidance read only now), and the
// card forms' worked programs, which must draw as the card guidance (the registry's forms) shows them, under a reply and
// in the detail.
//   node --test lean/verbs/visualize/test/visualize.test.mjs
import '../../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runProgram } from '../../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../../draw/term.js'
import { request, run } from '../run.mjs'

const DIR = fileURLToPath(new URL('..', import.meta.url))
const GUIDANCE = fileURLToPath(new URL('../../../prompts/forms/', import.meta.url))
const FORMS = ['bars', 'trail', 'curves', 'diffmap', 'strips', 'unfold']

test('v asks Claude for another view of the answer, with the proposal the person picked first and the card forms to read', async () => {
  const message = { text: '[840](q3#n) of the 2,143 steps were **reruns**; the cause was a shared fixture.', objects: ['r17-trail@1'],
    verbs: { v: { lit: true, note: '2 views ready', proposals: ['trail of the run', 'failures by test order'] } } }
  const ask = request({ message, args: 'failures by test order', verb: { dir: '/plugin/verbs/visualize' } })
  assert.match(ask, /^The person pressed v \(visualize\) on your answer that begins "840 of the 2,143 steps were reruns; the cause was a shared fixture\."/)
  assert.match(ask, /another view of it: a card in the form that shows what it says, as "failures by test order"/)
  assert.match(ask, /It has the card r17-trail already: make a different view, not a copy\./)
  assert.match(ask, /Also proposed for it: trail of the run\./)
  assert.match(ask, /Run `thimble guide cards` first, unless you read it earlier in this session: the card guidance\./)
  assert.match(ask, /thimble save <name> --from FILE/)
  // no proposals and no card: the plain request
  const plain = request({ message: { text: 'Done.' }, verb: { dir: '/v' } })
  assert.doesNotMatch(plain, /Proposed|already/)
  const r = await run({ message, verb: { dir: '/v' } })
  assert.equal(r.text, 'Claude is making another view of this answer.')
  assert.match(r.ask, /Proposed for it: trail of the run; failures by test order\./)
})

test('the card guidance is not a skill at rest: no SKILL.md lists it; `thimble guide cards` reads it when a card is drawn', () => {
  assert.throws(() => readFileSync(join(DIR, 'SKILL.md')))
  const verb = JSON.parse(readFileSync(join(DIR, 'verb.json'), 'utf8'))
  assert.equal(verb.key, 'v')
  assert.equal(verb.row, true)
  assert.equal(verb.skill, 'thimble guide cards')
})

for (const name of FORMS) {
  test(`the ${name} form draws as the card guidance shows it, under a reply and in the detail, its parts selectable`, () => {
    const program = readFileSync(join(DIR, 'forms', `${name}.program.js`), 'utf8').trimEnd()
    for (const v of ['v1.md', 'v2.md']) assert.ok(readFileSync(join(GUIDANCE, v), 'utf8').includes(program), `forms:${v} holds ${name}.program.js as it is`)
    const data = JSON.parse(readFileSync(join(DIR, 'forms', `${name}.data.json`), 'utf8'))
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
  const load = n => ({ id: n, v: 1, program: readFileSync(join(DIR, 'forms', `${n}.program.js`), 'utf8'), data: JSON.parse(readFileSync(join(DIR, 'forms', `${n}.data.json`), 'utf8')) })
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
