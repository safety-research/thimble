// Telemetry's lines and `lean stats` (telemetry/events.mjs, stats.mjs): a call's and a turn's line, the price weights,
// the sums per feature and per lens of the pass, a plain Claude Code transcript per prompt, and the report beside it.
//   node --test lean/telemetry/test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { callLine, eventsFile, parseLines, plainTurns, summarize, turnLine, usageOf, weighted } from '../events.mjs'
import { findEvents, report } from '../stats.mjs'

const STATS = fileURLToPath(new URL('../stats.mjs', import.meta.url))
const U = (i, cw, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o })

test('price weights: input 1, cache write 1.25, cache read 0.1, output 5', () => {
  assert.deepEqual(weighted(U(1000, 1000, 10000, 100)), { input: 1000 + 1250 + 1000, output: 500, total: 3750 })
  assert.deepEqual(weighted(null), { input: 0, output: 0, total: 0 })
  assert.deepEqual(usageOf({ input_tokens: 3, junk: 1 }), U(3, 0, 0, 0))
})

test("a call's line names the feature, the prompt version, the model, the four counts, the time and whether it blocked", () => {
  const l = callLine({ feature: 'squeeze', prompt: 'squeeze:v2', model: 'sonnet', usage: U(10, 0, 5, 2), ms: 1234.4, extra: 1 })
  assert.deepEqual(l, { kind: 'call', feature: 'squeeze', prompt: 'squeeze:v2', model: 'sonnet', usage: U(10, 0, 5, 2), ms: 1234, blocked: false, ok: true, extra: 1 })
  const t = turnLine({ feature: 'visualize', ms: 20000, usage: U(1, 2, 3, 4), hook_ms: 41.6 })
  assert.equal(t.kind, 'turn')
  assert.equal(t.agent, null)
  assert.equal(t.hook_ms, 42)
  assert.equal(eventsFile('/h/', 'a b/c'), '/h/lean/events/a-b-c.jsonl')
})

const EVENTS = [
  { kind: 'prompts', active: { observer: 'v2' }, changed: 'forms:principles', problems: [] },
  turnLine({ feature: 'main', ms: 60000, usage: U(2000, 10000, 50000, 3000), hook_ms: 120 }),
  callLine({ feature: 'question', prompt: 'question:v1', usage: U(2000, 0, 0, 100), ms: 2000 }),
  callLine({ feature: 'observer', prompt: 'observer:v2', usage: U(10000, 9000, 0, 2000), ms: 30000,
    lenses: { notes: { in: 1000, out: 0 }, claims: { in: 3000, out: 1500 }, explain: { in: 1000, out: 500 } }, shared_in: 5000, shared_out: 0 }),
  callLine({ feature: 'squeeze', prompt: 'squeeze:v2', usage: U(3000, 0, 0, 400), ms: 3000 }),
  turnLine({ feature: 'visualize', ms: 25000, usage: U(1000, 5000, 60000, 2000), hook_ms: 30 }),
  turnLine({ feature: 'thread', agent: 'a1', ms: 9000, usage: U(500, 0, 0, 200) }),
  { kind: 'prompt', feature: 'forms', prompt: 'forms:principles', via: 'lean guide cards' },
]

test('the sums per feature, the main turns with the time thimble added, and each lens with its share of the pass', () => {
  const s = summarize(EVENTS)
  const f = s.features
  assert.equal(f['main turns'].calls, 1)
  assert.equal(f['main turns'].hook_ms, 120)
  assert.equal(f['visualize (main turns)'].calls, 1)
  assert.equal(f.thread.calls, 1)
  assert.equal(f.thread.main, false)
  const obs = f.observer
  assert.equal(Math.round(obs.w), Math.round(weighted(U(10000, 9000, 0, 2000)).total))
  // the lens rows and the shared row add up to the pass
  const sum = Object.values(obs.lenses).reduce((a, L) => a + L.w, 0)
  assert.ok(Math.abs(sum - obs.w) < 1e-6)
  // claims put in 3,000 of 10,000 characters and took 1,500 of 2,000 out
  const w = weighted(U(10000, 9000, 0, 2000))
  assert.ok(Math.abs(obs.lenses.claims.w - (0.3 * w.input + 0.75 * w.output)) < 1e-6)
  assert.equal(s.reads.length, 1)
})

test('a plain Claude Code transcript, per prompt typed: its time and its tokens, each response once', () => {
  const lines = [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'first question' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:05Z', message: { id: 'm1', usage: U(100, 1000, 0, 50) } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:06Z', message: { id: 'm1', usage: U(100, 1000, 0, 80) } },
    { type: 'user', timestamp: '2026-01-01T00:00:07Z', message: { content: [{ type: 'tool_result' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-01-01T00:00:30Z', durationMs: 30000 },
    { type: 'user', timestamp: '2026-01-01T00:01:00Z', message: { content: '<command-name>x</command-name>' } },
    { type: 'user', timestamp: '2026-01-01T00:02:00Z', message: { content: 'second' } },
    { type: 'assistant', timestamp: '2026-01-01T00:02:05Z', message: { id: 'm2', usage: U(10, 0, 1000, 10) } },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-01-01T00:02:10Z', durationMs: 10000 },
  ]
  const t = plainTurns(lines)
  assert.deepEqual(t.map(x => x.text), ['first question', 'second'])
  assert.equal(t[0].w, weighted(U(100, 1000, 0, 80)).total)
  assert.deepEqual(t.map(x => x.ms), [30000, 10000])
})

test('`lean stats`: per feature and per lens, and against a plain transcript the main turns, the whole and the hooks', () => {
  const plain = [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'q' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { id: 'p1', usage: U(2000, 10000, 40000, 3000) } },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-01-01T00:00:50Z', durationMs: 50000 },
  ]
  const r = report(EVENTS.map(e => ({ session: 's-123456789', ...e })), { plain })
  const text = r.lines.join('\n')
  assert.match(text, /^thimble · session s-123456/)
  assert.match(text, /prompts: not the defaults: forms:principles/)
  assert.match(text, /\n {2}thimble hooks inside them\s+0\.1s/)
  assert.match(text, /\nobserver\s+1\s+\S+k\s+30s\s+0 of 1 · observer:v2/)
  assert.match(text, /\n {2}lens claims\s/)
  assert.match(text, /\nsqueeze\s+1\s/)
  assert.match(text, /against plain Claude Code \(1 turns in the transcript, 2 main turns here\)/)
  assert.match(text, /thimble's hooks took 0\.1s of the main turns' time/)
  assert.match(text, /read on demand: forms:principles \(lean guide cards\)/)
  assert.equal(r.out.plain.hook_ms, 150)
})

test('the command finds the newest session in THIMBLE_HOME, or one by id, and says so when there is none', () => {
  const home = mkdtempSync(join(tmpdir(), 'stats-'))
  const env = { PATH: process.env.PATH, THIMBLE_HOME: home }
  const none = spawnSync(process.execPath, [STATS], { encoding: 'utf8', env })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /^lean stats: no events yet/)
  mkdirSync(join(home, 'lean', 'events'), { recursive: true })
  writeFileSync(join(home, 'lean', 'events', 's-1.jsonl'), EVENTS.map(e => JSON.stringify({ session: 's-1', ...e })).join('\n') + '\n')
  assert.equal(findEvents('s-1', env), join(home, 'lean', 'events', 's-1.jsonl'))
  const r = spawnSync(process.execPath, [STATS, '--json'], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.session, 's-1')
  assert.ok(out.features.some(f => f.feature === 'observer' && f.lenses.claims))
  assert.deepEqual(parseLines('{"a":1}\n{bad\n\n{"b":2}'), [{ a: 1 }, { b: 2 }])
})

test('lean stats counts the looks: how often v lit and how often the person pressed it; a shadow pass is its own row, outside all', () => {
  const U2 = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const events = [
    turnLine({ feature: 'main', ms: 10000, usage: U2 }), turnLine({ feature: 'main', ms: 10000, usage: U2 }),
    callLine({ feature: 'observer', prompt: 'observer:v2-low', usage: U2, ms: 5000 }),
    { ...callLine({ feature: 'observer', prompt: 'observer:v2', usage: { ...U2, output_tokens: 900 }, ms: 9000 }), shadow: 'observer:v2' },
    { kind: 'look', turn: 1, lit: ['v'], v: { note: 'saves by day', proposals: ['saves per day'] } },
    { kind: 'look', turn: 2, lit: [] },
    { kind: 'look', turn: 3, skip: 'no work, no decision, no drift' },
    { kind: 'look', turn: 1, shadow: 'observer:v2', lit: ['v'], v: {} },
    { kind: 'look', turn: 2, shadow: 'observer:v2', lit: ['v'], v: {} },
    { kind: 'press', verb: 'v', row: 'r1', lit: true },
    { kind: 'press', verb: 'v', row: 'r2', lit: false },
  ]
  const s = summarize(events)
  assert.deepEqual(s.looks, { looks: 2, skipped: 1, v_lit: 1, pressed_lit: 1, pressed_dim: 1, shadow: { 'observer:v2': { looks: 2, skipped: 0, v_lit: 2 } } })
  const text = report(events).lines.join('\n')
  assert.match(text, /\nobserver \(shadow\)\s+1\s+\S+k\s+9.0s\s+measured only, not in all · observer:v2/)
  // all: the two turns and the pass, not the shadow (2 × 2.0k + 2.0k)
  assert.match(text, /\nall\s+6\.0k/)
  assert.match(text, /\nper main turn\s+3\.0k in all · the pass 1\.0k \(33% of all\)/)
  assert.match(text, /\nlooks\s+v lit on 1 of 2 looks \(1 skipped\) · v pressed 1 of 1 times lit, 1 while dim/)
  assert.match(text, /\nlooks \(shadow\)\s+v lit on 2 of 2 · observer:v2/)
})
