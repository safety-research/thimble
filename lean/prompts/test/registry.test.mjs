// The prompt registry (prompts/registry.mjs, node.mjs): every model-read text is a version of a feature; the setting
// and LEAN_PROMPTS pick the active one, a version that does not exist keeps the default with one line, a lens can be
// turned off, and `lean guide cards` prints the card guidance and notes the read in the session's events.
//   node --test lean/prompts/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { activeNow, loadIndex, ROOT, textOf } from '../node.mjs'
import { FEATURES, bodyOf, choose, chosenOf, featureOfSkill, fill, idOf, indexOf, listing, parseSpec, partsChoice, partsText, sectionOf, specOf, subsectionsOf } from '../registry.mjs'

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
  assert.deepEqual(Object.keys(idx.observer.versions).sort(), ['attention-v1', 'mine', 'v1', 'v2', 'v2-low'])
  assert.equal(idx.observer.versions.mine.file, 'prompts/observer/mine.md')
  assert.equal(idx.lean.versions.skill.file, 'skills/lean/SKILL.md')
  // a feature that is off by default has no version named off
  for (const [name, f] of Object.entries(FEATURES)) assert.ok(f.default === 'off' ? f.optional && !idx[name].versions.off : idx[name].versions[f.default], `${name} has its default`)
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
  assert.match(m.problems[0], /^LEAN_PROMPTS: no version forms:v9, so forms stays at v1; its versions are runtime, v1, v2, principles, few, many, rotate, sketches$/)
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

test('a feature that is off by default (the card after the answer) is off until a setting names a version, and the spec names it then', () => {
  const idx = indexOf({ card: ['v1.md'] })
  assert.deepEqual(Object.keys(idx.card.versions), ['v1'])
  const d = choose(idx, {})
  assert.equal(d.active.card.off, true)
  assert.equal(d.active.card.version, 'off')
  assert.equal(d.active.card.file, null)
  assert.equal(specOf(d.active, idx), '')
  const on = choose(idx, { env: 'card:v1' })
  assert.equal(on.active.card.off, undefined)
  assert.equal(on.active.card.file, 'prompts/card/v1.md')
  assert.equal(specOf(on.active, idx), 'card:v1')
  assert.equal(choose(idx, { setting: 'card:v1', env: 'card:off' }).active.card.off, true)
  assert.ok(listing(idx, d.active).some(l => l.startsWith('card') && l.includes('v1 [off]')))
})

test('the spec of the versions in use names only those that are not the defaults', () => {
  const idx = indexOf({ forms: ['principles.md'] })
  const c = choose(idx, { env: 'forms:principles,observer:v2-low,lens-claims:off' })
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
  assert.equal(active.observer.version, 'v2-low')
  assert.ok(listing(idx, active).some(l => l.startsWith('observer') && l.includes('[v2-low]')))
})

test('textOf reads the active text; a skill in place is its body', () => {
  const t = textOf('cards', ROOT, { LEAN_PROMPTS: 'forms:principles' })
  assert.equal(t.id, 'forms:principles')
  assert.match(t.text, /^## What the person sees\n[\s\S]*\n## What makes a great output\n/)
  assert.doesNotMatch(t.text, /## Worked examples|## Sketches/)
  assert.equal(t.chosen, null)
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

test('the card ablation: five versions with the same principles, which differ only in their examples', () => {
  const env = v => ({ LEAN_PROMPTS: `forms:${v}`, LEAN_SESSION: 's-ab' })
  const a = textOf('cards', ROOT, env('principles')).text
  const pool = subsectionsOf(sectionOf(textOf('cards', ROOT, env('many')).text, 'Worked examples')).items
  assert.ok(pool.length >= 1)
  for (const v of ['few', 'many', 'rotate', 'sketches']) {
    const t = textOf('cards', ROOT, env(v)).text
    assert.ok(t.startsWith(a.trim()), `${v} starts with the principles of a`)
  }
  // few keeps the subsections it names; sketches has no programs
  const few = textOf('cards', ROOT, env('few'))
  const named = FEATURES.forms.versions.few.parts.at(-1).only.map(h => pool.find(x => x.heading.toLowerCase().startsWith(h.toLowerCase()))?.heading)
  assert.ok(named.every(Boolean), 'each example few names is in the pool')
  assert.deepEqual(few.chosen, pool.map(x => x.heading).filter(h => named.includes(h)), 'in the order of the pool')
  assert.doesNotMatch(textOf('cards', ROOT, env('sketches')).text, /```js/)
})

test('a part that picks: the same session reads the same examples, in the order of the file; only keeps them by name', () => {
  const md = '## Worked examples\n\nintro\n\n' + ['A one', 'B two', 'C three', 'D four', 'E five', 'F six'].map(h => `### ${h}\n\nbody ${h}\n`).join('\n')
  const read = () => md
  const part = [{ file: 'prompts/f/examples.md', pick: 3 }]
  const one = partsChoice(part, read, undefined, 'session-1')
  assert.equal(one.chosen.length, 3)
  assert.deepEqual(partsChoice(part, read, undefined, 'session-1'), one, 'the same seed: the same text and the same examples')
  const all = subsectionsOf(md).items.map(x => x.heading)
  assert.deepEqual([...one.chosen].sort((x, y) => all.indexOf(x) - all.indexOf(y)), one.chosen, 'in the order of the file')
  assert.match(one.text, /^## Worked examples\n\nintro\n\n### /)
  for (const h of all) assert.equal(one.text.includes(`### ${h}`), one.chosen.includes(h))
  // across sessions every example is read by some
  const seen = new Set()
  for (let i = 0; i < 40; i++) partsChoice(part, read, undefined, `s${i}`).chosen.forEach(h => seen.add(h))
  assert.equal(seen.size, all.length)
  assert.deepEqual(chosenOf({ only: ['b', 'E five'] }, subsectionsOf(md).items).map(x => x.heading), ['B two', 'E five'])
  assert.equal(partsChoice([{ file: 'x.md' }], read).chosen, null, 'a part that keeps its whole text chooses nothing')
})

test('`lean guide cards` with a version that picks notes the examples it chose for the session', () => {
  const home = mkdtempSync(join(tmpdir(), 'guide-'))
  const r = spawnSync(process.execPath, [NODE, 'guide', 'cards'], { encoding: 'utf8', env: { PATH: process.env.PATH, THIMBLE_HOME: home, LEAN_SESSION: 's-rot', LEAN_PROMPTS: 'forms:rotate' } })
  assert.equal(r.status, 0, r.stderr)
  const ev = readFileSync(join(home, 'lean', 'events', 's-rot.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(ev[0].prompt, 'forms:rotate')
  assert.deepEqual(ev[0].examples, textOf('cards', ROOT, { LEAN_PROMPTS: 'forms:rotate', LEAN_SESSION: 's-rot' }).chosen)
  for (const h of ev[0].examples) assert.ok(r.stdout.includes(`### ${h}`))
})
