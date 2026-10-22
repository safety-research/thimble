// The prompt registry (prompts/registry.mjs, node.mjs): every model-read text is one file, and every file in prompts/
// is a text the registry names.
//   node --test plugin/prompts/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { ROOT, textOf } from '../node.mjs'
import { TEXTS, fileOf, fill, listing } from '../registry.mjs'

test('the texts are the guidance, the card tool, the checker, the designer and the label classifier', () => {
  assert.deepEqual(Object.keys(TEXTS), ['guidance', 'card-tool', 'checker', 'designer', 'labels'])
  assert.equal(fileOf('checker'), 'prompts/checker.md')
})

test('every text has its file with text, every file in prompts/ is a text, and the listing names each', () => {
  for (const name of Object.keys(TEXTS)) assert.ok(readFileSync(join(ROOT, fileOf(name)), 'utf8').trim().length > 0, `${name} has text`)
  for (const file of readdirSync(join(ROOT, 'prompts')).filter(x => x.endsWith('.md'))) assert.ok(TEXTS[file.replace(/\.md$/, '')], `prompts/${file} is a text`)
  assert.equal(listing().length, Object.keys(TEXTS).length)
})

test('placeholders are filled, and a value is kept as written', () => {
  assert.equal(fill('a {{X}} b {{Y}} c {{Z}}', { X: 1, Y: () => 'two' }), 'a 1 b two c {{Z}}')
  assert.equal(fill('{{X}}', { X: '$& $1' }), '$& $1')
})

test('textOf reads a text; a name the registry lacks is an error', () => {
  const t = textOf('guidance', ROOT)
  assert.match(t.text, /^thimble is on in this folder\./)
  assert.equal(t.file, join(ROOT, 'prompts/guidance.md'))
  assert.throws(() => textOf('nothing', ROOT), /no prompt text "nothing"/)
})
