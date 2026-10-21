// The model's reads of a --prompt label (shell/labelreads.mjs): what a reply says of each record, and whole reads
// against the real kernel with a stand-in model.
//   node --test shell/test/labels.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { answersOf, failedCall, readLabel, summary } from '../labelreads.mjs'
import { prep } from '../node/prep.mjs'
import { renderTerm } from '../../draw/term.js'
import { defLine, howMade, place, program as labelPanel, toneBeside, tonesIn, valueTone } from '../../panes/labels.js'
import { gridText } from '../../draw/term.js'
import '../../draw/kit.js'

const LEAN = fileURLToPath(new URL('../../bin/thimble', import.meta.url))
const LABEL = { name: 'apology', definition: 'The message apologizes.', values: ['yes', 'no'], reason: true }
const UNITS = [{ ref: 'a.jsonl#L1', text: 'Sorry, my mistake.' }, { ref: 'a.jsonl#L2', text: 'Merged.' }, { ref: 'a.jsonl#L3', text: 'Done.' }]

test('a reply gives each record its value; one it leaves out, or gives a value off the list, has none and says why', () => {
  const text = 'Here:\n```json\n[{"i": 1, "value": "Yes", "confidence": 0.9, "reason": "says sorry"}, {"i": 3, "value": "maybe"}]\n```'
  const got = answersOf(text, UNITS, LABEL.values)
  assert.deepEqual(got.values, { 'a.jsonl#L1': { value: 'yes', confidence: 0.9, reason: 'says sorry' } })
  assert.equal(got.failed['a.jsonl#L2'], 'the reply gave this record no value')
  assert.match(got.failed['a.jsonl#L3'], /"maybe", which is not one of yes, no/)
  assert.deepEqual(Object.keys(answersOf('no json here', UNITS, LABEL.values).failed), UNITS.map(u => u.ref))
  assert.equal(failedCall({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' }, UNITS).failed['a.jsonl#L2'], 'the call failed: api-error 529 (overloaded_error)')
  assert.equal(failedCall({ isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed' }, UNITS).failed['a.jsonl#L2'], 'the call failed: the sign-in failed or expired; sign in again with /login')
  assert.equal(summary('apology', { valued: 1, records: 3, counts: { yes: 1 }, waiting: 0, failed: 2, why: '1 call failed: api-error 529' }),
    'apology: 1 of 3 records have a value (1 yes). 2 have no value (1 call failed: api-error 529): `thimble label apology --again` asks the model again.')
})

/** A Python with pandas for the kernel's counts, or null. */
function python() {
  for (const p of [process.env.THIMBLE_PYTHON, fileURLToPath(new URL('../../.venv/bin/python', import.meta.url)), 'python3']) {
    if (!p || (p.includes('/') && !existsSync(p))) continue
    if (spawnSync(p, ['-c', 'import pandas'], { encoding: 'utf8' }).status === 0) return p
  }
  return null
}

test('reads: the calls of a wave go out together; with their answers the values are written, the card is saved again, and a failed call leaves its records with no value', { skip: !python() && 'no Python with pandas' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'label-reads-'))
  mkdirSync(join(root, 'chat'))
  const lines = ['I am sorry, I broke it.', 'Merged the fix.', 'My mistake, reverting.', 'All tests pass.']
  writeFileSync(join(root, 'chat', 'room.jsonl'), lines.map((t, i) => JSON.stringify({ agent: i % 2 ? 'moss' : 'wren', text: t })).join('\n') + '\n')
  const env = { ...process.env, THIMBLE_ROOT: root, THIMBLE_PYTHON: python(), THIMBLE_SESSION: 'test-label' }
  const kernel = async (args, input) => {
    const r = spawnSync(LEAN, args, { cwd: root, env, input: input ?? '', encoding: 'utf8' })
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
  }
  const k = spawnSync(LEAN, ['label', 'apology', '--in', 'chat/*.jsonl', '--prompt', 'The message apologizes.'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(k.status, 0, k.stdout + k.stderr)
  // the four records make one call
  const waves = []
  const seen = []
  const answer = async (reqs, each) => {
    waves.push(reqs)
    const out = reqs.map(req => {
      const recs = req.prompt.split('### record ').slice(1)
      return { isAnswered: true, text: JSON.stringify(recs.map((r, i) => ({ i: i + 1, value: /sorry|mistake/i.test(r) ? 'yes' : 'no', confidence: 0.8 }))) }
    })
    for (const [i, r] of out.entries()) await each(i, r)
    return out
  }
  const out = await readLabel({ name: 'apology', kernel, callAll: answer, template: '{{RECORDS}}', progress: p => { seen.push(p) } })
  assert.equal(waves.length, 1)
  assert.equal(waves[0].length, 1)
  assert.equal(waves[0][0].units, 4)
  assert.deepEqual(seen, [{ done: 0, of: 4, failed: 0 }, { done: 4, of: 4, failed: 0 }])
  assert.equal(out.text, 'apology: 4 of 4 records have a value (2 yes, 2 no).')
  assert.match(out.card.id, /label-apology$/)
  assert.equal(out.card.v, 2)
  assert.equal(out.failed, undefined)
  const s = JSON.parse(spawnSync(LEAN, ['label', 'apology', '--json'], { cwd: root, env, encoding: 'utf8' }).stdout)
  assert.deepEqual(s.counts, { yes: 2, no: 2 })
  // again, with the call failing: its records have no value, and the reads say so
  spawnSync(LEAN, ['label', 'apology', '--in', 'chat/*.jsonl', '--prompt', 'The message apologizes to a person.'], { cwd: root, env, encoding: 'utf8' })
  const busy = async (reqs, each) => {
    const out = reqs.map(() => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' }))
    for (const [i, r] of out.entries()) await each(i, r)
    return out
  }
  const failed = await readLabel({ name: 'apology', kernel, callAll: busy, template: '{{RECORDS}}' })
  assert.equal(failed.failed, true)
  assert.match(failed.text, /^apology: 0 of 4 records have a value\. 4 have no value \(1 call failed: api-error 529 \(overloaded_error\)\): `thimble label apology --again` asks the model again\.$/)
})

test('a label\'s values have one color: on a chart made from its rows, in the row beside the chart, and in its panel', async () => {
  const label = { name: 'is-urgent', values: ['yes', 'no'] }
  const rows = [['Mon', 'yes', 4], ['Mon', 'no', 9], ['Tue', 'yes', 2], ['Tue', 'no', 5]].map(([day, urgent, n]) => ({ day, urgent, n, _ref: `r7#day=${day}&urgent=${urgent}` }))
  // the program picks colors of its own, and words that are not the values
  const object = { id: '03-urgent', title: 'Urgent tickets per day', lineage: { queries: { r7: { labels: ['is-urgent'] } } }, data: { rows }, program: `
    const days = [...new Set(data.rows.map(r => r.day))]
    return k.bars(days.map(d => ({ id: 'day-' + d, label: d, parts: data.rows.filter(r => r.day === d).map(r => ({ ...r, value: r.n, tone: r.urgent === 'yes' ? 'c1' : 'dim', label: r.urgent === 'yes' ? 'urgent' : 'not urgent' })) })))` }
  const { drawing } = await prep({ object, w: 60, labels: [{ ...label, queries: ['r7'] }] })
  const grid = renderTerm(drawing, { w: 60 })
  const at = word => { const y = grid.rows.findIndex(r => r.map(c => c.ch).join('').includes(word)); const x = grid.rows[y].map(c => c.ch).join('').indexOf(word); return grid.rows[y][x - 2].tone }
  const panel = Object.fromEntries(label.values.map(v => [v, valueTone(label.values, v)]))
  assert.deepEqual({ yes: at('urgent'), no: at('not urgent') }, panel)
  const bars = new Set(grid.rows.flat().filter(c => c.ch === '█' || c.ch === '▆' || c.ch === '▇').map(c => c.tone))
  assert.deepEqual([...bars].sort(), Object.values(panel).sort())
  assert.deepEqual(label.values.map(v => toneBeside({ ...label, tones: { no: 'dim' } }, v)), label.values.map(v => panel[v]))
})

test('a bar the program made itself, named by a label\'s value, has the label\'s color for it, and the row under the card names it in that color', async () => {
  const label = { name: 'size', values: ['small', 'large', 'unknown'] }
  const rows = [['small', 61], ['large', 32], ['unknown', 20]].map(([size, rate]) => ({ size, rate, _ref: `r3#size=${size}` }))
  // new objects with no row behind them, in colors of the program's own, as a card often builds its rows
  const object = { id: '05-size', title: 'Share kept, by size', lineage: { queries: { r3: { labels: ['size'] } } }, data: { rows }, program: `
    const tone = s => s === 'small' ? 'c1' : s === 'large' ? 'c2' : 'dim'
    return k.stack(k.legend(data.rows.map(r => ({ label: r.size, tone: tone(r.size) }))), k.bars(data.rows.map(r => ({ id: 'all-' + r.size, label: r.size, value: r.rate, tone: tone(r.size) })), { max: 100 }))` }
  const { drawing } = await prep({ object, w: 60, labels: [{ ...label, queries: ['r3'] }] })
  assert.equal(drawing.error, undefined)
  const grid = renderTerm(drawing, { w: 60 })
  const panel = Object.fromEntries(label.values.map(v => [v, valueTone(label.values, v)]))
  // each bar, in the order of its rows, and each name in the key
  const bars = grid.rows.slice(1).map(r => r.find(c => c.ch === '█' || c.ch === '▆' || c.ch === '▇')).filter(Boolean).map(c => c.tone)
  assert.deepEqual(bars, label.values.map(v => panel[v]))
  const key = grid.rows[0].filter(c => c.ch === '■').map(c => c.tone)
  assert.deepEqual(key, label.values.map(v => panel[v]))
  // the drawing keeps the colors it gave, so the row under the card has them too
  assert.deepEqual(tonesIn({ rows: [], labelTones: drawing.labelTones }, label.values, 'size'), panel)
  assert.deepEqual(grid.labelTones, { size: panel })
  // a value two labels color apart keeps the program's own color
  const two = await prep({ object, w: 60, labels: [{ ...label, queries: ['r3'] }, { name: 'other', values: ['large', 'small', 'unknown'], queries: ['r3'] }] })
  const grid2 = renderTerm(two.drawing, { w: 60 })
  assert.deepEqual(grid2.rows.slice(1).map(r => r.find(c => c.ch === '█' || c.ch === '▆' || c.ch === '▇')).filter(Boolean).map(c => c.tone), ['c1', 'c2', panel.unknown])
})

test('a label says what made it in plain names, and its panel shows the definition under its head until it is folded', () => {
  assert.deepEqual(['regex', 'code', 'prompt'].map(howMade), ['regex', 'code', 'read by Claude'])
  const code = "def label(unit):\n    t = unit['text']\n    if 'http' in t:\n        return ('yes', 1.0)\n    return ('no', 1.0)\n"
  // beside a card: one line, cut with … where it does not fit
  assert.equal(defLine({ kind: 'code', rule: code }, 80), "t = unit['text']; if 'http' in t: return ('yes', 1.0); return ('no', 1.0)")
  assert.equal(defLine({ kind: 'prompt', rule: 'The message links\nto a web page.' }, 20), 'The message links t…')
  assert.equal(defLine({ kind: 'regex', rule: 'https?://' }, 20), 'https?://')
  const lab = { name: 'has-link', kind: 'code', rule: code, in: 'chat/*.jsonl', values: ['yes', 'no'], counts: {}, records: 0 }
  const draw = state => {
    const d = globalThis.DrawKit.run(labelPanel, { list: [lab], gen: 0, w: 80, h: 40 }, { w: 80, h: 40, state, mode: 'pane', surface: 'terminal' })
    assert.equal(d.error, undefined, JSON.stringify(d.error))
    return { text: gridText(renderTerm(d, { w: 80 })), on: (d.on || []).map(h => h.name) }
  }
  // open by default: the code's first lines under the head, the rest a press away
  const open = draw({ open: 'has-link' })
  const lines = open.text.split('\n')
  const head = lines.findIndex(l => l.includes('label over chat/*.jsonl · code ·'))
  assert.ok(head > 0, open.text)
  assert.match(lines[head + 1], /def label\(unit\):/)
  assert.match(lines[head + 4], /return \('yes', 1\.0\)/)
  assert.match(lines[head + 5], /… 1 more line · show all/)
  assert.ok(open.on.includes('act:def:on'))
  // whole, and folded by the Definition action
  assert.match(draw({ open: 'has-link', whole: true }).text, /return \('no', 1\.0\)[\s\S]*show less/)
  const folded = draw({ open: 'has-link', fold: true })
  assert.doesNotMatch(folded.text, /def label/)
  assert.ok(folded.on.includes('act:def'))
})

test('a record in the Labels pane is named by its path in the folder, cut from the left when long', () => {
  // files of one name in different folders stay apart
  assert.equal(place('prompts/labels/v2.md#L1-27'), 'prompts/labels/v2.md:1')
  assert.equal(place('prompts/notes/v2.md#L1-9'), 'prompts/notes/v2.md:1')
  assert.equal(place('db/forge.db#prs/12'), 'db/forge.db#prs/12')
  // a long place keeps its file's name and line, cut at a folder
  const long = place('plugin/prompts/observer-turn/v2.md#L1-40', 24)
  assert.equal(long, '…/observer-turn/v2.md:1')
  assert.ok(Array.from(long).length <= 24)
})
