// The tray's keys say what they do: ] names what it goes to, an explainer names no key for the citations inside it (a
// click opens them), and the code section explains load and tally under the code the first time a session opens one.
//   node --test panes/test/traykeys.test.mjs
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { program } from '../tray.js'
import { codeMarkup, drawnCard, HELPERS_NOTE, sourceCard } from '../../shell/cards.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'

const DK = globalThis.DrawKit
const CITE = [{ row: 'm2', i: 0, kind: 'cite', ref: 'q1#day=2026-06-18@n', label: '640' }]
const GLOSS = [{ row: 'm2', i: 1, kind: 'gloss', label: 'revert war', gloss: { id: 'g1', term: 'revert war', body: 'Two editors undo each other.' } }]

/** The tray drawn on `stack` with the host's `card`, after `key` when given: its drawing and its keys' words. */
function tray(stack, card, { steps = { next: true, prev: true }, state = {}, key } = {}) {
  const opts = { w: 90, h: 20, mode: 'pane', state: { stack, ...state } }
  const want = DK.run(program, { threads: [], steps }, opts).wants[0].key
  const d = DK.run(program, { threads: [], steps }, { ...opts, got: { [want]: card }, ...(key ? { event: { type: 'key', key } } : {}) })
  assert.equal(d.error, undefined, d.error && d.error.message)
  const after = key ? DK.run(program, { threads: [], steps }, { ...opts, state: d.state, got: { [want]: card } }) : d
  return { d: after, state: d.state, keys: (after.on || []).filter(h => h.label).map(h => `${h.name} ${h.label}`), text: gridText(renderTerm(after, { w: 90 })) }
}

const draw = p => runProgram(p, { w: 84, h: 20, mode: 'pane' })
const QUERY = { id: 'r1', about: 'saves per day', keys: ['day'], code: 'df = load("revisions.jsonl", fields=["time"])\ndf["day"] = df.time.str[:10]  # the day\ntally(df, "day")', table: [{ day: '2026-06-18', n: 640 }, { day: '2026-06-19', n: 12 }], inputs: [{ path: 'revisions.jsonl', rows_read: 14591 }], lineage: 'exact' }
const RESOLVED = { ref: 'r1#day=2026-06-18@n', count: 640, rows: ['revisions.jsonl#L1-640'], records: [{ ref: 'revisions.jsonl#L1', text: 'a save' }], chain: [{ step: 'query', id: 'r1' }], unit: 'records', unit_one: 'record' }

test('] names what it goes to, and [ at the last stop names what is before', () => {
  const card = { title: '640', right: 'cite · revisions.jsonl', drawings: [], sections: [], links: [] }
  assert.ok(tray(CITE, card, { steps: { next: true, prev: false, nextWhat: 'explainer' } }).keys.includes('] next explainer'))
  assert.ok(tray(CITE, card, { steps: { next: false, prev: true, prevWhat: 'card' } }).keys.includes('[ previous card'))
  // a host that does not say what comes next: the plain word
  assert.ok(tray(CITE, card, { steps: { next: true, prev: true } }).keys.includes('] next'))
})

test('an explainer names no key for the citations inside it: a click on one opens it over the card', () => {
  const card = { title: 'revert war', right: 'explain', drawings: [], sections: [], links: [{ id: 'l1', ref: 'revisions.jsonl#L41', label: 'the first revert of the page Alpha by an editor who came back' }] }
  const t = tray(GLOSS, card)
  assert.ok(!t.keys.some(k => k.startsWith('o ')), t.keys.join(' · '))
  assert.ok(!t.text.includes('open the first'), t.text)
})

test("a citation of a query's number: the code alone behind c, colored, with no rows section, files line or lineage", async () => {
  const spec = sourceCard({ ref: 'r1#day=2026-06-18@n', label: '640', resolved: RESOLVED, query: QUERY })
  assert.deepEqual(spec.sections.map(s => s.id), ['code'])
  assert.equal(spec.sections[0].note, HELPERS_NOTE)
  // the rows behind the value come back only when asked for
  assert.deepEqual(sourceCard({ ref: 'r1#day=2026-06-18@n', label: '640', resolved: RESOLVED, query: QUERY, rows: true }).sections.map(s => s.id), ['rows', 'code'])
  assert.equal(codeMarkup('df = load("a.jsonl")  # rows'), 'df = load({c6:"a.jsonl"})  {dim:# rows}')
  assert.equal(codeMarkup('if n > 3.5 and not x: return None'), '{c2:if} n > {c3:3.5} {c2:and} {c2:not} x: {c2:return} {c2:None}')
  const card = await drawnCard(spec, draw)
  const first = tray(CITE, card, { key: 'c' })
  assert.equal(first.state.noted, true)
  assert.match(first.text, /tally\(df, "day"\)/)
  assert.ok(first.text.includes(HELPERS_NOTE), first.text)
  assert.ok(!/reads revisions|lineage|source records/.test(first.text), first.text)
  // the next card's code, once the session has seen the note: the code alone
  const later = tray(CITE, card, { key: 'c', state: { noted: true } })
  assert.ok(!later.text.includes(HELPERS_NOTE), later.text)
  assert.match(later.text, /tally\(df, "day"\)/)
})
