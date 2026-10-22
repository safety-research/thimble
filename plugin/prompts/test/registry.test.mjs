// The prompt registry (prompts/registry.mjs, node.mjs): every model-read text is one file, every file in prompts/ is a
// text the registry names, and each text is read by the module the registry names.
//   node --test plugin/prompts/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { TEXTS, fileOf, fill, listing } from '../registry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The plugin's hooks sources, as [path from the plugin's root, text]. */
function sources(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return d.name === 'node_modules' || d.name === 'tests' || d.name === 'test' ? [] : sources(p)
    return /\.(ts|tsx|mjs|js)$/.test(d.name) ? [[relative(ROOT, p), readFileSync(p, 'utf8')]] : []
  })
}

test('the texts are the guidance, the card tool, the checker, the designer and the label classifier', () => {
  assert.deepEqual(Object.keys(TEXTS), ['guidance', 'card-tool', 'checker', 'designer', 'labels'])
  assert.equal(fileOf('checker'), 'prompts/checker.md')
})

test('every text has its file with text, and every file in prompts/ is a text', () => {
  for (const name of Object.keys(TEXTS)) assert.ok(readFileSync(join(ROOT, fileOf(name)), 'utf8').trim().length > 0, `${name} has text`)
  for (const file of readdirSync(join(ROOT, 'prompts')).filter(x => x.endsWith('.md'))) assert.ok(TEXTS[file.replace(/\.md$/, '')], `prompts/${file} is a text`)
})

test('each text is read where the registry says: every promptText call names its text and is in its reader', () => {
  const calls = sources().flatMap(([file, src]) => [...src.matchAll(/promptText\(\$, '([^']+)'\)/g)].map(m => [file, m[1]]))
  assert.ok(calls.length > 0)
  for (const [file, name] of calls) {
    assert.ok(TEXTS[name], `${file} reads ${name}, a text of the registry`)
    assert.equal(TEXTS[name].reader, file, `the registry names ${file} as what reads ${name}`)
  }
  assert.ok(calls.some(([, n]) => n === 'guidance') && calls.some(([, n]) => n === 'labels'))
})

test('`thimble dev prompts` lists each text with its file and reader', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'prompts/node.mjs'), 'prompts'], { encoding: 'utf8' })
  assert.equal(listing().length, Object.keys(TEXTS).length)
  for (const [name, t] of Object.entries(TEXTS)) assert.match(out, new RegExp(`^${name} +${fileOf(name)} +${t.reader} `, 'm'))
})

test('placeholders are filled, and a value is kept as written', () => {
  assert.equal(fill('a {{X}} b {{Y}} c {{Z}}', { X: 1, Y: () => 'two' }), 'a 1 b two c {{Z}}')
  assert.equal(fill('{{X}}', { X: '$& $1' }), '$& $1')
})

test('the card tool text fits the 4096 characters Claude Code gives a tool description, with a long temp folder', () => {
  const text = fill(readFileSync(join(ROOT, fileOf('card-tool')), 'utf8'), { TMPDIR: `/${'x'.repeat(99)}`, KEPT: 'v, r, l, f, F, p or u' }).trim()
  assert.ok(text.length <= 4096, `${text.length} characters`)
})

test("each section that guidance/guidance.ts leaves out with its feature off is a heading of guidance.md", () => {
  const src = readFileSync(join(ROOT, 'guidance', 'guidance.ts'), 'utf8')
  const headings = [...(/const SECTIONS[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(headings, ['Citing claims', 'Cards'])
  const text = readFileSync(join(ROOT, fileOf('guidance')), 'utf8')
  for (const h of headings) assert.match(text, new RegExp(`^## ${h}$`, 'm'), `guidance.md has ## ${h}`)
})
