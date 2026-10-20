// A record's left edge under two choices of Color by, in a real browser: Files' reader (src/files/Reader.tsx) in its
// Transcript and Table modes over a file whose records name a speaker, with the label "tactic" on, and Color by
// "speaker" then "tactic" (views/common.tsx EdgeBands). Each record's edge is two bands side by side from its left edge,
// the first in its speaker's chip color and the second in "tactic"'s purple where the label marks it, an empty place
// (the record's own background, not gray) where it does not; the bands stand in the left padding, so the record's
// line number and text stand where they stood with one choice. With one choice the edge is the one 3 px band, and Off
// draws none.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { bundle, cleanup, ORIGIN, src } from './page.ts'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
let dir = ''
let browser: Browser | null = null

beforeAll(async () => {
  const script = await bundle(
    'color-bands',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Reader } from '${src('files/Reader.tsx')}'`,
      `const w = window as any`,
      `const q = new URLSearchParams(location.search)`,
      `const MODE = q.get('mode') || 'transcript'`,
      `const TOTAL = 60`,
      `localStorage.setItem('thimble:ws:viewOf:chat.jsonl', JSON.stringify(MODE))`,
      // Color by: ?picks=k:speaker,l:a (the default), or one choice, or off
      `const picks = (q.get('picks') ?? 'k:speaker,l:a').split(',').filter(Boolean)`,
      `localStorage.setItem('thimble:ws:colorBy:chat.jsonl', JSON.stringify({ by: picks[0] ?? 'off', picks, off: {} }))`,
      // speakers take turns; "tactic" marks every third record
      `const who = (i) => (i % 2 ? 'agent' : 'user')`,
      `const said = (i) => 'turn ' + i + ' says what it does next'`,
      `const rec = (i) => ({ line: i, record: { time: '2026-10-08T09:' + String(i % 60).padStart(2, '0') + ':00Z', speaker: who(i), text: said(i) }, blocks: [{ kind: 'text', text: said(i) }], meta: {} })`,
      `const hint = MODE === 'transcript' ? { transcript: { format: 'messages', score: 0.95, keys: { speaker: 'speaker', text: 'text', time: 'time' } } } : {}`,
      `const page = (a, b) => { const out = []; for (let i = Math.max(1, a); i <= Math.min(TOTAL, b); i++) out.push(rec(i)); return { path: 'chat.jsonl', kind: 'events', total_lines: TOTAL, start: Math.max(1, a), records: out, ...hint } }`,
      `const tactic = (i) => i % 3 === 0`,
      `const labelRows = (spans) => { const rows = []; for (const s of spans.split(',')) { const [a, b] = s.split('-').map(Number); for (let i = a; i <= Math.min(b, TOTAL); i++) rows.push({ ref: 'chat.jsonl#L' + i, label: tactic(i) ? 'tactic' : 'other', confidence: null, source: 'regex' }) } return [{ concept_id: 'a', name: 'tactic', labels: ['tactic', 'other'], unit: 'record', rows }] }`,
      `const RULER = { path: 'chat.jsonl', total: TOTAL, bins: 20, labels: [{ concept_id: 'a', bins: { tactic: Array.from({ length: 20 }, (_, b) => b) }, counts: { tactic: Array.from({ length: 20 }, () => 1) } }] }`,
      `const KEYS = { path: 'chat.jsonl', total: TOTAL, bins: 20, partial: false, bytes: [], keys: [{ key: 'speaker', values: [{ value: 'agent', n: 30 }, { value: 'user', n: 30 }], more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 20 }, (_, b) => b % 2) }] }`,
      `const answer = (u) => {`,
      `  const p = u.pathname, s = u.searchParams`,
      `  if (p.endsWith('/source/around')) { const l = +s.get('line'); return page(l - +s.get('before'), l + +s.get('after')) }`,
      `  if (p.endsWith('/source/lines')) return { path: 'chat.jsonl', total_lines: TOTAL, estimated: false, indexed: 1 }`,
      `  if (p.endsWith('/source/keys')) return KEYS`,
      `  if (p.endsWith('/source')) { const a = +s.get('start'); return page(a, a + +s.get('count') - 1) }`,
      `  if (p.endsWith('/labels/ruler')) return RULER`,
      `  if (p.endsWith('/labels')) return labelRows(s.get('lines') || '1-' + TOTAL)`,
      `  return null`,
      `}`,
      `w.fetch = async (url) => {`,
      `  const got = answer(new URL(String(url), location.origin))`,
      `  await new Promise((r) => setTimeout(r, 5))`,
      `  if (got == null) return new Response(JSON.stringify({ detail: 'not here' }), { status: 404, headers: { 'content-type': 'application/json' } })`,
      `  return new Response(JSON.stringify(got), { status: 200, headers: { 'content-type': 'application/json' } })`,
      `}`,
      `const TACTIC = { id: 'a', name: 'tactic', unit: 'record', labels: ['tactic', 'other'], classes: [{ name: 'tactic', color: 15, highlight: true }, { name: 'other', color: 0, highlight: false }], trial: false, shown: true }`,
      `const labels = { all: [TACTIC], on: [TACTIC], focus: null, setFocus() {}, byId: new Map([['a', TACTIC]]), presence: new Map([['a', { 'chat.jsonl': { tactic: 20, other: 40 } }]]), toggle() {}, setClasses() {}, setColour() {}, save: async () => ({}), remove: async () => {} }`,
      `createRoot(document.getElementById('root')!).render(<div style={{ height: 640, display: 'flex' }}><div className="files-main"><Reader workspace="ws" path="chat.jsonl" kind="events" labels={labels} lead={null} /></div></div>)`,
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

async function open(query: string): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/${query}`)
  await page.waitForSelector('.reader-card[data-line]', { timeout: 20000 })
  await page.waitForTimeout(600)
  return page
}

/** The records drawn: each one's line, its bands (each band's color, null for an empty one, and its box from the
 * record's left edge), where its line number's text starts, and the chips' colors by value; the real colors of
 * --label-15 and of transparent. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const real = (c: string) => {
      const probe = document.createElement('i')
      probe.style.color = c
      document.body.appendChild(probe)
      const got = getComputedStyle(probe).color
      probe.remove()
      return got
    }
    const rows = [...document.querySelectorAll<HTMLElement>('.reader-card[data-line]')].map((el) => {
      const box = el.getBoundingClientRect()
      const bands = [...el.querySelectorAll<HTMLElement>('.reader-band')].map((b) => {
        const r = b.getBoundingClientRect()
        return { color: getComputedStyle(b).backgroundColor, left: r.left - box.left, width: r.width, height: r.height }
      })
      const num = el.querySelector('.reader-lineno') ?? el.querySelector('td.reader-table-gutter')
      const range = document.createRange()
      const text = [...(num?.childNodes ?? [])].find((n) => n.nodeType === 3 && n.textContent!.trim())
      if (text) range.selectNodeContents(text)
      return { line: Number(el.dataset.line), bands, rowHeight: box.height, number: text ? range.getBoundingClientRect().left - box.left : null }
    })
    const chips = Object.fromEntries([...document.querySelectorAll<HTMLElement>('.reader-colorbar .colorby-chip')].map((c) => [c.dataset.value!, getComputedStyle(c.querySelector('.colorby-sw')!).backgroundColor]))
    return { rows, chips, purple: real('var(--label-15)'), none: real('transparent'), trigger: document.querySelector('.reader-colorbar .colorby .colorby-trigger')?.textContent ?? null }
  })

const who = (line: number) => (line % 2 ? 'agent' : 'user')
const tactic = (line: number) => line % 3 === 0

for (const mode of ['transcript', 'table'])
  test(`Files' ${mode === 'table' ? 'Table' : 'Transcript'} mode: two choices of Color by are two bands on each record's edge, the second empty where the label does not mark it; the text stays where one choice leaves it; Off draws none`, async (ctx) => {
    if (!browser) return ctx.skip()
    const two = await open(`?mode=${mode}`)
    await two.waitForFunction(() => document.querySelectorAll('.reader-band').length > 20)
    const got = await drawn(two)
    assert.equal(got.trigger, 'Color by: speaker+1')
    assert.ok(got.rows.length > 8, `records drawn: ${got.rows.length}`)
    for (const r of got.rows) {
      assert.equal(r.bands.length, 2, `record ${r.line} has two bands: ${JSON.stringify(r)}`)
      const [a, b] = r.bands
      assert.equal(a.color, got.chips[who(r.line)], `record ${r.line}'s first band is its speaker's color`)
      assert.equal(b.color, tactic(r.line) ? got.purple : got.none, `record ${r.line}'s second band is "tactic"'s purple where it marks it, else empty: ${JSON.stringify(r.bands)}`)
      // side by side from the left edge, a pixel apart, the whole height of the record
      assert.equal(a.left, 0)
      assert.equal(a.width, 3)
      assert.equal(b.left, 4)
      assert.equal(b.width, 3)
      assert.ok(Math.abs(a.height - r.rowHeight) <= 2 && a.height === b.height, `the bands run down the record: ${JSON.stringify(r)}`)
      assert.ok(r.number != null && r.number >= b.left + b.width + 2, `record ${r.line}'s number starts after the bands: ${r.number}`)
    }
    assert.ok(got.rows.some((r) => tactic(r.line)) && got.rows.some((r) => !tactic(r.line)), 'records with and without the label are drawn')
    await two.close()

    // one choice: the one band; the numbers stand where they stood with two
    const one = await open(`?mode=${mode}&picks=k:speaker`)
    await one.waitForFunction(() => document.querySelectorAll('.reader-band').length > 20)
    const single = await drawn(one)
    assert.equal(single.trigger, 'Color by: speaker')
    for (const r of single.rows) {
      assert.equal(r.bands.length, 1)
      assert.equal(r.bands[0].width, 3)
      assert.equal(r.bands[0].color, single.chips[who(r.line)])
      const same = got.rows.find((x) => x.line === r.line)
      if (same) assert.equal(r.number, same.number, `record ${r.line}'s number stands where it did with two bands`)
    }
    await one.close()

    // Off: no band, no edge
    const off = await open(`?mode=${mode}&picks=`)
    const none = await drawn(off)
    assert.equal(none.trigger, 'Color by: Off')
    assert.ok(none.rows.length > 8 && none.rows.every((r) => r.bands.length === 0), 'Off draws no band')
    assert.equal(await off.locator('.has-cb').count(), 0)
    await off.close()
  }, 120_000)
