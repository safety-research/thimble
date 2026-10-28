// A long transcript's first records, in a real browser: Files' reader (src/files/Reader.tsx) in its Transcript mode over
// a file of 50,000 lines whose Color by keys (GET /source/keys, a read of the whole file) take seconds to come. The first
// page's records are drawn soon after they are read, not after a wait for the keys; while no record is drawn the reader
// reads no page past the first, so the first paint draws one page; and once the keys come, the records drawn take
// their colors.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { bundle, cleanup, ORIGIN, src } from './page.ts'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
let dir = ''
let browser: Browser | null = null
/** ms the keys take to come */
const KEYS_MS = 4000

beforeAll(async () => {
  const script = await bundle(
    'transcript-first-paint',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Reader } from '${src('files/Reader.tsx')}'`,
      `const w = window as any`,
      `const TOTAL = 50000`,
      `const who = (i) => (i % 2 ? 'agent' : 'user')`,
      `const said = (i) => 'turn ' + i + ' says what it does next'`,
      `const rec = (i) => ({ line: i, record: { time: '2026-10-08T09:' + String(i % 60).padStart(2, '0') + ':00Z', speaker: who(i), text: said(i) }, blocks: [{ kind: 'text', text: said(i) }], meta: {} })`,
      `const hint = { transcript: { format: 'messages', score: 0.95, keys: { speaker: 'speaker', text: 'text', time: 'time' } } }`,
      `const page = (a, b) => { const out = []; for (let i = Math.max(1, a); i <= Math.min(TOTAL, b); i++) out.push(rec(i)); return { path: 'run.jsonl', kind: 'events', total_lines: TOTAL, start: Math.max(1, a), records: out, ...hint } }`,
      `const KEYS = { path: 'run.jsonl', total: TOTAL, bins: 20, partial: false, bytes: [], keys: [{ key: 'speaker', values: [{ value: 'agent', n: 25000 }, { value: 'user', n: 25000 }], more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 20 }, (_, b) => b % 2) }] }`,
      // each request the page makes, with when it was made (ms since the page's start)
      `w.__asked = []`,
      `const answer = (u) => {`,
      `  const p = u.pathname, s = u.searchParams`,
      `  if (p.endsWith('/source/around')) { const l = +s.get('line'); return page(l - +s.get('before'), l + +s.get('after')) }`,
      `  if (p.endsWith('/source/lines')) return { path: 'run.jsonl', total_lines: TOTAL, estimated: false, indexed: 1 }`,
      `  if (p.endsWith('/source/keys')) return KEYS`,
      `  if (p.endsWith('/source')) { const a = +s.get('start'); return page(a, a + +s.get('count') - 1) }`,
      `  if (p.endsWith('/labels/ruler')) return { path: 'run.jsonl', total: TOTAL, bins: 20, labels: [] }`,
      `  if (p.endsWith('/labels')) return []`,
      `  return null`,
      `}`,
      `w.fetch = async (url) => {`,
      `  const u = new URL(String(url), location.origin)`,
      `  w.__asked.push({ t: performance.now(), path: u.pathname, start: u.searchParams.get('start') })`,
      `  const got = answer(u)`,
      `  await new Promise((r) => setTimeout(r, u.pathname.endsWith('/source/keys') ? ${KEYS_MS} : 20))`,
      `  if (got == null) return new Response(JSON.stringify({ detail: 'not here' }), { status: 404, headers: { 'content-type': 'application/json' } })`,
      `  return new Response(JSON.stringify(got), { status: 200, headers: { 'content-type': 'application/json' } })`,
      `}`,
      // when the first record was drawn, and how many records that first paint drew
      `w.__first = null`,
      `new MutationObserver(() => { if (w.__first) return; const n = document.querySelectorAll('.reader-card[data-line]').length; if (n) w.__first = { t: performance.now(), n } }).observe(document.getElementById('root')!, { childList: true, subtree: true })`,
      `const labels = { all: [], on: [], focus: null, setFocus() {}, byId: new Map(), presence: new Map(), toggle() {}, setClasses() {}, setColour() {}, save: async () => ({}), remove: async () => {} }`,
      `createRoot(document.getElementById('root')!).render(<div style={{ height: 640, display: 'flex' }}><div className="files-main"><Reader workspace="ws" path="run.jsonl" kind="events" labels={labels} lead={null} /></div></div>)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  dir = path.dirname(script)
  browser = await chromium.launch({ headless: true }).catch(() => null)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  return page
}

test(`a long transcript's first records are drawn soon after they are read, while Color by's keys are still being read; no page past the first is read before they are drawn`, async (ctx) => {
  if (!browser) return ctx.skip()
  const page = await open()
  await page.waitForFunction(() => (window as any).__first, null, { timeout: 20000 })
  const got = await page.evaluate(() => {
    const w = window as any
    const pages = w.__asked.filter((a: { path: string }) => a.path.endsWith('/source'))
    const read = pages[0].t
    return {
      first: w.__first as { t: number; n: number },
      // ms from the first page's request to the first record drawn
      after: Math.round(w.__first.t - read),
      // the pages past the first asked for before the first record was drawn
      early: pages.filter((a: { t: number; start: string | null }) => a.t < w.__first.t && Number(a.start) > 1).length,
      keysAsked: w.__asked.some((a: { path: string }) => a.path.endsWith('/source/keys')),
    }
  })
  assert.ok(got.keysAsked, 'the reader asks for the keys')
  assert.ok(got.after < 1000, `the first records are drawn ${got.after} ms after the first page was asked for, with the keys still to come (${KEYS_MS} ms)`)
  assert.equal(got.early, 0, 'no page past the first is read while no record is drawn')
  assert.ok(got.first.n <= 100, `the first paint draws the first page alone: ${got.first.n} records`)
  // once the keys come, the records drawn take their colors (Color by's default, speaker)
  await page.waitForFunction(() => document.querySelectorAll('.reader-card[data-line] .reader-band').length > 5, null, { timeout: KEYS_MS + 5000 })
  await page.close()
}, 60_000)
