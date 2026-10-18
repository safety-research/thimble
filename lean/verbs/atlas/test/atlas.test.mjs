// The Atlas verb: the estimate the observer offers, the shape check (only what drawing needs), the terminal drawing,
// the verb's run (ask with no atlas, show, add a message's claims), the citation check and the page's routes.
// node --test lean/verbs/atlas/test/
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runProgram } from '../../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../../draw/term.js'
import { atlasRoute } from '../../../shell/browser/atlas/route.mjs'
import { cmdCheck, drawAtlas } from '../cli.mjs'
import { cost, estimate, looksLikeTranscript, runsOf } from '../estimate.mjs'
import { PROGRAM, admit, askFor, findAtlas, messageOf, parseAnswer, run } from '../run.mjs'
import { check, kindOf, relationOf, specFor, summary } from '../shape.mjs'

const line = (type, text) => JSON.stringify({ type, sessionId: 's1', message: { role: type, content: [{ type: 'text', text }] } })

function runsFolder(n = 3) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-'))
  mkdirSync(join(root, 'trials'))
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(root, 'trials', `t${i}.jsonl`), [line('user', 'sort the parcels'), line('assistant', i === 2 ? 'First guess: the scale is off.' : 'The belt skips a slot; fixed it by pinning the belt.')].join('\n') + '\n')
  }
  writeFileSync(join(root, 'notes.md'), '# notes\n')
  return root
}

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
  assert.equal(e.atlas, null)
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
  const root = mkdtempSync(join(tmpdir(), 'atlas-'))
  writeFileSync(join(root, 'orders.jsonl'), '{"id": 1}\n{"id": 2}\n{"id": 3}\n')
  writeFileSync(join(root, 'stock.csv'), 'sku,n\na,1\nb,2\n')
  const e = estimate(root)
  assert.equal(e.kind, 'dataset')
  assert.equal(e.what, 'map 2 files')
  assert.equal(e.rows, 5)
  assert.match(e.detail, /^5 rows · /)
})

test('time and tokens grow with the size, slowly', () => {
  const a = cost(2, 1e6), b = cost(40, 1e9)
  assert.ok(b.minutes > a.minutes && b.tokens > a.tokens)
  assert.ok(b.tokens < a.tokens * 3)
})

test('with an atlas saved, the estimate names it and offers to add a message\'s claims', () => {
  const root = runsFolder(2)
  mkdirSync(join(root, 'thimble', 'objects'), { recursive: true })
  writeFileSync(join(root, 'thimble', 'objects', '04-atlas.json'), JSON.stringify({ id: '04-atlas', version: 2, verb: 'atlas', updated: '2026-01-01T00:00:00+00:00', data: DATA }))
  const e = estimate(root)
  assert.deepEqual({ id: e.atlas.id, claims: e.atlas.claims, clusters: e.atlas.clusters }, { id: '04-atlas', claims: 4, clusters: 2 })
  assert.ok(e.add && e.add.tokens > 0)
})

// ------------------------------------------------------------------------------------------------ the shape

test('a whole atlas has no problems, and its summary counts it', () => {
  const r = check(DATA)
  assert.deepEqual(r.problems, [])
  assert.equal(summary(DATA), '4 claims in 2 clusters · 2 relations · 4 evidence refs')
  assert.equal(kindOf('Judgement call'), 'judgment')
  assert.equal(kindOf('opinion'), null)
  assert.equal(relationOf('contradiction'), 'contradicts')
})

test('the check names what drawing cannot use: no evidence, a kind, a cluster or a relation that is not known', () => {
  const bad = {
    clusters: [{ id: 'q2', name: 'reads as a query' }],
    claims: [
      { id: 'a', name: 'No rows', kind: 'finding', evidence: [] },
      { id: 'b', name: 'Odd kind', kind: 'opinion', evidence: ['x.jsonl#L1'] },
      { id: 'c', name: 'Lost', kind: 'fact', cluster: 'nowhere', evidence: ['x.jsonl#L2'] },
      { id: 'a', name: 'Twice', kind: 'fact', evidence: ['x.jsonl#L3'] },
    ],
    relations: [{ from: 'a', to: 'zz', type: 'supports' }, { from: 'b', to: 'c', type: 'likes' }],
  }
  const p = check(bad).problems.join('\n')
  for (const want of ['claim "a" has no evidence ref', 'kind "opinion"', 'cluster "nowhere"', 'the id is used twice', 'to "zz" is not a claim id', 'type "likes"', 'cluster id "q2" reads as a query ref']) assert.ok(p.includes(want), want)
  assert.match(check({ title: 'x' }).problems[0], /data.claims is not a list/)
})

test('the spec for lean save wraps bare data, makes each ref an object and drops one message\'s additions', () => {
  const s = specFor({ ...DATA, added: { claims: ['pinned'] } }, 'return 1')
  assert.equal(s.verb, 'atlas')
  assert.equal(s.program, 'return 1')
  assert.equal(s.title, DATA.title)
  assert.equal(s.data.added, undefined)
  assert.deepEqual(s.data.claims[1].evidence, [{ ref: 'trials/t3.jsonl#L2' }])
  assert.ok(specFor({ data: { ...DATA, added: { claims: [] } } }, null, { keepAdded: true }).data.added)
})

// ------------------------------------------------------------------------------------------------ the drawing

const drawn = (data, o = {}) => {
  const drawing = runProgram({ program: PROGRAM, data }, { w: o.w || 100, mode: o.mode || 'inline', state: o.state })
  assert.equal(drawing.error, undefined, drawing.error && drawing.error.message)
  return { drawing, text: gridText(renderTerm(drawing, { w: o.w || 100 })) }
}

test('under a reply: one row per cluster with its dots, count and lead claim, the legend and ↵ open in browser', () => {
  const { drawing, text } = drawn(DATA)
  assert.match(text, /atlas · 3 trials of "sort the parcels"/)
  assert.match(text, /map ready/)
  assert.match(text, /read 3 trials {2}· {2}4 claims in 2 clusters/)
  assert.match(text, /belt slips +● ● +2 {2}The belt skips a slot/)
  assert.match(text, /scale theory +● +1 {2}The scale is off/)
  assert.match(text, /between clusters +● +1 {2}Asked to sort the parcels/)
  assert.match(text, /● fact {3}● finding {3}● judgment call {3}● event {3}● claim/)
  assert.match(text, /↵ open in browser · esc close/)
  const ids = drawing.regions.map(r => r.id)
  assert.deepEqual(ids, ['cluster-belt', 'cluster-scale', 'cluster-between'])
  assert.deepEqual(drawing.regions[0].meta.ref, ['trials/t1.jsonl#L2', 'trials/t3.jsonl#L2'])
})

test('with the browser off, the bottom line says how to turn it on', () => {
  assert.match(drawn(DATA, { state: { browser: false } }).text, /browser off · the Browser row in \/config turns it on/)
})

test('the detail view lists every claim as a part with its rows and its evidence as examples', () => {
  const { drawing, text } = drawn(DATA, { mode: 'detail' })
  assert.match(text, /belt slips {2}2 claims/)
  assert.match(text, /The belt skips a slot +finding · 1 ref · in 2 of 3 trials/)
  const r = drawing.regions.find(x => x.id === 'claim-belt-skips')
  assert.deepEqual(r.meta.ref, ['trials/t1.jsonl#L2'])
  assert.equal(drawing.examples[r.meta.examples].records[0].text, 'The belt skips a slot')
})

test('a version that added claims shows them under their message, with the map\'s new total', () => {
  const data = { ...DATA, added: { claims: ['pinned', 'asked'] } }
  const { text } = drawn(data)
  assert.match(text, /atlas · 2 new claims from this message/)
  assert.match(text, /in the map · 4 claims/)
  assert.match(text, /\+ ● Pinned the belt +judgment call +belt slips/)
  assert.match(text, /\+ ● Asked to sort the parcels +event +between clusters/)
})

test('it draws at narrow and wide widths, and with many claims in one cluster', () => {
  const many = { ...DATA, claims: [...DATA.claims, ...Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, name: `Claim ${i}`, kind: ['fact', 'event'][i % 2], cluster: 'belt', evidence: ['trials/t1.jsonl#L1'] }))] }
  for (const w of [56, 80, 140]) {
    const { drawing, grid } = drawAtlas({ data: many }, { w })
    assert.equal(drawing.error, undefined)
    assert.ok(grid.w <= w)
    assert.match(gridText(grid), /belt slips +●+ \+\d+ +42 /)
  }
})

// ------------------------------------------------------------------------------------------------ the verb

test('a with no atlas asks main to hand the build to a subagent, with the skill and the save', async () => {
  const root = runsFolder(2)
  const out = await run({ root, args: '', kernel: { objects: () => [] }, verb: { dir: '/plugin/verbs/atlas' } })
  assert.match(out.text, /^Asked Claude to map 2 trials \(about \d+ min\)/)
  assert.match(out.ask, /one subagent with the Agent tool/)
  assert.ok(out.ask.includes('/plugin/verbs/atlas/SKILL.md'))
  assert.ok(out.ask.includes(`lean verb atlas check ${root}/thimble/atlas/atlas.json`))
  assert.ok(out.ask.includes(`lean verb atlas save ${root}/thimble/atlas/atlas.json`))
  assert.equal(askFor({ root: '/w', dir: '/d', est: { what: 'map 1 run', detail: 'x', minutes: 2, read: '' } }).split('\n')[0], 'Build the atlas of this folder: map 1 run (x). It takes a subagent about 2 minutes.')
})

const ATLAS = { id: '04-atlas', version: 2, verb: 'atlas', updated: '2026-01-02', program: PROGRAM, data: DATA, source: { title: DATA.title, verb: 'atlas', program: PROGRAM, data: DATA } }

test('a with an atlas and no new message shows it', async () => {
  assert.equal(findAtlas([{ id: '01-chart', data: {} }, ATLAS]).id, '04-atlas')
  const out = await run({ root: '/nowhere', args: '', kernel: { objects: () => [ATLAS] } })
  assert.deepEqual(out.object, { id: '04-atlas', version: 2 })
  assert.match(out.text, /4 claims in 2 clusters/)
})

test('a under a later message adds its claims with one model call; evidence must be a ref the message cites', async () => {
  const record = { row: 'r9', text: 'Trial 3 pinned the belt after [2 slips](trials/t3.jsonl#L2), and ["the scale is off"](trials/t2.jsonl#L2) was wrong.' }
  const calls = []
  const model = { complete: async req => { calls.push(req); return { isAnswered: true, text: JSON.stringify({ claims: [
    { id: 'slips-before-pin', name: 'Trial 3 saw 2 slips before pinning', kind: 'finding', cluster: 'belt', evidence: [{ ref: 'trials/t3.jsonl#L2' }], relations: [{ to: 'pinned', type: 'supports' }] },
    { id: 'invented', name: 'A claim with no cited ref', kind: 'fact', cluster: 'belt', evidence: [{ ref: 'trials/t9.jsonl#L1' }] },
  ] }), usage: {} } } }
  const out = await run({ root: '/nowhere', args: '', record, kernel: { objects: () => [ATLAS] }, model, verb: {} })
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /belt-skips \[finding, belt\]: The belt skips a slot/)
  assert.match(calls[0].prompt, /- trials\/t3.jsonl#L2 \(2 slips\)/)
  assert.equal(out.object.name, '04-atlas')
  const d = out.object.data
  assert.deepEqual(d.added, { claims: ['slips-before-pin'], row: 'r9' })
  assert.deepEqual(d.from_rows, ['r9'])
  assert.equal(d.claims.length, 5)
  assert.deepEqual(d.relations.at(-1), { from: 'slips-before-pin', to: 'pinned', type: 'supports' })
  assert.equal(out.text, '1 new claim · in the map · 5 claims')
  // the same message again: shown, not added twice
  const again = await run({ root: '/nowhere', args: '', record, kernel: { objects: () => [{ ...ATLAS, data: d }] }, model, verb: {} })
  assert.deepEqual(again.object, { id: '04-atlas', version: 2 })
  assert.equal(calls.length, 1)
})

test('admit keeps a quoted citation\'s words as the quote and drops claims without a cited ref', () => {
  const msg = messageOf({ record: { text: 'It said ["the belt skips"](trials/t1.jsonl#L2) twice; see [docs](https://example.com).' } })
  assert.deepEqual(msg.cites, [{ label: '"the belt skips"', ref: 'trials/t1.jsonl#L2' }])
  const got = admit({ claims: [{ name: 'The belt skips twice', kind: 'event', cluster: 'nope', evidence: ['trials/t1.jsonl#L2'] }, { name: 'Nothing cited', evidence: [] }] }, DATA, msg)
  assert.deepEqual(got.claims, [{ id: 'the-belt-skips-twice', name: 'The belt skips twice', kind: 'event', cluster: null, evidence: [{ ref: 'trials/t1.jsonl#L2', quote: 'the belt skips' }] }])
  assert.equal(got.dropped.length, 1)
  assert.deepEqual(parseAnswer('```json\n{"claims": []}\n```'), { claims: [] })
})

// ------------------------------------------------------------------------------------------------ the citation check

test('lean verb atlas check holds a good atlas and names a quote that is not in its row', { skip: !process.env.LEAN_PYTHON && 'LEAN_PYTHON (a Python for the kernel) is not set' }, () => {
  const root = runsFolder(3)
  mkdirSync(join(root, 'thimble', 'atlas'), { recursive: true })
  const file = join(root, 'thimble', 'atlas', 'atlas.json')
  const lines = []
  writeFileSync(file, JSON.stringify({ title: DATA.title, data: DATA }))
  assert.equal(cmdCheck(file, l => lines.push(l)), 0, lines.join('\n'))
  assert.match(lines.at(-1), /^atlas.json holds: 4 claims in 2 clusters · 2 relations · 4 evidence refs · 4 of 4 citations hold/)
  const bad = structuredClone(DATA)
  bad.claims[2].evidence[0].quote = 'the scale is broken'
  writeFileSync(file, JSON.stringify({ data: bad }))
  lines.length = 0
  assert.equal(cmdCheck(file, l => lines.push(l)), 1)
  assert.ok(lines.some(l => l.includes("the quote 'the scale is broken' is not in trials/t2.jsonl#L2")), lines.join('\n'))
  assert.match(lines.at(-1), /1 problem \(above\)\. 3 of 4 citations hold/)
})

// ------------------------------------------------------------------------------------------------ the page's routes

function call(path, files) {
  const url = new URL(path, 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  let got = null
  const handled = atlasRoute({ method: 'GET' }, url, parts, {
    root: files.root, token: 'tok', objectFile: (root, id) => (files[id] ? join(root, 'thimble', 'objects', `${id}.json`) : null),
    send: (code, type, body, headers) => { got = { code, type, body, headers } },
  })
  return { handled, ...got }
}

test('the page server serves the Atlas page, an object as JSON, and opens an atlas object on its page', () => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-'))
  mkdirSync(join(root, 'thimble', 'objects'), { recursive: true })
  writeFileSync(join(root, 'thimble', 'objects', '04-atlas.json'), JSON.stringify(ATLAS))
  writeFileSync(join(root, 'thimble', 'objects', '01-chart.json'), JSON.stringify({ id: '01-chart', data: {} }))
  const files = { root, '04-atlas': true, '01-chart': true }
  assert.equal(call('/tok/atlas/', files).code, 200)
  assert.match(call('/tok/atlas/', files).body, /<canvas id="g">/)
  assert.equal(call('/tok/atlas/atlas.js', files).type, 'text/javascript; charset=utf-8')
  assert.equal(call('/tok/atlas/route.mjs', files).code, 404)
  assert.equal(call('/tok/atlas?o=04-atlas', files).headers.location, '/tok/atlas/?o=04-atlas')
  assert.equal(JSON.parse(call('/tok/o/atlas.json', files).body).id, '04-atlas')
  assert.equal(call('/tok/o/nope.json', files).code, 404)
  assert.equal(call('/tok/o/04-atlas', files).headers.location, '/tok/atlas/?o=04-atlas')
  assert.equal(call('/tok/o/01-chart', files).handled, false)
})
