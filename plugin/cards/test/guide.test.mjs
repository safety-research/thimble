// The card guide (prompts/card-tool.md) gives the plain look a card takes with one example, a bar with its value, and
// that example is a drawing a view can return: it uses only what the surface gives (its elements, surface.colors,
// surface.num) and draws its words, what a value is in the palette's gray and the value bold. The guidance's Cards
// section (prompts/guidance.md) keeps overview first, zoom and filter, then details on demand, and says what the first
// view shows: the evidence for one answer, each number once. All values are made up.
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
  // a bar with its value compares it, where a value alone beside its name is the stat line of a dashboard
  assert.equal(words(drawn), `refunds ${'█'.repeat(29)} 290`)
  const parts = texts(drawn).filter(t => typeof t.props.children === 'string')
  assert.deepEqual(parts.map(t => [t.props.children.trim(), t.props.color ?? null, !!t.props.bold]), [['refunds', GRAY, false], ['290', null, true]])
})

test("the guidance's card principles keep overview first and details on demand, and say the first view is the evidence for one answer, each number once", () => {
  const text = readFileSync(join(ROOT, 'prompts', 'guidance.md'), 'utf8')
  const cards = text.split(/^## /m).find(s => s.startsWith('Cards\n'))
  assert.ok(cards, 'the guidance has a Cards section')
  const line = start => cards.split('\n').find(l => l.startsWith(start)) ?? ''
  // overview first, zoom and filter, then details on demand, as it was; then the first view is the evidence for one
  // answer, with only the fields that help answer it
  const one = line('1. ')
  assert.match(one, /^1\. Overview first, zoom and filter, then details on demand\. The first view shows the whole, aggregated to fit the card, not a table of raw records\. The analyst narrows it with keys and clicks, and a click opens one record\. /)
  assert.match(one, /One card answers one question, so the first view shows the evidence the answer rests on, with only the fields that help answer it\.$/)
  // what follows a selection, its note or its details, keeps rows of its own
  assert.match(line('- When a key or click changes'), /such as a note or details, goes on rows kept for it/)
  // each number once; numbers the analyst compares in a form that compares them; a number in a box of its own is the
  // look of a dashboard; rows that say the same thing are drawn as their count
  const five = line('5. ')
  assert.match(five, /^5\. Each element shows data or acts on it\. /)
  assert.match(five, /Each number shows once\. Numbers that the analyst compares, such as the count at each step, show in a form that compares them/)
  assert.match(five, /A number in a box of its own is the look of a dashboard/)
  assert.match(five, /Rows that all say the same thing show one fact many times, so draw their count/)
})
