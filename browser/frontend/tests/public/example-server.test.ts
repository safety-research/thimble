// The tour's example workspace (src/example/server.ts): what the Files pane and the Labels sidebar ask about the
// example folder is answered from the example, as thimble's server answers it; what the person changes is kept for
// the frame and told on its bus, as the server's stream tells it; what needs Claude is refused with a line that says
// so; and nothing else is answered.
import { afterEach, expect, test } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { createServer, EXAMPLE, NEEDS_CLAUDE } from '../../src/example/server.ts'

const offs: (() => void)[] = []
afterEach(() => offs.splice(0).forEach((off) => off()))

const C = `/api/corpora/${EXAMPLE}`
const W = `/api/ws/${EXAMPLE}`
const T1 = 'agents/agent-1.jsonl'

test("the folder's listings, pages, keys, events and records are the server's own", async () => {
  const s = createServer()
  const get = async (url: string) => {
    const r = await s.answer(url)
    expect(r.status, url).toBe(200)
    return r.json()
  }
  const root = await get(`${C}/sources?path=.&depth=1`)
  expect(root.files.map((f: { path: string }) => f.path)).toEqual(['README.md', 'board.jsonl'])
  expect(root.folders.map((f: { path: string }) => f.path)).toEqual(['agents', 'shop'])
  expect((await get(`${C}/sources?path=agents&depth=1`)).files).toHaveLength(3)
  expect((await s.answer(`${C}/sources?path=nope&depth=1`)).status).toBe(404)
  // a page: the sniff on every page, the time key on the first
  const first = await get(`${C}/source?path=${T1}&start=1&count=5`)
  expect(first.records.map((r: { line: number }) => r.line)).toEqual([1, 2, 3, 4, 5])
  expect(first.transcript.format).toBe('stream')
  expect(first.time).toEqual({ key: 'timestamp' })
  const later = await get(`${C}/source?path=${T1}&start=6&count=100`)
  expect(later.records[0].line).toBe(6)
  expect(later.total_lines).toBe(26)
  expect(later.time).toBeUndefined()
  const around = await get(`${C}/source/around?path=${T1}&line=10&before=2&after=2`)
  expect(around.records.map((r: { line: number }) => r.line)).toEqual([8, 9, 10, 11, 12])
  expect((await s.answer(`${C}/source/around?path=${T1}&line=99`)).status).toBe(404)
  // Color by's keys, each per-bin list as long as its bins
  const keys = await get(`${C}/source/keys?path=${T1}`)
  expect(keys.bytes).toHaveLength(keys.bins)
  expect(keys.keys.find((k: { key: string }) => k.key === 'type').at).toHaveLength(keys.bins)
  expect((await get(`${C}/source/events?path=${T1}`)).events).toHaveLength(26)
  expect((await s.answer(`${C}/source/events?path=README.md`)).status).toBe(415)
  const ref = await get(`${C}/ref?ref=${encodeURIComponent(`${T1}#L4`)}`)
  expect(ref).toMatchObject({ kind: 'record', path: T1, line: 4 })
  expect(ref.record.type).toBe('assistant')
  // the searches: by name, in a file, and over every file
  expect((await get(`${C}/sources/find?q=agent-2`)).files.map((f: { path: string }) => f.path)).toEqual(['agents/agent-2.jsonl'])
  const found = await get(`${C}/source/find?path=${T1}&q=${encodeURIComponent('gift box')}`)
  expect(found.lines.length).toBeGreaterThan(0)
  const grep = (await (await s.answer(`${C}/sources/grep?q=${encodeURIComponent('gift box')}`)).text()).trim().split('\n').map((l) => JSON.parse(l))
  expect(grep.at(-1)).toMatchObject({ done: true, complete: true })
  const hit = grep.find((l) => l.path === 'board.jsonl')
  expect(hit.matches[0].text.slice(...hit.matches[0].hit).toLowerCase()).toBe('gift box')
})

test("the label's rows, presence and ruler are read from its rows, and the person's changes are kept and told", async () => {
  const s = createServer()
  const id = s.labelId
  const told: unknown[] = []
  offs.push(bus.on('concepts', (e) => told.push(e)), bus.on('filter', (e) => told.push(e)))
  const json = async (url: string, init?: RequestInit) => (await s.answer(url, init)).json()
  const [label] = await json(`${W}/concepts`)
  expect(label).toMatchObject({ id, name: 'what the step does', shown: false, n_labeled: 61 })
  expect(label.counts).toEqual({ 'reads code': 15, 'changes code': 4, 'runs tests': 9, 'talks to other agents': 20, other: 13 })
  const [onFile] = await json(`${W}/labels?path=${T1}`)
  expect(onFile.rows).toHaveLength(26)
  expect((await json(`${W}/labels?path=${T1}&lines=3-5`))[0].rows.map((r: { ref: string }) => r.ref)).toEqual([3, 4, 5].map((n) => `${T1}#L${n}`))
  expect(await json(`${W}/labels?path=README.md`)).toEqual([])
  const [presence] = await json(`${W}/labels/presence`)
  expect(presence.paths[T1]['talks to other agents']).toBe(8)
  // line l of a file of `total` lines stands in bin ⌊(l − 1) · bins / total⌋ (files/Ruler.tsx binLines)
  const ruler = await json(`${W}/labels/ruler?path=${T1}&bins=2000`)
  expect(ruler.labels[0].bins['changes code']).toEqual([Math.floor((13 - 1) * 2000 / 26), Math.floor((14 - 1) * 2000 / 26)])
  const tests = await json(`${W}/concepts/${id}/rows?value=runs%20tests&limit=2&text=1`)
  expect(tests.total).toBe(9)
  expect(tests.rows).toHaveLength(2)
  expect(tests.rows[0].text).toBeTruthy()

  // turned on, recolored, a record's value marked, a filter set: kept, and told as the server's stream tells it
  await json(`${W}/concepts/${id}`, { method: 'PUT', body: JSON.stringify({ shown: true }) })
  expect((await json(`${W}/concepts`))[0].shown).toBe(true)
  await json(`${W}/concepts/${id}/labels`, { method: 'POST', body: JSON.stringify({ ref: `${T1}#L3`, label: 'reads code' }) })
  expect((await json(`${W}/concepts/${id}`)).counts['reads code']).toBe(16)
  expect(await json(`${W}/filters`, { method: 'PUT', body: JSON.stringify({ scope: 'files', concept: id, value: 'runs tests' }) })).toEqual({ files: { concept: id, value: 'runs tests' } })
  expect(told).toEqual([
    { concept: id, what: 'changed', rows: false },
    { concept: id, what: 'changed', rows: true },
    { scope: 'files', concept: id, value: 'runs tests' },
  ])
  // deleted, it is gone everywhere; the example as it started comes back with reset
  await json(`${W}/concepts/${id}`, { method: 'DELETE' })
  expect(await json(`${W}/concepts`)).toEqual([])
  expect(await json(`${W}/labels/presence`)).toEqual([])
  expect(await json(`${W}/filters`)).toEqual({})
  s.reset()
  expect((await json(`${W}/concepts`))[0]).toMatchObject({ shown: false, counts: { 'reads code': 15 } })
})

test('what needs Claude is refused with a line that says so, and nothing outside the example is answered', async () => {
  const s = createServer()
  for (const [url, method] of [
    [`${W}/concepts/${s.labelId}/apply`, 'POST'],
    [`${W}/concepts`, 'POST'],
    [`${W}/concepts/draft`, 'POST'],
    [`${W}/events`, 'POST'],
  ]) {
    const r = await s.answer(url, { method, body: '{}' })
    expect(r.status, url).toBe(403)
    expect((await r.json()).detail).toBe(NEEDS_CLAUDE)
  }
  expect((await s.answer('/api/corpora/another-folder/sources?path=.&depth=1')).status).toBe(404)
  expect((await s.answer('/api/ws/another-folder/concepts')).status).toBe(404)
  // what the panes' requests are: thimble's API, under a browser's key or not, never the app's own files
  expect(s.answers('/api/ws/x/concepts')).toBe(true)
  expect(s.answers('/b/AAAAAAAAAAAAAAAAAAAA/api/ws/x/concepts')).toBe(true)
  expect(s.answers('/assets/index.js')).toBe(false)
  // its answers name the example's own files alone
  const all = await (await s.answer(`/api/corpora/${EXAMPLE}/sources`)).json()
  expect(all.map((f: { path: string }) => f.path).sort()).toEqual(['README.md', 'agents/agent-1.jsonl', 'agents/agent-2.jsonl', 'agents/agent-3.jsonl', 'board.jsonl', 'shop/checkout.py'])
})
