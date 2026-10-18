// The shell's Node side: the verb registry, the verb runner, what both views say of an object, and the page server
// (browser mode: pages behind a token, the JSON routes, the lines back to the terminal, and its life).
//   node --test lean/shell/test/shell.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chainWords, forDrawing, isRef, objectRefs, recordRefs, regionRefs, rowByName } from '../object.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { prep } from '../node/prep.mjs'
import { findVerb, listVerbs, verbsFor } from '../node/registry.mjs'
import { backLine, fromFacts, scopeOf, startServer } from '../node/serve.mjs'
import { runVerb, specOf } from '../node/verb.mjs'

function verbsDir(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'verbs-'))
  for (const [name, files] of Object.entries(spec)) {
    mkdirSync(join(dir, name))
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, name, f), text)
  }
  return dir
}

const RUN_OK = 'export async function run(ctx) { return { text: `ran on ${ctx.object.id}${ctx.region ? " " + ctx.region : ""}`, note: "n", extra: 1 } }'

test('a verb is a folder: verb.json and run.mjs; every field of verb.json is kept, and a clash of keys is said', () => {
  const dir = verbsDir({
    squeeze: { 'verb.json': '{"key": "s", "name": "squeeze", "line": "shorter", "order": 1, "anything": {"x": 1}}', 'run.mjs': RUN_OK },
    stress: { 'verb.json': '{"key": "s", "line": "how sturdy"}', 'run.mjs': RUN_OK },
    broken: { 'verb.json': '{"key": "b"}' },
    nojson: { 'run.mjs': RUN_OK },
  })
  const { verbs, problems } = listVerbs(dir)
  assert.deepEqual(verbs.map(v => v.name), ['squeeze', 'stress'])
  assert.deepEqual(verbs[0].anything, { x: 1 })
  assert.equal(verbs[1].key, undefined)
  assert.ok(problems.some(p => /stress: key "s" is squeeze's/.test(p)))
  assert.ok(problems.some(p => /broken: no run\.mjs/.test(p)))
  assert.ok(problems.some(p => /nojson: no readable verb\.json/.test(p)))
  assert.equal(findVerb(verbs, 's').name, 'squeeze')
  assert.equal(findVerb(verbs, 'STRESS').name, 'stress')
})

test('the hint row picks the verbs the object names, then those whose hint.mjs has a phrase for it, at most 3', async () => {
  const dir = verbsDir({
    a: { 'verb.json': '{"key": "a", "order": 1}', 'run.mjs': RUN_OK },
    b: { 'verb.json': '{"key": "b", "order": 2}', 'run.mjs': RUN_OK, 'hint.mjs': 'export const applies = o => o.data ? "b for this" : null' },
    c: { 'verb.json': '{"key": "c", "order": 3}', 'run.mjs': RUN_OK, 'hint.mjs': 'export const applies = () => { throw new Error("x") }' },
    d: { 'verb.json': '{"key": "d", "order": 4}', 'run.mjs': RUN_OK, 'hint.mjs': 'export const applies = () => "d always"' },
  })
  const { verbs } = await verbsFor({ data: { x: 1 }, hints: ['d', 'nosuchverb'] }, { dir })
  assert.deepEqual(verbs.filter(v => v.picked).map(v => v.name), ['d', 'b'])
  assert.equal(verbs.find(v => v.name === 'b').phrase, 'b for this')
  assert.equal(verbs.find(v => v.name === 'c').phrase, null)
  const none = await verbsFor({}, { dir: verbsDir({ a: { 'verb.json': '{}', 'run.mjs': RUN_OK } }) })
  assert.deepEqual(none.verbs.filter(v => v.picked), [])
})

test('the plugin\'s verbs are map, squeeze, atlas, explore and trace, on m, s, a, x and t, in that order', async () => {
  const { verbs, problems } = listVerbs()
  assert.deepEqual(problems, [])
  assert.deepEqual(verbs.map(v => [v.key, v.name]), [['m', 'map'], ['s', 'squeeze'], ['a', 'atlas'], ['x', 'explore'], ['t', 'trace']])
  // a chart of numbers whose rows keep their source rows: explore and trace say what they would do for it
  const object = { id: '01-x', title: 'Saves', data: { days: [{ day: '2026-06-18', n: 3, _rows: ['r.jsonl#L1-3'] }] }, lineage: { bindings: [{ at: '/days', ref: 'q1' }] } }
  const picked = (await verbsFor(object)).verbs.filter(v => v.picked)
  assert.deepEqual(picked.map(v => v.name), ['explore', 'trace'])
  assert.match(picked[0].phrase, /explore 1 day/)
})

test('a verb that calls the model stops until the shell has its answer, then runs with it', async () => {
  const dir = verbsDir({
    asks: { 'verb.json': '{}', 'run.mjs': 'export async function run(ctx) { const r = await ctx.model.complete({ model: "haiku", prompt: "hi" }); return { text: `said ${r.text}` } }' },
    swallows: { 'verb.json': '{}', 'run.mjs': 'export async function run(ctx) { try { await ctx.model.fork({ prompt: "why" }) } catch { return { text: "gave up" } } return { text: "never" } }' },
  })
  const input = { object: { id: '01-x', version: 1 }, root: tmpdir() }
  const first = await runVerb('asks', input, { dir })
  assert.equal(first.need.kind, 'complete')
  assert.deepEqual(first.need.request, { model: 'haiku', prompt: 'hi' })
  const second = await runVerb('asks', { ...input, answers: { [first.need.key]: { isAnswered: true, text: 'hello' } } }, { dir })
  assert.equal(second.text, 'said hello')
  // a verb that catches the stop itself still waits for its call
  assert.equal((await runVerb('swallows', input, { dir })).need.kind, 'fork')
})

test('a verb\'s object is saved by the kernel, its own lineage kept as declared', () => {
  const { name, spec } = specOf({ id: 'squeeze-x-1', v: 2, title: 't', program: 'p', data: {}, lineage: { cites: [1] }, declared: { read: 'a' } }, 'squeeze')
  assert.equal(name, 'squeeze-x-1')
  assert.deepEqual(spec, { title: 't', program: 'p', data: {}, declared: { read: 'a', squeeze: { cites: [1] } } })
})

test('a verb runs with the object, the region and its refs; a verb that throws comes back as an error', async () => {
  const dir = verbsDir({
    ok: { 'verb.json': '{"key": "o"}', 'run.mjs': 'export async function run(ctx) { return { text: `${ctx.object.id} ${ctx.region} ${ctx.refs.join(",")} ${typeof ctx.draw.runProgram} ${typeof ctx.kernel.resolve}`, note: "for Claude" } }' },
    bad: { 'verb.json': '{}', 'run.mjs': 'export async function run() { throw new Error("no luck") }' },
    made: { 'verb.json': '{}', 'run.mjs': 'export async function run() { return { object: { id: "07-made", version: 2 }, text: { a: 1 } } }' },
  })
  const input = { object: { id: '01-x', version: 1 }, region: 'day-1', refs: ['q1#day=1@n'], root: tmpdir() }
  const r = await runVerb('o', input, { dir })
  assert.equal(r.text, '01-x day-1 q1#day=1@n function function')
  assert.equal(r.note, 'for Claude')
  assert.equal(r.verb, 'ok')
  assert.match((await runVerb('bad', input, { dir })).error, /bad failed: no luck/)
  assert.match((await runVerb('nope', input, { dir })).error, /no verb "nope"/)
  const made = await runVerb('made', input, { dir })
  assert.deepEqual(made.saved, { id: '07-made', v: 2 })
  assert.equal(made.text, '{"a":1}')
})

const OBJ = {
  id: '01-saves', version: 1, title: 'Saves',
  data: { days: [{ day: '2026-06-17', n: 3, _rows: ['r.jsonl#L1-3'] }, { day: '2026-06-18', n: 2, _rows: ['r.jsonl#L4-5'] }] },
  lineage: { cites: [{ ref: 'q1#day=2026-06-18@n', label: '2' }, { ref: 'not a ref', label: 'x' }] },
}
const DRAWING = {
  regions: [
    { id: 'named', meta: { ref: 'q1#day=2026-06-17@n' } },
    { id: 'viacite', meta: { cite: 'c1' } },
    { id: 'day-2026-06-18', meta: { label: 'Jun 18', examples: 'ex' } },
    { id: 'nothing', meta: {} },
  ],
  cites: { c1: { text: 't', ref: ['obj:01-saves#/days/0/n'] } },
  examples: { ex: { total: 2, records: [{ ref: 'r.jsonl#L4', text: 'four' }, { text: 'no ref' }] } },
}

test('a region rests on the refs the program named, or on the data row its id names, never on a guess between two', () => {
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'named'), { refs: ['q1#day=2026-06-17@n'], how: 'named' })
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'viacite').refs, ['obj:01-saves#/days/0/n'])
  const m = regionRefs(OBJ, DRAWING, 'day-2026-06-18')
  assert.deepEqual(m.refs, ['obj:01-saves#/days/1'])
  assert.match(m.how, /matched by name: day = 2026-06-18/)
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'nothing').refs, [])
  const twins = { id: 'o', data: { a: [{ k: 'xy', _rows: ['f#L1'] }, { k: 'xy', _rows: ['f#L2'] }] } }
  assert.equal(rowByName(twins, 'part-xy'), null)
  assert.deepEqual(recordRefs(DRAWING, 'day-2026-06-18'), [{ ref: 'r.jsonl#L4', text: 'four' }])
  assert.deepEqual(objectRefs(OBJ).map(c => c.ref), ['q1#day=2026-06-18@n'])
  assert.ok(isRef('revisions.jsonl#L28') && isRef('q12') && isRef('obj:01-a#/x') && !isRef('hello') && !isRef('https://x.org/#a'))
})

test('a resolve chain reads as a few words, and a check that fails is said', () => {
  const w = chainWords({ chain: [{ step: 'object', id: 'o', at: '/days/1' }, { step: 'binding' }, { step: 'query', id: 'q1', about: 'saves per day', check: 'the value is 3, the rows are 2' }], rows: ['r.jsonl#L4-5'], count: 2, records: [{ ref: 'r.jsonl#L4', text: 'x' }], notes: [] })
  assert.equal(w.line, 'q1 · saves per day ← 2 source rows in r.jsonl')
  assert.deepEqual(w.notes, ['the value is 3, the rows are 2'])
  assert.equal(chainWords({ error: 'no query q9' }).error, true)
})

test('an object saved with no program draws its title and words', async () => {
  const o = forDrawing({ id: '02-words', version: 3, title: 'Words', text: 'June 18 had [6,543](q1#day=2026-06-18@n).' })
  assert.equal(o.v, 3)
  assert.equal(o.data.text, 'June 18 had 6,543.')
  const { drawing, verbs } = await prep({ object: { id: '02-words', version: 3, title: 'Words', text: 'hi' }, w: 60 })
  assert.equal(drawing.error, undefined)
  assert.ok(Array.isArray(verbs))
})

function call(port, { method = 'GET', path, host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// a folder under analysis with made-up data: two versions of an object, this session's messages, another session's
const SID = 'sess-1'
function browserRoot() {
  const root = mkdtempSync(join(tmpdir(), 'root-'))
  const objs = join(root, 'thimble', 'objects')
  mkdirSync(join(objs, '.versions', '01-saves'), { recursive: true })
  const lineage = { rows: { 'r.jsonl': { count: 5 } }, queries: { q1: { inputs: [{ path: 'r.jsonl' }] }, q2: { inputs: [{ path: 'r.jsonl' }, { path: 'kinds.csv' }], uses: [{ name: 'kind', query: 'q1' }, { name: 'q1' }], kept: [] } }, coverage: { total: { files: 3, not_read_files: 1, not_read_rows: 40 } } }
  writeFileSync(join(objs, '01-saves.json'), JSON.stringify({ ...OBJ, version: 2, session: SID, program: 'return k.text("hi")', lineage, history: [{ v: 1, at: 't1' }, { v: 2, at: 't2', change: 'named the week' }] }))
  writeFileSync(join(objs, '.versions', '01-saves', 'v1.json'), JSON.stringify({ ...OBJ, version: 1, title: 'Saves v1' }))
  writeFileSync(join(objs, '02-other.json'), JSON.stringify({ id: '02-other', version: 1, session: 'someone-else', title: 'Other' }))
  writeFileSync(join(objs, '03-squeezed.json'), JSON.stringify({ id: '03-squeezed', version: 1, session: `person-${SID.slice(0, 8)}`, title: 'Squeezed' }))
  const msgs = join(root, 'thimble', 'messages', SID)
  mkdirSync(msgs, { recursive: true })
  writeFileSync(join(msgs, 'index.jsonl'), [
    { row: 'u1', kind: 'user', at: '2026-01-01T00:00:00Z', text: 'which day?' },
    { row: 'a1', kind: 'assistant', at: '2026-01-01T00:00:05Z' },
    { row: 'a1', kind: 'assistant', at: '2026-01-01T00:00:06Z' },
    { row: '../x', kind: 'user', text: 'a row key that is no key' },
  ].map(r => JSON.stringify(r)).join('\n') + '\nnot json\n')
  writeFileSync(join(msgs, 'a1.json'), JSON.stringify({ v: 1, row: 'a1', session: SID, text: 'June 18: [2](q1#day=2026-06-18@n).', marks: [{ kind: 'cite', start: 9, end: 34, ref: 'q1#day=2026-06-18@n', label: '2' }], verbs: { v: { lit: true, note: '1 view' } }, objects: ['01-saves'] }))
  // a stand-in for the lean command: what `lean coverage <id>` and `lean resolve` print with --json
  const lean = join(root, 'fake-lean')
  writeFileSync(lean, `#!/bin/sh\ncase "$1" in\n coverage) echo '{"object": "01-saves", "feeding": [{"path": "r.jsonl", "rows": 5, "of": 9}], "not_feeding": ["kinds.csv", "notes.md"], "session": null, "total": {"files": 3, "rows": 9, "not_read_files": 1, "not_read_rows": 4}, "groups": []}' ;;\n resolve) echo "{\\"ref\\": \\"$2\\", \\"chain\\": [{\\"step\\": \\"query\\", \\"id\\": \\"q1\\"}], \\"count\\": 2, \\"rows\\": [\\"r.jsonl#L4-5\\"], \\"records\\": [], \\"session\\": \\"$LEAN_SESSION\\"}" ;;\nesac\n`, { mode: 0o755 })
  return { root, lean }
}
const JSON_H = { 'content-type': 'application/json' }

test('pages are folders behind the token: each folder of shell/browser/ is a page, with the drawing modules beside them', async () => {
  const { root, lean } = browserRoot()
  const pages = mkdtempSync(join(tmpdir(), 'pages-'))
  for (const d of ['mirror', 'card', 'atlas']) { mkdirSync(join(pages, d)); writeFileSync(join(pages, d, 'index.html'), `<title>${d}</title>`) }
  writeFileSync(join(pages, 'atlas', 'graph.js'), 'export const x = 1')
  writeFileSync(join(pages, '.hidden'), 'no')
  const { server, port, token } = await startServer({ root, session: SID, lean, pages })
  try {
    assert.equal(server.address().address, '127.0.0.1')
    const top = await call(port, { path: `/${token}/` })
    assert.equal(top.status, 302)
    assert.equal(top.headers.location, `/${token}/mirror/`)
    assert.equal((await call(port, { path: `/${token}/mirror` })).headers.location, `/${token}/mirror/`)
    const page = await call(port, { path: `/${token}/mirror/` })
    assert.equal(page.status, 200)
    assert.match(page.text, /<title>mirror<\/title>/)
    assert.match(page.headers['content-security-policy'], /connect-src 'self'/)
    // a page another part adds is served as it is: no change to the server
    assert.match((await call(port, { path: `/${token}/atlas/` })).text, /atlas/)
    const js = await call(port, { path: `/${token}/atlas/graph.js` })
    assert.equal(js.status, 200)
    assert.match(js.headers['content-type'], /javascript/)
    // the renderer and object.js, which every page imports
    assert.equal((await call(port, { path: `/${token}/draw/svg.js` })).status, 200)
    assert.equal((await call(port, { path: `/${token}/draw/browser/sandbox.js` })).status, 200)
    assert.match((await call(port, { path: `/${token}/lib/object.js` })).text, /export function isRef/)
    // nothing else of the plugin, no dot-file, no way out of a folder, and nothing without the token or the host
    assert.equal((await call(port, { path: `/${token}/lib/shell.tsx` })).status, 404)
    assert.equal((await call(port, { path: `/${token}/.hidden` })).status, 404)
    assert.equal((await call(port, { path: `/${token}/mirror/%2e%2e/%2e%2e/package.json` })).status, 404)
    assert.equal((await call(port, { path: `/${token}/draw/..%2F..%2F.claude-plugin%2Fplugin.json` })).status, 404)
    assert.equal((await call(port, { path: `/wrong/mirror/` })).status, 404)
    assert.equal((await call(port, { path: `/${token}/mirror/`, host: 'evil.example:80' })).status, 421)
    // the old handoff link opens the card's page
    const old = await call(port, { path: `/${token}/o/01-saves?v=1` })
    assert.equal(old.status, 302)
    assert.equal(old.headers.location, `/${token}/card/?o=01-saves&v=1`)
    assert.equal((await call(port, { path: `/${token}/o/..%2Fsecret` })).status, 404)
  } finally {
    server.close()
  }
})

test('the JSON routes: this session\'s messages with their records, a record, an object and its versions, the verbs', async () => {
  const { root, lean } = browserRoot()
  const { server, port, token } = await startServer({ root, session: SID, lean })
  try {
    const m = await call(port, { path: `/${token}/api/messages` })
    const body = JSON.parse(m.text)
    // one row per key, in the order first drawn; Claude's rows carry their records; a bad key or line is dropped
    assert.deepEqual(body.rows.map(r => [r.row, r.kind]), [['u1', 'user'], ['a1', 'assistant']])
    assert.equal(body.rows[0].text, 'which day?')
    assert.equal(body.rows[1].record.marks[0].ref, 'q1#day=2026-06-18@n')
    // unchanged: 304 to a page that polls with the ETag
    assert.equal((await call(port, { path: `/${token}/api/messages`, headers: { 'if-none-match': m.headers.etag } })).status, 304)
    writeFileSync(join(root, 'thimble', 'messages', SID, 'a1.json'), JSON.stringify({ v: 1, row: 'a1', text: 'changed' }))
    assert.equal((await call(port, { path: `/${token}/api/messages`, headers: { 'if-none-match': m.headers.etag } })).status, 200)
    assert.equal(JSON.parse((await call(port, { path: `/${token}/api/message/a1` })).text).text, 'changed')
    assert.equal((await call(port, { path: `/${token}/api/message/..%2Fa1` })).status, 404)
    // an object, a version of it, and the list of its versions
    const o = JSON.parse((await call(port, { path: `/${token}/api/object/01-saves` })).text)
    assert.equal(o.object.version, 2)
    assert.deepEqual(o.versions.map(x => x.v), [1, 2])
    assert.equal(o.versions[1].change, 'named the week')
    assert.equal(JSON.parse((await call(port, { path: `/${token}/api/object/01-saves?v=1` })).text).object.title, 'Saves v1')
    assert.equal((await call(port, { path: `/${token}/api/object/nope` })).status, 404)
    // the objects this session saved (Claude's, and a verb's the person ran), not another's
    assert.deepEqual(JSON.parse((await call(port, { path: `/${token}/api/objects` })).text).objects.map(x => x.id), ['01-saves', '03-squeezed'])
    // the row's verbs: the CONTRACT's three while no verb carries row: true
    const v = JSON.parse((await call(port, { path: `/${token}/api/verbs` })).text).verbs
    assert.ok(v.length >= 1 && v.every(x => /^[a-z0-9]$/.test(x.key)))
    // a resolve runs as the person's read, never counted as what Claude read
    const r = JSON.parse((await call(port, { path: `/${token}/api/resolve?ref=${encodeURIComponent('q1#day=2026-06-18@n')}` })).text)
    assert.equal(r.count, 2)
    assert.match(r.session, /^person-/)
    // where the object's values come from: sources, rows, labels, coverage
    const f = JSON.parse((await call(port, { path: `/${token}/api/from/01-saves` })).text)
    assert.deepEqual(f.sources.map(s => s.path), ['r.jsonl', 'kinds.csv'])
    assert.equal(f.rows, 5)
    assert.deepEqual(f.labels, ['kind'])
    assert.deepEqual(f.coverage, { feeding: 1, files: 3, notFeeding: ['kinds.csv', 'notes.md'] })
    assert.deepEqual(f.session, { files: 3, notReadFiles: 1, notReadRows: 40 })
  } finally {
    server.close()
  }
})

test('what the person does on a page comes back as one line: an ask with its scope checked, a verb press, a selection', async () => {
  const { root, lean } = browserRoot()
  const lines = []
  const { server, port, token } = await startServer({ root, session: SID, lean, onLine: l => lines.push(l) })
  const post = (body, headers = JSON_H) => call(port, { method: 'POST', path: `/${token}/api/back`, headers, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ ask: '  why so high?  ', scope: { row: 'a1', object: '01-saves', v: 2, region: 'day-2026-06-18', label: 'Jun 18', mark: { kind: 'cite', ref: 'q1#day=2026-06-18@n', label: '2', evil: 'x' }, extra: 1 } })).status, 200)
    assert.equal((await post({ ask: 'and this?', scope: { object: '<script>', region: '../x', mark: { kind: 'other' } } })).status, 200)
    assert.equal((await post({ verb: 's', row: 'a1', proposal: 'trail of the run' })).status, 200)
    assert.equal((await post({ object: '01-saves', v: 1, region: 'day-2026-06-18' })).status, 200)
    // refused, and nothing printed: an empty question, a verb that is no key, a row that is no key
    assert.equal((await post({ ask: '   ' })).status, 400)
    assert.equal((await post({ verb: 'visualize', row: 'a1' })).status, 400)
    assert.equal((await post({ verb: 'v', row: '../a1' })).status, 400)
    assert.equal((await post({ ask: 'x' }, { ...JSON_H, origin: 'http://evil.example' })).status, 403)
    assert.equal((await post({ ask: 'x' }, {})).status, 415)
    assert.deepEqual(lines, [
      { ask: 'why so high?', scope: { row: 'a1', object: '01-saves', v: 2, region: 'day-2026-06-18', label: 'Jun 18', mark: { kind: 'cite', ref: 'q1#day=2026-06-18@n', label: '2' } } },
      { ask: 'and this?', scope: {} },
      { verb: 's', row: 'a1', proposal: 'trail of the run' },
      { back: { object: '01-saves', v: 1, region: 'day-2026-06-18' } },
    ])
    // the asks are kept for the session's pages (a card's thread)
    const asks = JSON.parse((await call(port, { path: `/${token}/api/asks` })).text).asks
    assert.deepEqual(asks.map(a => a.text), ['why so high?', 'and this?'])
  } finally {
    server.close()
  }
})

function events(port, path) {
  return new Promise((resolve, reject) => {
    const got = []
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, res => {
      res.setEncoding('utf8')
      res.on('data', c => got.push(c))
      resolve({ got, close: () => req.destroy() })
    })
    req.on('error', reject)
    req.end()
  })
}

test('the server lives only while a page is open: it stops when no page comes, and a while after the last one closes', async () => {
  const { root, lean } = browserRoot()
  // no page comes
  let why = null
  const a = await startServer({ root, session: SID, lean, first: 0.15, idle: 0.15, onStop: w => { why = w } })
  await new Promise(r => setTimeout(r, 400))
  assert.equal(why, 'no page came')
  assert.equal(a.server.listening, false)
  // a page opens (its event stream), hears a change, and closes: the server stops after `idle`
  why = null
  const b = await startServer({ root, session: SID, lean, first: 0.2, idle: 0.3, poll: 50, onStop: w => { why = w } })
  const page = await events(b.port, `/${b.token}/api/events`)
  await new Promise(r => setTimeout(r, 300))
  assert.equal(why, null)
  writeFileSync(join(root, 'thimble', 'messages', SID, 'a2.json'), '{"v": 1, "row": "a2", "text": "new"}')
  await new Promise(r => setTimeout(r, 200))
  assert.match(page.got.join(''), /event: hello/)
  assert.match(page.got.join(''), /event: change/)
  page.close()
  await new Promise(r => setTimeout(r, 150))
  assert.equal(why, null)
  await new Promise(r => setTimeout(r, 400))
  assert.equal(why, 'no page open')
  assert.equal(b.server.listening, false)
})

test('a scope keeps only what it should; the from line counts labels once and coverage when the kernel gave it', () => {
  assert.deepEqual(scopeOf({ row: 'r1', v: 3, region: 'x' }), { row: 'r1' })
  assert.deepEqual(scopeOf({ object: 'o1', v: 'two', mark: { kind: 'gloss', gloss: 'g1', term: 'fixture scope', ref: 'not a ref' } }), { object: 'o1', mark: { kind: 'gloss', gloss: 'g1', term: 'fixture scope' } })
  assert.equal(backLine([]).error, 'not an object')
  const f = fromFacts({ lineage: { queries: { q1: { kept: ['kind'], inputs: [{ path: 'a.csv' }] }, q2: { uses: [{ name: 'kind' }] } } } }, { error: 'no lean' })
  assert.deepEqual(f, { sources: [{ path: 'a.csv', rows: null }], rows: 0, labels: ['kind'] })
})

test('a bar keeps the examples and cite its own meta names, so selecting it shows them', () => {
  const d = runProgram({ program: "k.examples('ex-1', { records: [{ text: 'a' }], total: 1 }); return k.bars([{ id: 'b1', label: 'one', value: 1, meta: { ref: 'q1#k=1@n', examples: 'ex-1' } }])", data: {} }, { w: 40 })
  const r = d.regions.find(x => x.id === 'b1')
  assert.equal(r.meta.examples, 'ex-1')
  assert.equal(r.meta.ref, 'q1#k=1@n')
})
