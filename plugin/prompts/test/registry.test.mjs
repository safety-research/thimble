// The prompt registry (prompts/registry.mjs, node.mjs): every model-read text is a version of a feature; THIMBLE_PROMPTS
// picks another one, a version that does not exist keeps the default with one line, and a lens can be turned off.
//   node --test plugin/prompts/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { activeNow, loadIndex, ROOT, textOf } from '../node.mjs'
import { FEATURES, bodyOf, choose, fill, idOf, indexOf, listing, parseSpec, specOf } from '../registry.mjs'

test('a spec reads as feature:version pairs; aliases name their feature; a word that is no pair is a problem', () => {
  assert.deepEqual(parseSpec(' squeeze:v7, observer=v3 ,,').pairs, { squeeze: 'v7', observer: 'v3' })
  assert.deepEqual(parseSpec('cards:v3').pairs, { forms: 'v3' })
  const p = parseSpec('squeeze v7')
  assert.deepEqual(p.pairs, {})
  assert.equal(p.problems.length, 1)
})

test('the index has every feature with its default and the versions on disk', () => {
  const idx = indexOf({ observer: ['v3.md', 'mine.md', 'notes.txt', '.draft.md'] })
  assert.deepEqual(Object.keys(idx.observer.versions).sort(), ['mine', 'v3', 'v3-low', 'v4', 'v4-low', 'v5', 'v6'])
  assert.equal(idx.observer.versions.mine.file, 'prompts/observer/mine.md')
  assert.equal(idx.forms.versions.v6.file, 'skills/thimble/cards.md')
  assert.equal(idx.forms.versions.v5.file, 'prompts/forms/v5.md')
  assert.equal(idx.forms.versions.v4.file, 'prompts/forms/v4.md')
  assert.equal(idx.forms.versions.v3.file, 'prompts/forms/v3.md')
  for (const [name, f] of Object.entries(FEATURES)) assert.ok(idx[name].versions[f.default], `${name} has its default`)
})

test('the active version: the default, then THIMBLE_PROMPTS; a missing version keeps the default with one line', () => {
  const idx = indexOf({ squeeze: ['v6.md', 'v7.md', 'v8.md'] })
  const d = choose(idx)
  assert.equal(d.active.squeeze.version, 'v8')
  assert.equal(d.active.squeeze.source, 'default')
  assert.deepEqual(d.problems, [])
  const e = choose(idx, { env: 'squeeze:v6' })
  assert.equal(e.active.squeeze.version, 'v6')
  assert.equal(e.active.squeeze.file, 'prompts/squeeze/v6.md')
  const m = choose(idx, { env: 'squeeze:v9,nothing:v1' })
  assert.equal(m.active.squeeze.version, 'v8')
  assert.equal(m.problems.length, 2)
  assert.match(m.problems[0], /^THIMBLE_PROMPTS: no version squeeze:v9, so squeeze stays at v8; its versions are v6, v7, v8$/)
  assert.match(m.problems[1], /no prompt feature "nothing"/)
})

test('a lens can be turned off; a feature that is no lens cannot', () => {
  const idx = indexOf({})
  const c = choose(idx, { env: 'lens-explain:off,squeeze:off' })
  assert.equal(c.active['lens-explain'].off, true)
  assert.equal(c.active['lens-explain'].file, null)
  assert.equal(c.active.squeeze.version, FEATURES.squeeze.default)
  assert.match(c.problems[0], /no version squeeze:off/)
})

test('the spec of the versions in use names only those that are not the defaults', () => {
  const idx = indexOf({ squeeze: ['v6.md', 'v7.md'] })
  const c = choose(idx, { env: 'squeeze:v6,observer:v6,lens-explain:off' })
  assert.equal(specOf(c.active, idx), 'lens-explain:off,squeeze:v6')
  assert.equal(idOf('squeeze', 'v7'), 'squeeze:v7')
})

test('bodies and placeholders', () => {
  assert.equal(bodyOf('---\nname: x\ndescription: y\n---\n\n# Body\n'), '\n# Body\n')
  assert.equal(bodyOf('# no frontmatter'), '# no frontmatter')
  assert.equal(fill('a {{X}} b {{Y}} c {{Z}}', { X: 1, Y: () => 'two' }), 'a 1 b two c {{Z}}')
  // $& and $1 in a value are kept as written
  assert.equal(fill('{{X}}', { X: '$& $1' }), '$& $1')
})

test('every version file on disk is in the index, every default exists and has text', () => {
  const idx = loadIndex()
  for (const [name, f] of Object.entries(idx)) {
    for (const [v, meta] of Object.entries(f.versions)) assert.ok(readFileSync(join(ROOT, meta.file), 'utf8').trim().length > 0, `${name}:${v} has text`)
    let files = []
    try { files = readdirSync(join(ROOT, 'prompts', name)).filter(x => x.endsWith('.md')) } catch { files = [] }
    for (const file of files) assert.ok(f.versions[file.replace(/\.md$/, '')], `${name}/${file} is a version`)
  }
  const { active, problems } = activeNow(ROOT, {})
  assert.deepEqual(problems, [])
  assert.equal(active.observer.version, 'v6')
  assert.ok(listing(idx, active).some(l => l.startsWith('observer') && l.includes('[v6]')))
  // each frame names the turn template it reads, and the template exists
  for (const [v, meta] of Object.entries(FEATURES.observer.versions)) assert.ok(idx['observer-turn'].versions[meta.turn], `observer:${v} reads observer-turn:${meta.turn}`)
})

test('textOf reads the active text: the card guide is skills/thimble/cards.md', () => {
  const t = textOf('cards', ROOT, {})
  assert.equal(t.id, 'forms:v6')
  assert.match(t.text, /^# The card guide\n/)
  assert.equal(t.file, join(ROOT, 'skills/thimble/cards.md'))
})
