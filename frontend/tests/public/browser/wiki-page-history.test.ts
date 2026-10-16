// The collusion-wiki demo's Wiki Page History view (demos/collusion-wiki) in a real browser, with the view kit, in a
// sandboxed frame whose fetches this page answers at once from made-up data as large as the dataset's (4,458 pages,
// about 15,000 revisions, long diffs), as its reader.py answers them, so what is timed is the page's own work. It opens
// and switches pages within a bound far above what it takes, which fails when either becomes many times slower; and it
// keeps what makes it fast and what makes it thimble's: its pages are the kit's table, which draws only the rows near
// its view and keeps them as it scrolls; a page's history reads and draws its revisions a chunk at a time and the rest as
// they come near, each revision the kit's diff with Color by's bar; Color by only colors: a value turned off keeps its
// pages and revisions, without its bar; and Filter by, over the same fields, is what hides them. The search, the table,
// the diff and the strip are tested whole in view-data.test.ts and kit-strip-follow.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const ROOT = path.join(FRONTEND, '..')
const APP = path.join(ROOT, 'backend', 'app')
const VIEW_HTML = readFileSync(path.join(ROOT, 'demos', 'collusion-wiki', 'workspace', 'extension', 'views', 'wiki-page-history', 'view.html'), 'utf8')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it, but for the parts this view does not call (text, tree, chart)
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_messages.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_record.js', 'viewer_range.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
// the theme's own tokens
const TOKENS = readFileSync(path.join(FRONTEND, 'src', 'styles', 'tokens.css'), 'utf8') + ':root{--font-body:sans-serif;--font-mono:monospace}'
const DOC = VIEW_HTML.replace('<head>', `<head><style>${TOKENS}</style>${KIT}`)

// A bound many times what a step takes in headless Chromium (opening about 0.3 s, a page switch about 0.2 s here), so
// a slower machine passes and a page that draws every row, or every revision of a page with thousands, fails.
const OPEN_MS = 2000
const SWITCH_MS = 500
const PAGES = 4458

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

// The made-up dataset and the reader's answers to the view's queries (overview, page, bodies, user), as reader.py gives
// them, in the page that holds the frame: page r has fewer revisions the further down the list it is, the first 2,327
// by 342 usernames, and every third page one delete after its last revision; each revision's text is 38 lines of which
// 36 change.
function answers() {
  const W = window as any
  const T0 = Date.UTC(2026, 4, 24) / 1000
  const SPAN = 51 * 86400
  const NP = 4458
  const NU = 1200
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const n = (r: number) => Math.max(1, Math.floor(2327 / Math.pow(r + 1, 1.15)))
  const wikis = ['dse', 'probier', 'fractal', 'dorfwiki']
  const users = Array.from({ length: NU }, (_, i) => `User${i}`)
  const pages: { p: number; key: string; wiki: string; name: string; before: number }[] = []
  const items: { t: number; k: number; u: number; seq: number }[][] = []
  const recs: { p: number; t: number; k: number; u: number }[] = []
  for (let r = 0; r < NP; r++) {
    const name = `Page${r}Name${Math.floor(rnd() * 1e6)}`
    pages.push({ p: r, key: `${wikis[r % 4]}~${name}`, wiki: wikis[r % 4], name, before: 0 })
    const start = Math.floor(rnd() * SPAN * 0.8)
    const ts = Array.from({ length: n(r) }, () => T0 + start + Math.floor(rnd() * SPAN * 0.2)).sort((a, b) => a - b)
    // as many usernames as the dataset's pages have for their revisions: 342 for the 2,327 of the first
    const pool = Math.max(1, Math.min(342, Math.round(ts.length * 0.147)))
    const u0 = Math.floor(rnd() * NU)
    const its = ts.map((t, i) => ({ t, k: 0, u: (u0 + Math.floor(rnd() * pool)) % NU, seq: i + 1 }))
    if (r % 3 === 0) its.push({ t: ts[ts.length - 1] + 60, k: 1, u: 0, seq: 0 })
    items.push(its)
    for (const it of its) recs.push({ p: r, t: it.t, k: it.k, u: it.u })
  }
  const fields = (p: number, k: number, u: number): Record<string, string | null> => ({ kind: k ? 'delete' : 'save', wiki: pages[p].wiki, user: users[u], after: null })
  // thimble.color_value and thimble.color_on, for the view's own fields
  const value = (choice: any, f: Record<string, string | null>) => (choice && choice.field && f[choice.field] != null && f[choice.field] !== '' ? String(f[choice.field]) : null)
  const on = (filt: any, v: string | null) => !filt || !(filt.off || []).includes(v)
  function overview(q: any) {
    const values: string[] = []
    const vat = new Map<string, number>()
    const ev = { t: [] as number[], p: [] as number[], k: [] as number[], u: [] as number[], v: [] as number[] }
    const counts: Record<string, number> = {}
    const fcounts: Record<string, number> = {}
    const shown = new Set<number>()
    let lo = Infinity
    let hi = -Infinity
    for (const rec of recs) {
      lo = Math.min(lo, rec.t)
      hi = Math.max(hi, rec.t)
      const f = fields(rec.p, rec.k, rec.u)
      const fv = value(q.filter, f)
      fcounts[fv || ''] = (fcounts[fv || ''] || 0) + 1
      if (!on(q.filter, fv)) continue
      const v = value(q.color, f)
      counts[v || ''] = (counts[v || ''] || 0) + 1
      let vi = -1
      if (v != null) {
        if (!vat.has(v)) vat.set(v, values.push(v) - 1)
        vi = vat.get(v)!
      }
      ev.t.push(rec.t)
      ev.p.push(rec.p)
      ev.k.push(rec.k)
      ev.u.push(rec.u)
      ev.v.push(vi)
      shown.add(rec.p)
    }
    return { pages: [...shown].sort((a, b) => a - b).map((p) => pages[p]), users, values, ev, counts, fcounts, span: [lo, hi] }
  }
  function page(q: any) {
    const p = pages.find((x) => x.key === q.key)
    if (!p) return null
    const out = []
    for (const [pos, it] of items[p.p].entries()) {
      const f = fields(p.p, it.k, it.u)
      if (!on(q.filter, value(q.filter, f))) continue
      out.push({ pos, ref: `revisions.jsonl#L${p.p * 3000 + pos + 1}`, t: it.t, kind: f.kind, wiki: f.wiki, user: f.user, ip: '10.0', seq: it.seq, summary: `edit ${pos}`, after: null, value: value(q.color, f) })
    }
    return { key: p.key, wiki: p.wiki, name: p.name, before: 0, ref: `pages.jsonl#L${p.p + 1}`, total: items[p.p].length, items: out }
  }
  const text = (pos: number) => ['unchanged before', ...Array.from({ length: 36 }, (_, j) => `* [https://example.org/data/county.json?q=${pos}-${j}&format=json] ` + 'x'.repeat(60)), 'unchanged after'].join('\n')
  function bodies(q: any) {
    const p = pages.find((x) => x.key === q.key)
    if (!p) return null
    const out: Record<string, { body: string; before: string }> = {}
    for (const pos of q.at || []) if (items[p.p][pos] && !items[p.p][pos].k) out[String(pos)] = { body: text(pos), before: pos ? text(pos - 1) : '' }
    return { key: p.key, bodies: out }
  }
  W.__fetches = []
  W.__read = 0 // the revisions whose texts were read
  addEventListener('message', (e) => {
    const d = (e.data || {}) as any
    if (d.type !== 'thimble:fetch') return
    const q = d.query || {}
    W.__fetches.push(q.op)
    if (q.op === 'bodies') W.__read += (q.at || []).length
    const data = q.op === 'overview' ? overview(q) : q.op === 'page' ? page(q) : q.op === 'bodies' ? bodies(q) : q.op === 'user' ? { name: q.name, ref: null, role: '' } : null
    ;(e.source as Window).postMessage({ type: 'thimble:result', id: d.id, data }, '*')
  })
}

async function open(): Promise<{ page: Page; frame: Frame; ms: number; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:1200px;height:820px"></iframe></body></html>')
  await page.evaluate(answers)
  const t0 = await page.evaluate((doc) => {
    const t = Date.now()
    ;(document.getElementById('f') as HTMLIFrameElement).srcdoc = doc
    return t
  }, DOC)
  // the frame's first document is about:blank, which the view's replaces
  for (let tries = 0; ; tries++) {
    const frame = page.frames().find((f) => f !== page.mainFrame())
    const t1 = await frame
      ?.evaluate(() => new Promise<number>((resolve) => {
        if (!document.getElementById('list')) return resolve(0)
        const ok = () => document.querySelectorAll('#list .thimble-table-row').length > 0 && /pages?$/.test(document.querySelector('#lhead .n')?.textContent || '')
        const tick = () => (ok() ? requestAnimationFrame(() => requestAnimationFrame(() => resolve(Date.now()))) : setTimeout(tick, 0))
        tick()
      }))
      .catch(() => 0)
    if (frame && t1) return { page, frame, ms: t1 - t0, errors }
    assert.ok(tries < 2000, 'the view never drew its pages')
    await page.waitForTimeout(5)
  }
}

// a row's click to its page's head in the side panel and its first record drawn, in the frame
const switchTo = (frame: Frame, k: number) => frame.evaluate((k) => new Promise<{ ms: number; name: string }>((resolve) => {
  const row = document.querySelectorAll<HTMLElement>('#list .thimble-table-row')[k]
  const name = row.querySelector('.thimble-table-line')!.textContent!
  const t0 = performance.now()
  row.click()
  const tick = () => {
    const h = document.querySelector('.thimble-side-title')
    if (h && h.textContent === name && document.querySelector('.thimble-side-body .recs .rev, .thimble-side-body .recs .del')) return requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ms: performance.now() - t0, name })))
    setTimeout(tick, 0)
  }
  tick()
}), k)

const count = (frame: Frame) => frame.evaluate(() => document.querySelector('#lhead .n')!.textContent)
const drawn = (frame: Frame) => frame.evaluate(() => document.querySelectorAll('.thimble-side-body .recs .rev, .thimble-side-body .recs .del').length)

describe('the Wiki Page History demo view', () => {
  test('opens and switches pages within its bounds, with no error', async () => {
    const { page, frame, ms, errors } = await open()
    assert.ok(ms < OPEN_MS, `the view opened in ${ms} ms (bound ${OPEN_MS})`)
    await page.waitForTimeout(300)
    const times: number[] = []
    for (const k of [2, 4, 6, 8, 3]) {
      const r = await switchTo(frame, k)
      times.push(Math.round(r.ms))
      await page.waitForTimeout(100)
    }
    times.sort((a, b) => a - b)
    assert.ok(times[2] < SWITCH_MS, `a page switch took ${times[2]} ms at the median (${times}; bound ${SWITCH_MS})`)
    assert.deepEqual(errors, [])
    await page.close()
  })

  test("its pages are the kit's table, which draws only the rows near its view and keeps them as it scrolls", async () => {
    const { page, frame } = await open()
    assert.equal(await count(frame), '4,458 pages')
    const rows = await frame.evaluate(() => document.querySelectorAll('#list .thimble-table-row').length)
    assert.ok(rows > 0 && rows <= 60, `${rows} rows drawn of ${PAGES}`)
    // one row's height down: the rows drawn stay the same elements
    const kept = await frame.evaluate(() => new Promise<boolean>((resolve) => {
      const first = document.querySelector('#list .thimble-table-row') as any
      first.__mark = true
      document.getElementById('list')!.scrollTop += 30
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(!!(document.querySelector('#list .thimble-table-row') as any)?.__mark)))
    }))
    assert.ok(kept, 'a scroll of one row draws the rows again')
    // far down the list, still only the rows near the view
    const far = await frame.evaluate(() => new Promise<number>((resolve) => {
      document.getElementById('list')!.scrollTop = 100000
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelectorAll('#list .thimble-table-row').length)))
    }))
    assert.ok(far > 0 && far <= 60, `${far} rows drawn far down the list`)
    await page.close()
  })

  test("a page's history reads and draws its revisions a chunk at a time, each the kit's diff with Color by's bar, and the rest as they come near", async () => {
    const { page, frame, errors } = await open()
    // the page with the most revisions, 2,327, at the top of the list sorted by revisions
    await switchTo(frame, 0)
    await page.waitForTimeout(300)
    const first = await frame.evaluate(() => {
      const rev = document.querySelector<HTMLElement>('.thimble-side-body .recs .rev')!
      return {
        diff: !!rev.querySelector('.thimble-diff-tx'),
        colour: rev.getAttribute('data-color'),
        bar: rev.hasAttribute('data-thimble-bar'),
        facts: document.querySelector('.thimble-side-body .facts')!.textContent,
      }
    })
    const drawn0 = await drawn(frame)
    const read0 = await page.evaluate(() => (window as any).__read)
    assert.match(String(first.facts), /^2,327 revisions/)
    assert.ok(drawn0 > 0 && drawn0 <= 150, `${drawn0} of 2,327 revisions drawn as the page opens`)
    assert.ok(read0 > 0 && read0 <= 100, `${read0} of 2,327 texts read as the page opens`)
    assert.ok(first.diff && first.colour === 'save' && first.bar, `a revision is the kit's diff with Color by's bar: ${JSON.stringify(first)}`)
    // scrolled to its end, again and again: more revisions drawn, their texts read as they come near
    await frame.evaluate(() => new Promise<void>((resolve) => {
      const box = document.querySelector<HTMLElement>('.thimble-side-body')!
      let n = 0
      const go = () => {
        box.scrollTop = box.scrollHeight
        setTimeout(() => (++n < 10 ? go() : resolve()), 80)
      }
      go()
    }))
    const more = await drawn(frame)
    assert.ok(more > drawn0 && more < 2327, `${more} revisions drawn after scrolling, of 2,327`)
    assert.ok((await page.evaluate(() => (window as any).__read)) > read0, 'the revisions near the end were read')
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('Color by only colors: a kind turned off keeps its pages and revisions, drawn without its bar', async () => {
    const { page, frame, errors } = await open()
    await switchTo(frame, 0)
    await page.waitForTimeout(300)
    const look = () => frame.evaluate(() => {
      const chip = [...document.querySelectorAll('.thimble-colour-chip')].find((c) => c.querySelector('.chip-text')!.textContent === 'save')!
      const rev = document.querySelector('.thimble-side-body .recs .rev')!
      return {
        count: document.querySelector('#lhead .n')!.textContent,
        revs: document.querySelectorAll('.thimble-side-body .recs .rev').length,
        revColour: rev.getAttribute('data-color'),
        revBar: rev.hasAttribute('data-thimble-bar'),
        revShown: getComputedStyle(rev).display !== 'none' && getComputedStyle(rev).opacity === '1',
        pressed: chip.getAttribute('aria-pressed'),
      }
    })
    const before = await look()
    assert.ok(before.count === '4,458 pages' && before.revs > 0 && before.revColour === 'save' && before.revBar && before.pressed === 'true', JSON.stringify(before))
    await frame.locator('.thimble-colour-chip', { hasText: 'save' }).click()
    // the page's history is drawn again from its answer, at the revision it showed
    await frame.waitForFunction(() => document.querySelector('.thimble-colour-chip[aria-pressed="false"]') && document.querySelector('.thimble-side-body .recs .rev'))
    await page.waitForTimeout(200)
    const after = await look()
    // every page and revision stays: the count, the open page's revisions, now with no bar
    assert.equal(after.pressed, 'false')
    assert.equal(after.count, before.count)
    assert.ok(after.revs > 0 && after.revColour === 'save' && !after.revBar && after.revShown, JSON.stringify(after))
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('Filter by, beside Color by over the same fields, hides the pages of a wiki turned off and shows them again', async () => {
    const { page, frame, errors } = await open()
    // in the top row after the search and before Color by
    assert.deepEqual(await frame.evaluate(() => [...document.querySelector('.top')!.children].map((e) => e.id)), ['search', 'filter', 'color'])
    // it opens on Wiki, and its menu lists the fields Color by offers
    await frame.locator('.thimble-filter-by').click()
    assert.deepEqual(await frame.evaluate(() => [...document.querySelectorAll('.thimble-colour-menu [data-by^="f:"]')].map((e) => e.getAttribute('data-by'))), ['f:kind', 'f:wiki', 'f:user', 'f:after'])
    await page.keyboard.press('Escape')
    // dse turned off: its 1,115 pages leave the list, the others stay
    await frame.locator('.thimble-filter-chip', { hasText: 'dse' }).click()
    await page.waitForTimeout(400)
    assert.equal(await count(frame), '3,343 pages')
    const dse = await frame.evaluate(() => [...document.querySelectorAll('#list .thimble-table-row .thimble-table-sub')].filter((s) => s.textContent!.startsWith('dse ·')).length)
    assert.equal(dse, 0)
    // Color by is untouched: every chip on
    assert.equal(await frame.locator('.thimble-colour-chip[aria-pressed="false"]').count(), 0)
    // on again: every page is back
    await frame.locator('.thimble-filter-chip', { hasText: 'dse' }).click()
    await page.waitForTimeout(400)
    assert.equal(await count(frame), '4,458 pages')
    assert.deepEqual(errors, [])
    await page.close()
  })
})
