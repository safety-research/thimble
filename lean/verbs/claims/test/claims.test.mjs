// The Claims verb: the fork's claims parsed, each placed by its words with the citations near it, a restatement
// counted (×N), a correction linked both ways, clusters assigned, renamed and split, the corpus orientation merged,
// the estimate it is offered with, and its citation check.
// node --test lean/verbs/claims/test/
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseAnswer } from '../../../observer/evidence.js'
import { applyTurn, claimsAt, clusterFor, tagOf, timeline, emptyStore, findQuote, grownClusters, likeness, locate, mergeOrientation, noteFor, noteGap, parseClaims, plainOf, promptLines, readStore, sentenceAt, shortRef, sourcesNear, viewOf } from '../claims.js'
import { cmdCheck, cmdSave, showLines } from '../cli.mjs'
import { cost, estimate, looksLikeTranscript, runsOf } from '../estimate.mjs'
import { askFor, loadStore, run, storeFile } from '../run.mjs'
import { check, kindOf, relationOf, specFor } from '../shape.mjs'

const line = (type, text) => JSON.stringify({ type, sessionId: 's1', message: { role: type, content: [{ type: 'text', text }] } })

function runsFolder(n = 3) {
  const root = mkdtempSync(join(tmpdir(), 'claims-'))
  mkdirSync(join(root, 'trials'))
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(root, 'trials', `t${i}.jsonl`), [line('user', 'sort the parcels'), line('assistant', i === 2 ? 'First guess: the scale is off.' : 'The belt skips a slot; fixed it by pinning the belt.')].join('\n') + '\n')
  }
  writeFileSync(join(root, 'notes.md'), '# notes\n')
  return root
}

// a made-up wiki: the person's question and two of Claude's messages in turn 1
const Q1 = 'was there any bias in the edits? who drove it?'
const A1 = 'Yes. **The tilt is one editor.** Kestrel made [41%](q4#user=Kestrel@share) of June\'s edits, and [212 of them](q7#user=Kestrel@n) were reverts.\n\n- June 18 had [6,543 saves](q1#day=2026-06-18@n), the busiest day.\n- Bots made [4%](q5#bot=yes@share) of edits.'
const PLACES1 = [{ row: 'u1', by: 'person', turn: 1, text: Q1 }, { row: 'r1', by: 'claude', turn: 1, text: 'Let me count the edits per user.' }, { row: 'r2', by: 'claude', turn: 1, text: A1 }]
const OUT1 = { claims: [
  { claim: 'The tilt in the edits is one editor', quote: 'The tilt is one editor', kind: 'judgment', cluster: 'testing for bias' },
  { claim: "Kestrel made 41% of June's edits", quote: "Kestrel made 41% of June's edits", kind: 'finding', cluster: 'finding who edited' },
  { claim: 'June 18 had 6,543 saves, the busiest day', quote: 'June 18 had 6,543 saves', kind: 'event', cluster: 'the June 18 burst' },
  { claim: 'Bots made 4% of edits', quote: 'Bots made 4% of edits', kind: 'finding', cluster: 'ruling out bots' },
] }

function turn1() {
  const store = emptyStore('s1')
  const res = applyTurn(store, { places: PLACES1, out: OUT1, turn: 1, at: '2026-10-18T10:00:00Z' })
  return { store, res }
}

// ------------------------------------------------------------------------------------------------ parsing

test('the fork\'s claims are read as given, held to what the store needs: a claim or a "same", a quote, who said it', () => {
  const got = parseClaims([
    { claim: '  June 18 had   6,543 saves ', quote: 'June 18 had 6,543 saves', kind: 'Event', cluster: 'k1' },
    { same: 'c2', quote: 'the edits were biased', by: 'person' },
    { claim: 'A correction', quote: 'it is two editors', kind: 'judgement call', revises: 'c1', by: 'Person' },
    { claim: 'no quote' },
    { quote: 'no claim and no same' },
    'not an object',
  ])
  assert.deepEqual(got.map(x => [x.text, x.by, x.kind, x.same, x.revises]), [
    ['June 18 had 6,543 saves', 'claude', 'event', null, null],
    ['', 'person', 'claim', 'c2', null],
    ['A correction', 'person', 'judgment', null, 'c1'],
  ])
  // the observer's answer keeps the claims and the clusters' renames for applyTurn
  const a = parseAnswer('{"notes": [], "line": null, "claims": [{"claim": "x", "quote": "y"}], "clusters": [{"id": "k1", "name": "z"}]}')
  assert.equal(a.claims.length, 1)
  assert.deepEqual(a.clusters, [{ id: 'k1', name: 'z' }])
  assert.deepEqual(parseAnswer('{"notes": []}').claims, [])
})

// ------------------------------------------------------------------------------------------------ where it was said

test('a quote is found in the words as read: a citation reads as its words, emphasis and curly quotes do not matter', () => {
  assert.equal(plainOf('**Yes.** see [41%](q4#a@b) and `code`').plain, 'Yes. see 41% and code')
  const hit = findQuote(A1, 'Kestrel made 41% of June’s edits')
  assert.equal(A1.slice(hit.start, hit.end), "Kestrel made [41%](q4#user=Kestrel@share) of June's edits")
  assert.equal(hit.exact, true)
  // words reordered: the sentence that holds most of them
  const fuzzy = findQuote(A1, 'the busiest day was June 18 with 6,543 saves')
  assert.equal(fuzzy.exact, false)
  assert.match(A1.slice(fuzzy.start, fuzzy.end), /^June 18 had \[6,543 saves\]/)
  assert.equal(findQuote(A1, 'nothing like this is said anywhere'), null)
  // a sentence ends at a stop or a line break, never inside a link
  const text = 'One. Two has [3.5 s](q1#a@b) here. Three.'
  const s = sentenceAt(text, 6, 9)
  assert.equal(text.slice(s.start, s.end), 'Two has [3.5 s](q1#a@b) here.')
})

test('its sources are the citations in its sentence, else the nearest in its block; each with its words', () => {
  const at = findQuote(A1, "Kestrel made 41% of June's edits")
  assert.deepEqual(sourcesNear(A1, at.start, at.end), [{ ref: 'q4#user=Kestrel@share', label: '41%' }, { ref: 'q7#user=Kestrel@n', label: '212 of them' }])
  const item = findQuote(A1, 'June 18 had 6,543 saves')
  assert.deepEqual(sourcesNear(A1, item.start, item.end).map(s => s.ref), ['q1#day=2026-06-18@n'])
  // a sentence with no citation of its own: the nearest two of its paragraph
  const tilt = findQuote(A1, 'The tilt is one editor')
  assert.deepEqual(sourcesNear(A1, tilt.start, tilt.end).map(s => s.ref), ['q4#user=Kestrel@share', 'q7#user=Kestrel@n'])
  assert.equal(shortRef('runs/r1/agents/a.jsonl#L12-L14'), 'a.jsonl:12-14')
  assert.equal(shortRef('q4#user=Kestrel@share'), 'q4 · user=Kestrel · share')
})

test('a claim is placed in the message that says it: the person\'s for theirs, else Claude\'s, newest first', () => {
  const mine = locate('any bias in the edits', PLACES1, 'person')
  assert.equal(mine.place.row, 'u1')
  assert.equal(mine.place.by, 'person')
  const theirs = locate('count the edits per user', PLACES1)
  assert.equal(theirs.place.row, 'r1')
  const w = locate('Bots made 4% of edits', PLACES1)
  assert.equal(w.place.quote, 'Bots made 4% of edits')
  assert.equal(w.place.sentence, 'Bots made 4% of edits.')
  assert.equal(A1.slice(w.place.start, w.place.end), 'Bots made [4%](q5#bot=yes@share) of edits')
  assert.equal(locate('not in any message at all here', PLACES1), null)
})

// ------------------------------------------------------------------------------------------------ a turn

test('a turn adds its claims, each with where it was said, its sources, its kind and a cluster named for the work', () => {
  const { store, res } = turn1()
  assert.deepEqual(res.added, ['c1', 'c2', 'c3', 'c4'])
  assert.deepEqual(store.clusters.map(c => c.name), ['testing for bias', 'finding who edited', 'the June 18 burst', 'ruling out bots'])
  const c2 = store.claims[1]
  assert.deepEqual({ kind: c2.kind, by: c2.by, turn: c2.turn, cluster: c2.cluster }, { kind: 'finding', by: 'claude', turn: 1, cluster: 'k2' })
  assert.deepEqual(c2.said.map(p => [p.row, p.by, p.turn, p.quote]), [['r2', 'claude', 1, "Kestrel made 41% of June's edits"]])
  assert.deepEqual(c2.sources.map(s => s.label), ['41%', '212 of them'])
  assert.equal(noteFor(res), '4 new claims')
  // a claim whose words are in no message of the turn is dropped, and said why
  const r = applyTurn(store, { places: PLACES1, out: { claims: [{ claim: 'Made up', quote: 'words nobody wrote down' }] }, turn: 1 })
  assert.deepEqual(r.added, [])
  assert.match(r.dropped[0].why, /are not in this turn's messages/)
})

test('a claim said again adds its place, so ×N counts it; the same place twice is one; a near-copy is the same claim', () => {
  const { store } = turn1()
  const A2 = 'Back to the burst: June 18 was the busiest day, with [6,543 saves](q1#day=2026-06-18@n). Kestrel led it.'
  const places = [{ row: 'u2', by: 'person', turn: 2, text: 'and the busiest month?' }, { row: 'r3', by: 'claude', turn: 2, text: A2 }]
  const res = applyTurn(store, { places, turn: 2, out: { claims: [
    { same: 'c3', quote: 'June 18 was the busiest day' },
    { same: 'c3', quote: 'June 18 was the busiest day, with 6,543 saves' },
    // the fork missed it, but the words are almost the same as c2's: code's own dedupe counts it as said again
    { claim: "Kestrel made 41% of June's edits", quote: 'Kestrel led it', kind: 'finding', cluster: 'k2' },
  ] } })
  assert.deepEqual(res.added, [])
  assert.deepEqual(res.restated, ['c3', 'c2'])
  const c3 = store.claims.find(c => c.id === 'c3')
  assert.deepEqual(c3.said.map(p => [p.row, p.turn]), [['r2', 1], ['r3', 2]])
  assert.equal(viewOf(store).flat.find(c => c.id === 'c3').n, 2)
  assert.equal(noteFor(res), '')
  assert.ok(likeness("Kestrel made 41% of June's edits", 'Kestrel made 41% of the edits in June') >= 0.8)
})

test('a correction stays: the old claim is revised by the new one, and the new one revises it, both ways', () => {
  const { store } = turn1()
  const Q3 = "I'm going to tell my manager the tilt is one editor. Anything to fix?"
  const A3 = 'Fix one thing: it is two editors, not one. Kestrel and Wren made [63%](q8#user=top2@share) of the tilt, and neither alone tips it.'
  const res = applyTurn(store, { places: [{ row: 'u3', by: 'person', turn: 3, text: Q3 }, { row: 'r4', by: 'claude', turn: 3, text: A3 }], turn: 3, out: { claims: [
    { same: 'c1', quote: 'the tilt is one editor', by: 'person' },
    { claim: 'The tilt is two editors, Kestrel and Wren, not one', quote: 'it is two editors, not one', kind: 'finding', revises: 'c1' },
  ] } })
  assert.deepEqual(res.added, ['c5'])
  assert.deepEqual(res.revised, ['c1'])
  assert.deepEqual(res.restated, ['c1'])
  const c1 = store.claims.find(c => c.id === 'c1')
  const c5 = store.claims.find(c => c.id === 'c5')
  assert.equal(c1.revised_by, 'c5')
  assert.equal(c5.revises, 'c1')
  // with no cluster of its own, a correction stays beside what it corrects
  assert.equal(c5.cluster, c1.cluster)
  // the person said it too: their place counts
  assert.deepEqual(c1.said.map(p => p.by), ['claude', 'person'])
  assert.equal(noteFor(res), '1 claim revised')
  assert.equal(noteFor({ added: ['c7', 'c8', 'c9'], revised: ['c2'] }), '1 claim revised · 2 new')
  const v = viewOf(store, { fresh: res.added })
  const g = v.groups.find(x => x.id === c1.cluster)
  assert.equal(g.claims.find(c => c.id === 'c1').replacement.id, 'c5')
  assert.equal(g.claims.find(c => c.id === 'c5').original.id, 'c1')
  assert.equal(g.claims.find(c => c.id === 'c5').fresh, true)
  // the fork reads it as revised, so it is not said again as if it held
  assert.match(promptLines(store).claims, /- c1 · k1 · The tilt in the edits is one editor \(revised by c5, ×2\)/)
  assert.match(showLines(store).join('\n'), /c1 ~~The tilt in the edits is one editor~~ → c5/)
})

test('a claim the person states and Claude corrects in the same turn is revised by its place in the list, #N', () => {
  const { store } = turn1()
  const Q = "I'll tell my manager the edits were biased and that bots drove it."
  const A = 'Bots made only [4%](q5#bot=yes@share) of the edits, so they did not drive it.'
  const res = applyTurn(store, { places: [{ row: 'u4', by: 'person', turn: 4, text: Q }, { row: 'r6', by: 'claude', turn: 4, text: A }], turn: 4, out: { claims: [
    { claim: 'Bots drove the bias', quote: 'bots drove it', by: 'person', kind: 'claim', cluster: 'k4' },
    { claim: 'Bots made only 4% of edits, so they did not drive it', quote: 'Bots made only 4% of the edits', kind: 'finding', cluster: 'k4', revises: '#1' },
    { claim: 'A revision of nothing', quote: 'so they did not drive it', kind: 'finding', revises: '#9' },
  ] } })
  assert.deepEqual(res.added, ['c5', 'c6', 'c7'])
  assert.deepEqual(res.revised, ['c5'])
  const c5 = store.claims.find(c => c.id === 'c5')
  assert.deepEqual([c5.by, c5.revised_by], ['person', 'c6'])
  assert.equal(store.claims.find(c => c.id === 'c7').revises, undefined)
})

// ------------------------------------------------------------------------------------------------ clusters

test('a claim goes in the cluster it names by id or by name; a new name makes a new cluster; none is between clusters', () => {
  const { store } = turn1()
  assert.equal(clusterFor(store, 'k2'), 'k2')
  assert.equal(clusterFor(store, 'Finding Who Edited'), 'k2')
  assert.equal(clusterFor(store, 'new: checking the reverts', 2), 'k5')
  assert.equal(store.clusters.at(-1).name, 'checking the reverts')
  assert.equal(clusterFor(store, ''), null)
  // the view: clusters in the order their work began, the loose claims last
  store.claims.push({ id: 'c9', text: 'A loose claim', kind: 'claim', by: 'claude', cluster: null, turn: 2, said: [{ row: 'r9' }], sources: [] })
  const v = viewOf(store)
  assert.deepEqual(v.groups.map(g => g.name), ['testing for bias', 'finding who edited', 'the June 18 burst', 'ruling out bots', 'between clusters'])
  assert.deepEqual(v.flat.map(c => c.order), [0, 1, 2, 3, 4])
})

test('a cluster that grew a lot since it was named is offered to rename or split; the fork\'s answer is applied', () => {
  const { store } = turn1()
  const many = Array.from({ length: 6 }, (_, i) => ({ claim: `Kestrel reverted page ${i + 1} twice in June`, quote: `page ${i + 1} reverted twice`, kind: 'event', cluster: 'k2' }))
  const text = Array.from({ length: 6 }, (_, i) => `On page ${i + 1} reverted twice.`).join(' ')
  const r = applyTurn(store, { places: [{ row: 'r5', by: 'claude', turn: 2, text }], out: { claims: many }, turn: 2 })
  assert.equal(r.added.length, 6, JSON.stringify(r.dropped))
  const grown = grownClusters(store)
  assert.deepEqual(grown, [{ id: 'k2', name: 'finding who edited', from: 1, to: 7 }])
  const res = applyTurn(store, { places: [], out: { claims: [], clusters: [{ id: 'k2', name: 'Kestrel\'s edits' }, { split: 'k2', name: 'the reverts', claims: ['c5', 'c6', 'c7', 'c8', 'c9', 'c10'] }] }, turn: 2, grown })
  assert.deepEqual(res.clusters.map(x => x.renamed || x.split), ['k2', 'k2'])
  assert.equal(store.clusters.find(c => c.id === 'k2').name, "Kestrel's edits")
  assert.equal(store.claims.filter(c => c.cluster === 'k5').length, 6)
  assert.deepEqual(grownClusters(store), [])
})

test('a turn the observer could not read is said in the store; the store reads back from its file', () => {
  const { store } = turn1()
  noteGap(store, 2, 'the look failed (api-error)')
  const back = readStore(JSON.stringify(store), 's1')
  assert.deepEqual(back.gaps, [{ turn: 2, why: 'the look failed (api-error)' }])
  assert.equal(back.claims.length, 4)
  assert.deepEqual(readStore('not json', 's2').claims, [])
  // an older store with bare refs as sources reads them as {ref, label}
  assert.deepEqual(readStore({ claims: [{ id: 'c1', text: 'x', sources: ['q1#a@n'] }] }).claims[0].sources, [{ ref: 'q1#a@n', label: 'q1 · a · n' }])
})

// ------------------------------------------------------------------------------------------------ the corpus orientation

const DATA = {
  title: '3 trials of "sort the parcels"',
  scope: { unit: 'trials', n: 3 },
  clusters: [{ id: 'belt', name: 'belt slips', lead: 'belt-skips' }, { id: 'scale', name: 'scale theory' }],
  claims: [
    { id: 'belt-skips', name: 'The belt skips a slot', kind: 'finding', cluster: 'belt', n: 2, of: 3, evidence: [{ ref: 'trials/t1.jsonl#L2', quote: 'The belt skips a slot' }] },
    { id: 'pinned', name: 'Pinned the belt', kind: 'judgment call', cluster: 'belt', evidence: ['trials/t3.jsonl#L2'] },
    { id: 'scale-off', name: 'The scale is off', kind: 'claim', cluster: 'scale', evidence: [{ ref: 'trials/t2.jsonl#L2', quote: 'the scale is off' }] },
    { id: 'asked', name: 'Asked to sort the parcels', kind: 'event', evidence: [{ ref: 'trials/t1.jsonl#L1' }] },
  ],
  relations: [{ from: 'belt-skips', to: 'scale-off', type: 'contradicts' }, { from: 'pinned', to: 'belt-skips', type: 'supports' }],
}

test('the orientation\'s claims join the session\'s, marked as the orientation\'s, with their evidence as sources', () => {
  const store = emptyStore('s1')
  applyTurn(store, { places: [{ row: 'r1', by: 'claude', turn: 1, text: 'In trial 1, the belt skips a slot.' }], out: { claims: [{ claim: 'The belt skips a slot', quote: 'the belt skips a slot', kind: 'finding', cluster: 'the belt' }] }, turn: 1 })
  const res = mergeOrientation(store, DATA, { at: 'T', turn: 1 })
  assert.deepEqual(res.added.length, 3)
  assert.deepEqual(res.restated, ['c1'])
  const c1 = store.claims.find(c => c.id === 'c1')
  assert.deepEqual(c1.said.map(p => p.by), ['claude', 'orientation'])
  assert.ok(c1.sources.some(s => s.ref === 'trials/t1.jsonl#L2'))
  const pinned = store.claims.find(c => c.text === 'Pinned the belt')
  assert.deepEqual({ by: pinned.by, kind: pinned.kind, cluster: store.clusters.find(k => k.id === pinned.cluster).name }, { by: 'orientation', kind: 'judgment', cluster: 'belt slips' })
  assert.equal(store.clusters.find(k => k.name === 'belt slips').from, 'orientation')
  assert.deepEqual(store.orientation, { at: 'T', turn: 1, claims: 3, clusters: 2 })
  // the orientation's clusters come after the session's
  assert.deepEqual(viewOf(store).groups.map(g => g.name), ['the belt', 'belt slips', 'scale theory', 'between clusters'])
})

test('lean verb claims save puts the orientation\'s claims in this session\'s store, and says how many', () => {
  const root = runsFolder(3)
  mkdirSync(join(root, 'thimble', 'claims'), { recursive: true })
  const file = join(root, 'thimble', 'claims', 'orientation.json')
  writeFileSync(file, JSON.stringify({ title: DATA.title, data: DATA }))
  const lines = []
  assert.equal(cmdSave(file, { session: 's-77', out: l => lines.push(l), now: 'T' }), 0)
  assert.match(lines[0], /^4 new claims from the corpus · this session's claims: 4 claims in 2 clusters/)
  const store = JSON.parse(readFileSync(storeFile(root, 's-77'), 'utf8'))
  assert.equal(store.claims.length, 4)
  assert.ok(store.claims.every(c => c.by === 'orientation'))
  assert.equal(loadStore(root, 's-77').orientation.claims, 4)
  // no session: one line with the fix
  assert.equal(cmdSave(file, { session: '', out: l => lines.push(l) }), 1)
  assert.match(lines.at(-1), /^No session to save into/)
})

// ------------------------------------------------------------------------------------------------ the verb

test('the verb answers with the claims so far, and the orientation asks main to hand the reading to a subagent', async () => {
  const root = runsFolder(2)
  const none = await run({ root, session: 's1', args: '' })
  assert.match(none.text, /^No claims yet/)
  const out = await run({ root, session: 's1', args: 'orient', verb: { dir: '/plugin/verbs/claims' } })
  assert.match(out.text, /^Asked Claude to orient on the corpus: map 2 trials \(about \d+ min\)/)
  assert.match(out.ask, /one subagent with the Agent tool/)
  assert.ok(out.ask.includes('/plugin/verbs/claims/SKILL.md'))
  assert.ok(out.ask.includes(`lean verb claims check ${root}/thimble/claims/orientation.json`))
  assert.ok(out.ask.includes(`lean verb claims save ${root}/thimble/claims/orientation.json`))
  assert.equal(askFor({ root: '/w', dir: '/d', est: { what: 'map 1 run', detail: 'x', minutes: 2, read: '' } }).split('\n')[0], "Orient on this folder's corpus: map 1 run (x). It takes a subagent about 2 minutes.")
})

// ------------------------------------------------------------------------------------------------ the estimate

test('the estimate groups transcripts into runs and offers them with time and tokens', () => {
  const root = runsFolder(3)
  const e = estimate(root)
  assert.equal(e.kind, 'runs')
  assert.equal(e.n, 3)
  assert.equal(e.unit, 'trials')
  assert.equal(e.what, 'map 3 trials')
  assert.match(e.note, /^map 3 trials · ~\d+ min$/)
  assert.deepEqual(Object.keys(e.offer).sort(), ['minutes', 'tokens', 'what'])
  assert.ok(e.minutes >= 1 && e.tokens > 0)
})

test('runs are the folders under the transcripts\' common folder, or each transcript side by side', () => {
  const t = p => ({ path: p, size: 10 })
  const nested = runsOf([t('runs/a/agents/x.jsonl'), t('runs/a/agents/y.jsonl'), t('runs/b/agents/x.jsonl')])
  assert.equal(nested.common, 'runs')
  assert.deepEqual(nested.runs.map(r => [r.key, r.files.length]), [['a', 2], ['b', 1]])
  const flat = runsOf([t('logs/r1.jsonl'), t('logs/r2.jsonl')])
  assert.deepEqual(flat.runs.map(r => r.key), ['r1.jsonl', 'r2.jsonl'])
  assert.ok(looksLikeTranscript(line('assistant', 'hi')))
  assert.ok(!looksLikeTranscript('{"day": "2026-01-02", "n": 4}'))
})

test('a folder with no transcripts is a dataset, counted in files and rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'claims-'))
  writeFileSync(join(root, 'orders.jsonl'), '{"id": 1}\n{"id": 2}\n{"id": 3}\n')
  writeFileSync(join(root, 'stock.csv'), 'sku,n\na,1\nb,2\n')
  const e = estimate(root)
  assert.equal(e.kind, 'dataset')
  assert.equal(e.what, 'map 2 files')
  assert.equal(e.rows, 5)
  assert.match(e.detail, /^5 rows · /)
})

test('time and tokens are those of the live builds: 4 files of 42 MB ~4 min ~310k, 16 runs of 5.1 GB ~6 min ~460k, 24 runs of 1 GB ~7 min ~530k', () => {
  assert.deepEqual(cost(4, 41.6e6), { minutes: 4, tokens: 310000 })
  assert.deepEqual(cost(16, 5.1e9), { minutes: 6, tokens: 460000 })
  assert.deepEqual(cost(24, 1.0e9), { minutes: 7, tokens: 530000 })
  const a = cost(2, 1e6), b = cost(40, 1e9)
  assert.ok(b.minutes > a.minutes && b.tokens > a.tokens)
  assert.ok(b.tokens < a.tokens * 3)
})

// ------------------------------------------------------------------------------------------------ the orientation file's shape and check

test('the orientation\'s file is checked for what the store needs: evidence, a kind, a cluster and relations that are known', () => {
  assert.deepEqual(check(DATA).problems, [])
  assert.equal(kindOf('Judgement call'), 'judgment')
  assert.equal(relationOf('contradiction'), 'contradicts')
  const bad = {
    clusters: [{ id: 'q2', name: 'reads as a query' }],
    claims: [
      { id: 'a', name: 'No rows', kind: 'finding', evidence: [] },
      { id: 'b', name: 'Odd kind', kind: 'opinion', evidence: ['x.jsonl#L1'] },
      { id: 'c', name: 'Lost', kind: 'fact', cluster: 'nowhere', evidence: ['x.jsonl#L2'] },
    ],
    relations: [{ from: 'a', to: 'zz', type: 'supports' }],
  }
  const p = check(bad).problems.join('\n')
  for (const want of ['claim "a" has no evidence ref', 'kind "opinion"', 'cluster "nowhere"', 'to "zz" is not a claim id', 'cluster id "q2" reads as a query ref']) assert.ok(p.includes(want), want)
  const s = specFor({ ...DATA, added: { claims: ['pinned'] } })
  assert.equal(s.verb, 'claims')
  assert.equal(s.data.added, undefined)
  assert.deepEqual(s.data.claims[1].evidence, [{ ref: 'trials/t3.jsonl#L2' }])
})

test('lean verb claims check holds a good file and names a quote that is not in its row', { skip: !process.env.LEAN_PYTHON && 'LEAN_PYTHON (a Python for the kernel) is not set' }, () => {
  const root = runsFolder(3)
  mkdirSync(join(root, 'thimble', 'claims'), { recursive: true })
  const file = join(root, 'thimble', 'claims', 'orientation.json')
  const lines = []
  writeFileSync(file, JSON.stringify({ title: DATA.title, data: DATA }))
  assert.equal(cmdCheck(file, l => lines.push(l)), 0, lines.join('\n'))
  assert.match(lines.at(-1), /^orientation.json holds: 4 claims in 2 clusters · 4 evidence refs · 4 of 4 citations hold/)
  const bad = structuredClone(DATA)
  bad.claims[2].evidence[0].quote = 'the scale is broken'
  writeFileSync(file, JSON.stringify({ data: bad }))
  lines.length = 0
  assert.equal(cmdCheck(file, l => lines.push(l)), 1)
  assert.ok(lines.some(l => l.includes("the quote 'the scale is broken' is not in trials/t2.jsonl#L2")), lines.join('\n'))
  assert.match(lines.at(-1), /1 problem \(above\)\. 3 of 4 citations hold/)
})

// ------------------------------------------------------------------------------------------------ time

test('the session in time: one moment per message that first said claims, in the order of the index, each named', () => {
  const { store } = turn1()
  applyTurn(store, { places: [{ row: 'u3', by: 'person', turn: 2, text: "I'll say the tilt is one editor" }, { row: 'r9', by: 'claude', turn: 2, text: 'No: it is two editors, not one.' }], turn: 2, out: { claims: [
    { same: 'c1', quote: 'the tilt is one editor', by: 'person' },
    { claim: 'The tilt is two editors', quote: 'it is two editors, not one', kind: 'finding', revises: 'c1' },
    { claim: 'The person will tell the team', quote: "I'll say the tilt", by: 'person', kind: 'claim' },
  ] } })
  mergeOrientation(store, DATA, { turn: 2 })
  const ms = timeline(store, { order: ['u1', 'r1', 'r2', 'u3', 'r9'] })
  assert.deepEqual(ms.map(m => [m.turn, m.row, m.what, m.claims.length]), [[1, 'r2', 'answer', 4], [2, 'u3', 'you', 1], [2, 'r9', 'answer', 1], [2, null, 'corpus', 4]])
  const at1 = claimsAt(ms, 0)
  assert.equal(at1.upto.size, 4)
  assert.deepEqual([...claimsAt(ms, 2).at], ['c5'])
  assert.equal(tagOf('finding'), 'fact')
  assert.equal(tagOf('judgment call'), 'interp')
})
