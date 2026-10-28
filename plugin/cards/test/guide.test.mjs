// The card guide (prompts/card-tool.md) gives the plain look a card takes with one example, and that example is a
// drawing a view can return: it uses only what the surface gives (its elements, surface.colors, surface.num) and draws
// its words, what a value is in the palette's gray and the value bold. All values are made up.
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
