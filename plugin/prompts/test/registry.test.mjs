// The prompt registry (prompts/registry.mjs, node.mjs): every model-read text is one file; THIMBLE_PROMPTS turns an
// optional text off, and a pair it cannot read is said in one line with its fix.
//   node --test plugin/prompts/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { ROOT, textOf } from '../node.mjs'
import { TEXTS, bodyOf, fileOf, fill, listing, offOf, specOf } from '../registry.mjs'

test('each text is one file: prompts/<text>.md, or the file its entry names', () => {
  assert.equal(fileOf('squeeze'), 'prompts/squeeze.md')
  assert.equal(fileOf('lens-explain'), 'prompts/lens-explain.md')
  assert.equal(fileOf('forms'), 'skills/thimble/cards.md')
})

test('THIMBLE_PROMPTS turns optional texts off; aliases name their text; whitespace, = and a trailing comma are fine', () => {
  assert.deepEqual(offOf(' lens-explain:off, context=off ,,'), { off: ['lens-explain', 'context'], problems: [] })
  assert.deepEqual(offOf(''), { off: [], problems: [] })
  assert.equal(specOf(['lens-explain', 'context']), 'lens-explain:off,context:off')
})

test('a pair it cannot read changes nothing and is one line with its fix', () => {
  const c = offOf('squeeze:v7, forms:off, nothing:off, lens-heads off')
  assert.deepEqual(c.off, [])
  assert.equal(c.problems.length, 4)
  assert.match(c.problems[0], /^THIMBLE_PROMPTS: squeeze:v7 is not read: each text is one file \(prompts\/squeeze\.md\), so edit it there; only squeeze:off is read$/)
  assert.match(c.problems[1], /^THIMBLE_PROMPTS: forms cannot be turned off; the texts that can are lens-actions, /)
  assert.match(c.problems[2], /no text "nothing"/)
  assert.match(c.problems[3], /"lens-heads off" is not text:off/)
  // `cards` is the card guide's other name, and the card guide cannot be off
  assert.match(offOf('cards:off').problems[0], /forms cannot be turned off/)
})

test('bodies and placeholders', () => {
  assert.equal(bodyOf('---\nname: x\ndescription: y\n---\n\n# Body\n'), '\n# Body\n')
  assert.equal(bodyOf('# no frontmatter'), '# no frontmatter')
  assert.equal(fill('a {{X}} b {{Y}} c {{Z}}', { X: 1, Y: () => 'two' }), 'a 1 b two c {{Z}}')
  // $& and $1 in a value are kept as written
  assert.equal(fill('{{X}}', { X: '$& $1' }), '$& $1')
})

test('every text has its file with text, every file in prompts/ is a text, and the listing names each', () => {
  for (const name of Object.keys(TEXTS)) assert.ok(readFileSync(join(ROOT, fileOf(name)), 'utf8').trim().length > 0, `${name} has text`)
  for (const file of readdirSync(join(ROOT, 'prompts')).filter(x => x.endsWith('.md'))) assert.ok(TEXTS[file.replace(/\.md$/, '')], `prompts/${file} is a text`)
  const lines = listing(['lens-explain'])
  assert.equal(lines.length, Object.keys(TEXTS).length)
  assert.ok(lines.some(l => l.startsWith('lens-explain') && l.includes('prompts/lens-explain.md  (off)')))
})

test('textOf reads a text, the card guide from skills/thimble/cards.md; one turned off has no text', () => {
  const t = textOf('cards', ROOT, {})
  assert.equal(t.id, 'forms')
  assert.match(t.text, /^# The card guide\n/)
  assert.equal(t.file, join(ROOT, 'skills/thimble/cards.md'))
  const off = textOf('lens-explain', ROOT, { THIMBLE_PROMPTS: 'lens-explain:off' })
  assert.deepEqual([off.off, off.text, off.file], [true, '', null])
  assert.throws(() => textOf('nothing', ROOT, {}), /no prompt text "nothing"/)
})
