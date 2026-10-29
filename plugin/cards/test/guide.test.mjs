// The card guide (prompts/card-tool.md) gives the plain look a card takes with one example, and that example is a
// drawing a view can return: it uses only what the surface gives (its elements, surface.colors, surface.num) and draws
// its words, what a value is in the palette's gray and the value bold. The guidance's Cards section (prompts/
// guidance.md) says what a card shows: the evidence for one answer, in one view. All values are made up.
//   node --test plugin/cards/test/guide.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GRAY = '#85827a'

const element = type => props => ({ type, props })
const surface = { elements: { Box: element('Box'), Text: element('Text'), Button: element('Button') }, colors: { gray: GRAY, cat: [], good: '', bad: '' }, num: n => Number(n).toLocaleString('en-US') }
const words = n => (typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(words).join('') : n?.props ? words(n.props.children) : '')
const texts = (n, out = []) => {
  if (Array.isArray(n)) n.forEach(k => texts(k, out))
  else if (n?.props) { if (n.type === 'Text') out.push(n); texts(n.props.children, out) }
  return out
}

test("the card guide shows the plain look with one example, which draws with the surface's own parts", () => {
  const look = readFileSync(join(ROOT, 'prompts', 'card-tool.md'), 'utf8').split('\n').find(l => l.startsWith('Look:'))
  assert.ok(look, 'the guide has a paragraph on the look')
  const examples = [...look.matchAll(/`((?:Box|Text)\(\{[^`]*\}\))`/g)].map(m => m[1])
  assert.equal(examples.length, 1, 'one example')
  const drawn = new Function('surface', 'Box', 'Text', 'Button', `return ${examples[0]}`)(surface, surface.elements.Box, surface.elements.Text, surface.elements.Button)
  assert.equal(words(drawn), 'merged 296')
  const parts = texts(drawn).filter(t => typeof t.props.children === 'string')
  assert.deepEqual(parts.map(t => [t.props.children.trim(), t.props.color ?? null, !!t.props.bold]), [['merged', GRAY, false], ['296', null, true]])
})

test("the guidance's card principles say a card answers one question with the evidence chosen for it, in one view, each number once", () => {
  const text = readFileSync(join(ROOT, 'prompts', 'guidance.md'), 'utf8')
  const cards = text.split(/^## /m).find(s => s.startsWith('Cards\n'))
  assert.ok(cards, 'the guidance has a Cards section')
  const line = start => cards.split('\n').find(l => l.startsWith(start)) ?? ''
  // one answer, its evidence chosen, one view: no table of raw records, no second view of the same records, such as a
  // list under a chart of them or a panel of one record's details; before, cards grew an overview, a list and a panel
  const one = line('1. ')
  assert.match(one, /^1\. One card answers one question, with the evidence chosen for it/)
  assert.match(one, /only the fields that help answer the question/)
  assert.match(one, /not a second view of the same records/)
  assert.match(one, /a panel of one record's details/)
  assert.match(one, /the card stays one view/)
  // each number once, in a form that compares it; a number in a box of its own is the look of a dashboard; rows that
  // say the same thing are drawn as their count
  const five = line('5. ')
  assert.match(five, /Each number shows once, in a form that compares it with the others/)
  assert.match(five, /A number in a box of its own is the look of a dashboard/)
  assert.match(five, /Rows that all say the same thing show one fact many times, so draw their count/)
  // the rows that fit are a reason to choose, not to page
  assert.match(line('- About 30 rows fit'), /choose the rows the answer rests on/)
})
