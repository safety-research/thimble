// The prompt registry (prompts/registry.mjs, node.mjs): every model-read text is one file, every file in prompts/ is a
// text the registry names, each text is read by the module the registry names, and each mode reads a text with what it
// includes and that mode's words in its slots.
//   node --test plugin/prompts/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { textOf } from '../node.mjs'
import { MODES, TEXTS, compose, fileOf, fill } from '../registry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The plugin's hooks sources, as [path from the plugin's root, text]. */
function sources(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return d.name === 'node_modules' || d.name === 'tests' || d.name === 'test' ? [] : sources(p)
    return /\.(ts|tsx|mjs|js)$/.test(d.name) ? [[relative(ROOT, p), readFileSync(p, 'utf8')]] : []
  })
}

test('every text has its file with text, every file in prompts/ is a text, and each text is read where the registry says', () => {
  // every text has its file with text, and every file in prompts/ is a text
  {
    for (const name of Object.keys(TEXTS)) assert.ok(readFileSync(join(ROOT, fileOf(name)), 'utf8').trim().length > 0, `${name} has text`)
    for (const file of readdirSync(join(ROOT, 'prompts')).filter(x => x.endsWith('.md'))) assert.ok(TEXTS[file.replace(/\.md$/, '')], `prompts/${file} is a text`)
  }
  // each text is read where the registry says: every promptText call names its text and is in its reader
  {
    const calls = sources().flatMap(([file, src]) => [...src.matchAll(/promptText\(\$, '([^']+)'\)/g)].map(m => [file, m[1]]))
    assert.ok(calls.length > 0)
    for (const [file, name] of calls) {
      assert.ok(TEXTS[name], `${file} reads ${name}, a text of the registry`)
      assert.equal(TEXTS[name].terminal, file, `the registry names ${file} as what reads ${name}`)
    }
    assert.ok(calls.some(([, n]) => n === 'guidance') && calls.some(([, n]) => n === 'labels'))
  }
})

test('placeholders are filled, a value kept as written, and the card tool text fits the 4096 characters Claude Code gives a tool description, with a long temp folder', () => {
  // placeholders are filled, and a value is kept as written
  {
    assert.equal(fill('a {{X}} b {{Y}} c {{Z}}', { X: 1, Y: () => 'two' }), 'a 1 b two c {{Z}}')
    assert.equal(fill('{{X}}', { X: '$& $1' }), '$& $1')
  }
  // the card tool text fits the 4096 characters Claude Code gives a tool description, with a long temp folder
  {
    const text = fill(readFileSync(join(ROOT, fileOf('card-tool')), 'utf8'), { TMPDIR: `/${'x'.repeat(99)}`, KEPT: 'v, r, l, f, F, p or u' }).trim()
    assert.ok(text.length <= 4096, `${text.length} characters`)
  }
})

test("a mode reads a text with what it includes in place and the mode's words in its slots, and leaves its readers' slots for their call", async () => {
  const files = { checker: 'Check {{REPLY}} as {{WHO}} checks.\n{{include:part}}\nThen {{MARKS}}.\n', part: 'A part, by {{WHO}}.\n\n', loop: '{{include:back}}', back: 'x {{include:loop}}' }
  const read = name => files[name]
  const slots = { WHO: { terminal: 'the plugin', browser: 'the workbench' } }
  // what it includes stands in its place without its closing newlines, and each mode's words stand in its slots
  {
    assert.equal(await compose('checker', 'terminal', read, () => slots), 'Check {{REPLY}} as the plugin checks.\nA part, by the plugin.\nThen {{MARKS}}.\n')
    assert.equal(await compose('checker', 'browser', read, () => slots), 'Check {{REPLY}} as the workbench checks.\nA part, by the workbench.\nThen {{MARKS}}.\n')
  }
  // slots.json is read only for a text with a slot its readers do not fill, so a text with none needs no such file
  {
    const never = () => { throw new Error('slots.json read') }
    assert.equal(await compose('checker', 'terminal', () => 'Check {{MARKS}} in {{CWD}}.', never), 'Check {{MARKS}} in {{CWD}}.')
  }
  // a slot with no words in the mode, and an include cycle, fail with the file
  {
    await assert.rejects(compose('checker', 'browser', read, () => ({ WHO: { terminal: 'the plugin' } })), /prompts\/checker\.md: the slot \{\{WHO\}\} has no browser value/)
    await assert.rejects(compose('loop', 'terminal', read, () => slots), /include cycle loop -> back -> loop/)
  }
})

test("every text reads in each mode with what it includes and slots.json's words, and what is left of its slots is its readers'", async () => {
  for (const name of Object.keys(TEXTS)) {
    for (const mode of MODES) {
      const left = [...(await textOf(name, mode)).matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1])
      assert.deepEqual(left.filter(k => !(TEXTS[name].fills ?? []).includes(k)), [], `${name} in the ${mode}`)
    }
  }
})

test("each section that guidance/guidance.ts leaves out with its feature off is a heading of guidance.md", () => {
  const src = readFileSync(join(ROOT, 'guidance', 'guidance.ts'), 'utf8')
  const headings = [...(/const SECTIONS[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(headings, ['Citing claims', 'Cards'])
  const text = readFileSync(join(ROOT, fileOf('guidance')), 'utf8')
  for (const h of headings) assert.match(text, new RegExp(`^## ${h}$`, 'm'), `guidance.md has ## ${h}`)
})
