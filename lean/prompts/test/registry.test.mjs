// The prompt registry (prompts/registry.mjs, node.mjs): every model-read text is a version of a feature; the setting
// and LEAN_PROMPTS pick the active one, a version that does not exist keeps the default with one line, a lens can be
// turned off, and `lean guide cards` prints the card guidance and notes the read in the session's events.
//   node --test lean/prompts/test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { activeNow, loadIndex, ROOT, textOf } from '../node.mjs'
import { FEATURES, bodyOf, choose, featureOfSkill, fill, idOf, indexOf, listing, parseSpec, partsText, sectionOf, specOf } from '../registry.mjs'

const NODE = fileURLToPath(new URL('../node.mjs', import.meta.url))
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16)

test('a spec reads as feature:version pairs; aliases name their feature; a word that is no pair is a problem', () => {
  assert.deepEqual(parseSpec(' forms:principles, observer=attention-v1 ,,').pairs, { forms: 'principles', observer: 'attention-v1' })
  assert.deepEqual(parseSpec('cards:v1').pairs, { forms: 'v1' })
  const p = parseSpec('forms principles')
  assert.deepEqual(p.pairs, {})
  assert.equal(p.problems.length, 1)
})

test('the index has every feature with its default, the versions on disk, and a skill in place as `skill`', () => {
  const idx = indexOf({ observer: ['v1.md', 'v2.md', 'mine.md', 'notes.txt', '.draft.md'] })
  assert.deepEqual(Object.keys(idx.observer.versions).sort(), ['attention-v1', 'mine', 'v1', 'v2'])
  assert.equal(idx.observer.versions.mine.file, 'prompts/observer/mine.md')
  assert.equal(idx.lean.versions.skill.file, 'skills/lean/SKILL.md')
  for (const [name, f] of Object.entries(FEATURES)) assert.ok(idx[name].versions[f.default], `${name} has its default`)
})

test('the active version: the default, then the setting, then LEAN_PROMPTS; a missing version keeps the one before with one line', () => {
  const idx = indexOf({ forms: ['v1.md', 'v2.md', 'principles.md'] })
  const d = choose(idx)
  assert.equal(d.active.forms.version, 'runtime')
  assert.equal(d.active.forms.file, null)
  assert.equal(d.active.forms.parts.length, 2)
  assert.equal(d.active.forms.source, 'default')
  assert.deepEqual(d.problems, [])
  const s = choose(idx, { setting: 'forms:v1' })
  assert.equal(s.active.forms.version, 'v1')
  assert.equal(s.active.forms.source, 'setting')
  const e = choose(idx, { setting: 'forms:v1', env: 'forms:principles' })
  assert.equal(e.active.forms.version, 'principles')
  assert.equal(e.active.forms.file, 'prompts/forms/principles.md')
  const m = choose(idx, { setting: 'forms:v1', env: 'forms:v9,nothing:v1' })
  assert.equal(m.active.forms.version, 'v1')
  assert.equal(m.problems.length, 2)
  assert.match(m.problems[0], /^LEAN_PROMPTS: no version forms:v9, so forms stays at v1; its versions are runtime, v1, v2, principles$/)
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
  const idx = indexOf({ forms: ['principles.md'] })
  const c = choose(idx, { env: 'forms:principles,observer:v2,lens-claims:off' })
  assert.equal(specOf(c.active, idx), 'lens-claims:off,forms:principles')
  assert.equal(idOf('forms', 'principles'), 'forms:principles')
})

test('skills, bodies and placeholders', () => {
  assert.equal(featureOfSkill('thimble-lean:lean'), 'lean')
  assert.equal(featureOfSkill('map'), 'map')
  assert.equal(featureOfSkill('commit'), null)
  assert.equal(bodyOf('---\nname: x\ndescription: y\n---\n\n# Body\n'), '\n# Body\n')
  assert.equal(bodyOf('# no frontmatter'), '# no frontmatter')
  assert.equal(fill('a {{X}} b {{Y}} c {{Z}}', { X: 1, Y: () => 'two' }), 'a 1 b two c {{Z}}')
  // $& and $1 in a value are kept as written
  assert.equal(fill('{{X}}', { X: '$& $1' }), '$& $1')
})

test('a version made of parts reads each section where it stands, and can leave a part out', () => {
  const md = '# T\n\nintro\n\n## Principles\n\np one\n\n### deeper\n\nd\n\n## Examples\n\ne one\n'
  assert.equal(sectionOf(md, 'principles'), '## Principles\n\np one\n\n### deeper\n\nd')
  assert.equal(sectionOf(md, 'Examples'), '## Examples\n\ne one')
  assert.equal(sectionOf(md, 'nothing'), '')
  const files = { 'skills/x/SKILL.md': '---\nname: x\n---\n' + md, 'prompts/f/v.md': '# F\n\n## Worked examples\n\nw\n' }
  const parts = [{ file: 'skills/x/SKILL.md', section: 'Principles' }, { file: 'prompts/f/v.md', section: 'Worked examples' }]
  assert.equal(partsText(parts, f => files[f]), '## Principles\n\np one\n\n### deeper\n\nd\n\n## Worked examples\n\nw\n')
  assert.equal(partsText(parts, f => files[f], p => p.file.endsWith('SKILL.md')), '## Worked examples\n\nw\n')
  // the default card guidance: the lean skill's card section where it stands, then the worked forms
  const t = textOf('cards', ROOT, {})
  assert.equal(t.id, 'forms:runtime')
  assert.match(t.text, /^## What the person sees\n/)
  assert.match(t.text, /\n## Worked examples\n/)
  assert.doesNotMatch(t.text, /## Example: a count/)
})

test("today's texts are the v1 of their features, byte for byte", () => {
  // the hashes of observer.md, question.md, squeeze's prompt.md and FORMS.md as they stood before the registry, and
  // the thread prompt's opening
  const want = {
    'observer/v1.md': '51490982d80d0f94', 'question/v1.md': '84409e8c32d8fc4a', 'squeeze/v1.md': '0fad5d2275653f10',
    'forms/v1.md': 'fe514350976bbb45',
  }
  for (const [f, h] of Object.entries(want)) assert.equal(sha(readFileSync(join(ROOT, 'prompts', f), 'utf8')), h, f)
  assert.match(readFileSync(join(ROOT, 'prompts/thread/v1.md'), 'utf8'), /^You answer one person's questions about one part of a card/)
})

test('every version file on disk is in the index, every default exists, and every lens fragment has its sections', () => {
  const idx = loadIndex()
  for (const [name, f] of Object.entries(idx)) {
    for (const [v, meta] of Object.entries(f.versions)) {
      const text = meta.parts ? partsText(meta.parts, x => readFileSync(join(ROOT, x), 'utf8')) : readFileSync(join(ROOT, meta.file), 'utf8')
      assert.ok(text.trim().length > 0, `${name}:${v} has text`)
      for (const p of meta.parts || []) assert.ok(partsText([p], x => readFileSync(join(ROOT, x), 'utf8')).trim(), `${name}:${v} finds ${p.section} in ${p.file}`)
    }
    let files = []
    try { files = readdirSync(join(ROOT, 'prompts', name)).filter(x => x.endsWith('.md')) } catch { files = [] }
    for (const file of files) assert.ok(f.versions[file.replace(/\.md$/, '')], `${name}/${file} is a version`)
  }
  const { active, problems } = activeNow(ROOT, {})
  assert.deepEqual(problems, [])
  assert.equal(active.observer.version, 'v2')
  assert.ok(listing(idx, active).some(l => l.startsWith('observer') && l.includes('[v2]')))
})

test('textOf reads the active text; a skill in place is its body', () => {
  const t = textOf('cards', ROOT, { LEAN_PROMPTS: 'forms:principles' })
  assert.equal(t.id, 'forms:principles')
  assert.match(t.text, /^# What makes a great output/)
  const lean = textOf('lean', ROOT, {})
  assert.equal(lean.id, 'lean:skill')
  assert.doesNotMatch(lean.text, /^---/)
  assert.match(lean.text, /^\n# Where each value comes from/)
})

test('`lean guide cards` prints the card guidance with its folder, and notes the read in the session events', () => {
  const home = mkdtempSync(join(tmpdir(), 'guide-'))
  const r = spawnSync(process.execPath, [NODE, 'guide', 'cards'], { encoding: 'utf8', env: { PATH: process.env.PATH, THIMBLE_HOME: home, LEAN_SESSION: 's-guide', LEAN_PROMPTS: 'forms:v1' } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^\(forms:v1 · its folder: .*verbs\/visualize; paths below are relative to it\)\n\n# Card forms: another view/)
  const ev = readFileSync(join(home, 'lean', 'events', 's-guide.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(ev.length, 1)
  assert.equal(ev[0].kind, 'prompt')
  assert.equal(ev[0].prompt, 'forms:v1')
  // a version that does not exist: the default, with one line on stderr
  const m = spawnSync(process.execPath, [NODE, 'guide', 'cards'], { encoding: 'utf8', env: { PATH: process.env.PATH, THIMBLE_HOME: home, LEAN_PROMPTS: 'forms:v9' } })
  assert.equal(m.status, 0)
  assert.match(m.stdout, /^\(forms:runtime ·/)
  assert.equal(m.stderr.trim().split('\n').length, 1)
  assert.match(m.stderr, /no version forms:v9, so forms stays at runtime/)
})
