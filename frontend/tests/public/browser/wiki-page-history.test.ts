// The collusion-wiki demo's Wiki Page History view (demos/collusion-wiki) in a real browser, with the view kit, in a
// sandboxed frame whose fetches this page answers at once from made-up data as large as the dataset's (4,458 pages,
// about 15,000 revisions, long diffs), so what is timed is the page's own work. It opens and switches pages within a
// bound far above what it takes, which fails when either becomes many times slower; and it keeps what makes it fast:
// the list draws only the rows near its view and keeps them as it scrolls, a diff draws its first lines until Show
// all, the history draws only the items around its view and reads them in full as they come near, a Color by change
// reads nothing again, and the history's revisions have Color by's tracks while the list of pages, groups, has the
// kit's plain track. Color by only colors: a value turned off keeps its pages and revisions, without its colour; Filter
// by, over the same fields, is what hides them.
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
// the kit as views.frame_document loads it: the view's Filter by is viewer_controls.js's
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_range.js'].map((n) => `<script>${inline(read(n))}</script>`).join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-4:#56b4e9;--label-5:#7a7a00;--label-none:#a09c93;--ink-rgb:27,26,24;' +
  '--surface-card:#fffdf8;--surface-selected:#ece8df;--surface-hover:#f3f0e8;--raised-bg:#fffdf8;--track-bg:#ece8df;--viz-ink-2:#77736b;' +
  '--viz-ink-3:#a19d94;--status-positive:#1a7f37;--status-negative:#c0392b;--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;' +
  '--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;--radius-card:8px;--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;' +
  '--text-sm:13px;--text-ui-sm:12px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);--border-hairline:rgba(27,26,24,0.08);' +
  '--font-body:sans-serif;--font-mono:monospace}'
const DOC = VIEW_HTML.replace('<head>', `<head><style>${TOKENS}</style>${KIT}`)

// A bound many times what a step takes in headless Chromium (opening about 0.2 s, a page switch about 0.03 s here), so
// a slower machine passes and a page that draws every row, every line of every diff, or the whole history again fails.
const OPEN_MS = 2000
const SWITCH_MS = 500

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

// The made-up dataset and the reader's answers to the view's queries (overview, page), in the page that holds the frame:
// page r has fewer revisions the further down the list it is, the first 2,327; every revision's diff adds 36 lines of
// 140 characters between two unchanged ones.
function answers() {
  const W = window as any
  const T0 = Date.UTC(2026, 4, 24) / 1000
  const SPAN = 51 * 86400
  const NP = 4458
  const NU = 1200
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const n = (r: number) => Math.max(1, Math.floor(2327 / Math.pow(r + 1, 1.15)))
  const pages = { p: [] as number[], ln: [] as number[], w: [] as number[], name: [] as string[], n: [] as number[], f: [] as number[], l: [] as number[], u: [] as number[], d: [] as number[], pm: [] as number[], pb: [] as number[] }
  const revs = { rp: [] as number[], rt: [] as number[], ru: [] as number[], rk: [] as number[], rg: [] as number[], rs: [] as number[], rb: [] as number[] }
  const dels = { dp: [] as number[], dt: [] as number[], db: [] as number[] }
  const times: number[][] = []
  for (let r = 0; r < NP; r++) {
    const k = n(r)
    const start = Math.floor(rnd() * SPAN * 0.8)
    const ts = Array.from({ length: k }, () => start + Math.floor(rnd() * SPAN * 0.2)).sort((a, b) => a - b)
    times.push(ts)
    // each revision adds text with links (KINDS 2), unsigned (SIGNED 2)
    for (const t of ts) { revs.rp.push(r); revs.rt.push(t); revs.ru.push(Math.floor(rnd() * NU)); revs.rk.push(ts[0] === t ? 0 : 1); revs.rg.push(2); revs.rs.push(2); revs.rb.push(0) }
    const nd = r % 3 === 0 ? 1 : 0
    for (let j = 0; j < nd; j++) { dels.dp.push(r); dels.dt.push(ts[ts.length - 1] + 60); dels.db.push(0) }
    pages.p.push(r); pages.ln.push(r + 1); pages.w.push(r % 4); pages.name.push(`Page${r}Name${Math.floor(rnd() * 1e6)}`); pages.n.push(k)
    pages.f.push(ts[0]); pages.l.push(ts[ts.length - 1]); pages.u.push(Math.min(k, 1 + Math.floor(rnd() * 40))); pages.d.push(nd); pages.pm.push(0); pages.pb.push(0)
  }
  const wikis = ['dse', 'probier', 'fractal', 'dorfwiki']
  const users = Array.from({ length: NU }, (_, i) => `User${i}`)
  const overview = {
    t0: T0, span: [0, SPAN], wikis, users, pages, revs, dels, gone: { ot: [], ow: [], on: [] }, marks: [], admins: [], total: NP,
    keys: pages.name.map((s, r) => `${wikis[r % 4]}/${s}`), next: null,
  }
  const iso = (t: number) => new Date((T0 + t) * 1000).toISOString().slice(0, 19)
  const line = (i: number, j: number) => `* [https://example.org/data/county.json?q=${i}-${j}&format=json&source=example] ` + 'x'.repeat(60)
  // revision i of page r in full, as the reader's _block_rev gives it
  function block(r: number, i: number) {
    const ts = times[r]
    const diff: any[] = [[' ', 'unchanged before'], ['~', 12]]
    for (let j = 0; j < 36; j++) diff.push(['+', line(i, j)])
    diff.push([' ', 'unchanged after'])
    const message = diff.filter((d) => d[0] === '+').map((d) => d[1]).join('\n')
    return { ref: `revisions.jsonl#L${r * 3000 + i + 1}`, i: r * 3000 + i, rev_id: i + 1, seq: i + 1, time: iso(ts[i]), label: users[(i * 7) % NU], ip16: '10.0', change_summary: `edit ${i}`, body_len: 5000, lines: 40, write_date: iso(ts[i]), request_action: null, base: i ? 'prev' : 'new', add: 36, rem: 0, diff, admin: false, message, kind: 'With links', signature: '', marks: [] }
  }
  function page(q: any) {
    const r = q.p, ts = times[r], k = ts.length
    // with `items`, those items alone
    if (Array.isArray(q.items)) return { blocks: q.items.filter(([kind]: [string]) => kind === 'r').slice(0, 120).map(([, x]: [string, number]) => block(r, x - r * 3000)) }
    const from = Math.max(0, Math.min(q.from || 0, k - 1)), cnt = Math.min(q.n || 40, 120)
    const blocks = []
    for (let i = from; i < Math.min(k, from + cnt); i++) blocks.push(block(r, i))
    const strip = { k: ts.map(() => 'r'), x: ts.map((_, i) => r * 3000 + i), t: ts, u: ts.map((_, i) => (i * 7) % NU), a: ts.map(() => 36), r: ts.map(() => 0), m: ts.map(() => -1), s: ts.map((_, i) => i + 1), b: ts.map(() => 0), kb: ts.map((_, i) => (i ? 1 : 0)), g: ts.map(() => 2), sg: ts.map(() => 2), ln: ts.map((_, i) => r * 3000 + i + 1) }
    return {
      page: { p: r, page_id: overview.keys[r], wiki: wikis[r % 4], name: pages.name[r], n_revs: k, n_revs_before: 0, first_write: iso(ts[0]), last_write: iso(ts[k - 1]), n_labels: pages.u[r], deletes: pages.d[r], listed: true, key: overview.keys[r], thread: false, ref: `pages.jsonl#L${r + 1}` },
      strip, from, total: k, blocks, marks: [], users: [[0, k]], t0: T0, files: { revisions: 'revisions.jsonl', events: 'events.jsonl' },
    }
  }
  W.__fetches = []
  addEventListener('message', (e) => {
    const d = (e.data || {}) as any
    if (d.type !== 'thimble:fetch') return
    W.__fetches.push(d.query && d.query.op)
    const q = d.query || {}
    const data = q.op === 'overview' ? overview : q.op === 'page' ? page(q) : null
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
        if (!document.getElementById('vl')) return resolve(0)
        const ok = () => document.querySelectorAll('#vl .row').length > 0 && !!document.querySelector('#blocks .blk') && !!document.querySelector('#ph h2')
        const tick = () => (ok() ? requestAnimationFrame(() => requestAnimationFrame(() => resolve(Date.now()))) : setTimeout(tick, 0))
        tick()
      }))
      .catch(() => 0)
    if (frame && t1) return { page, frame, ms: t1 - t0, errors }
    assert.ok(tries < 2000, 'the view never drew its list and history')
    await page.waitForTimeout(5)
  }
}

// a row's click to its page's head and first revision drawn, in the frame
const switchTo = (frame: Frame, k: number) => frame.evaluate((k) => new Promise<{ ms: number; name: string }>((resolve) => {
  const row = document.querySelectorAll<HTMLElement>('#vl .row')[k]
  const name = row.querySelector('.nm')!.textContent!
  const t0 = performance.now()
  row.click()
  const tick = () => {
    const h = document.querySelector('#ph h2')
    if (h && h.textContent === name && document.querySelector('#blocks .blk')) return requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ms: performance.now() - t0, name })))
    setTimeout(tick, 0)
  }
  tick()
}), k)

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

  test('the list draws only the rows near its view and keeps them as it scrolls', async () => {
    const { page, frame } = await open()
    const s = await frame.evaluate(() => ({ rows: document.querySelectorAll('#vl .row').length, count: document.querySelector('#count')!.textContent }))
    assert.match(String(s.count), /4,458/)
    assert.ok(s.rows > 0 && s.rows <= 60, `${s.rows} rows drawn of 4,458`)
    // one row's height down: the rows drawn stay the same elements
    const kept = await frame.evaluate(() => new Promise<boolean>((resolve) => {
      const first = document.querySelector('#vl .row') as any
      first.__mark = true
      document.getElementById('list')!.scrollTop += 50
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(!!(document.querySelector('#vl .row') as any)?.__mark)))
    }))
    assert.ok(kept, 'a scroll of one row draws the rows again')
    // far down the list, still only the rows near the view
    const far = await frame.evaluate(() => new Promise<number>((resolve) => {
      document.getElementById('list')!.scrollTop = 100000
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelectorAll('#vl .row').length)))
    }))
    assert.ok(far > 0 && far <= 60, `${far} rows drawn far down the list`)
    await page.close()
  })

  test('the history: diffs drawn in part, only the items around the view drawn, Color by\'s tracks, and Color by reads nothing again', async () => {
    const { page, frame } = await open()
    const h = await frame.evaluate(() => {
      const d = document.querySelector('#blocks .blk .diff')!
      return {
        lines: d.querySelectorAll('.dl').length,
        more: !!d.parentElement!.querySelector('[data-long]'),
        tracked: document.getElementById('blocks')!.classList.contains('thimble-colour-scrolled'),
        // a page's row: the kit's mix of its revisions' colors, no color of its own
        rowMix: !!document.querySelector('#vl .row .thimble-mix:not([hidden])'),
        rowColoured: !!document.querySelector('#vl .row[data-colour], #vl .row [data-colour]'),
        // each strip by the list it stands beside, and whether it is the kit's plain track
        strips: [...document.querySelectorAll<HTMLElement>('.thimble-colour-strip')].map((el) => {
          const r = el.getBoundingClientRect()
          const by = ['list', 'blocks'].find((id) => { const b = document.getElementById(id)!.getBoundingClientRect(); return r.left >= b.left - 1 && r.right <= b.right + 1 })
          return `${by}:${el.hasAttribute('data-plain') ? 'plain' : 'colored'}`
        }).sort(),
      }
    })
    assert.ok(h.lines <= 28 && h.more, `a diff of 39 lines draws ${h.lines} with its Show all button: ${JSON.stringify(h)}`)
    // the history's revisions take the color, so it has Color by's tracks; the list's pages are groups, under the kit's
    // plain track
    assert.equal(h.tracked, true, "the history has Color by's tracks")
    assert.deepEqual(h.strips, ['blocks:colored', 'list:plain'], "the history has Color by's tracks, the list of pages the kit's plain track")
    assert.ok(h.rowMix && !h.rowColoured, `a page's row shows the kit's mix and takes no color: ${JSON.stringify(h)}`)
    // Show all draws the rest
    await frame.locator('#blocks [data-long]').first().click()
    assert.ok((await frame.evaluate(() => document.querySelector('#blocks .blk .diff')!.querySelectorAll('.dl').length)) >= 39)
    // scrolled to its end: the history draws only the items around the view, and reads those in full as they come near
    const read = await page.evaluate(() => (window as any).__fetches.filter((x: string) => x === 'page').length)
    const end = await frame.evaluate(() => new Promise<{ drawn: number; last: number; full: boolean; items: number }>((resolve) => {
      const box = document.getElementById('blocks')!
      const go = (tries: number) => {
        box.scrollTop = box.scrollHeight
        setTimeout(() => {
          const blks = [...box.querySelectorAll<HTMLElement>('.blk')]
          const last = blks.at(-1)!
          const out = { drawn: blks.length, last: Number(last.dataset.pos), full: !last.classList.contains('sk') && !!last.querySelector('.diff'), items: Number(document.querySelector<HTMLElement>('#blocks .blk')!.dataset.pos) }
          if (out.full || !tries) resolve(out)
          else go(tries - 1)
        }, 100)
      }
      go(30)
    }))
    assert.ok(end.full, `the last item was read in full at the end of the history: ${JSON.stringify(end)}`)
    assert.ok(end.drawn <= 60 && end.items > 0, `only the items around the view are drawn: ${JSON.stringify(end)}`)
    assert.ok((await page.evaluate(() => (window as any).__fetches.filter((x: string) => x === 'page').length)) > read, 'the items near the end were read')
    // back at its start, for the first revision
    await frame.evaluate(() => new Promise<void>((resolve) => {
      const box = document.getElementById('blocks')!
      const go = (tries: number) => {
        box.scrollTop = 0
        setTimeout(() => (document.querySelector('#blocks .blk.rev:not(.sk) .diff') && document.querySelector<HTMLElement>('#blocks .blk')!.dataset.pos === '0') || !tries ? resolve() : go(tries - 1), 100)
      }
      go(30)
    }))
    // a Color by change draws the history again from what was read
    const pages = await page.evaluate(() => (window as any).__fetches.filter((x: string) => x === 'page').length)
    // Color by's trigger, not Filter by's beside it (which shares its look)
    await frame.locator('.thimble-colour-by:not(.thimble-filter-by)').click()
    await frame.locator('.thimble-colour-menu [data-by="f:save"]').click()
    // Color by takes several choices: the ones before Kind of save unchecked, it alone colors
    for (const by of await frame.evaluate(() => [...document.querySelectorAll('.thimble-colour-menu [data-by][aria-checked="true"]')].map((e) => e.getAttribute('data-by')!).filter((b) => b !== 'f:save')))
      await frame.locator(`.thimble-colour-menu [data-by="${by}"]`).click()
    await frame.waitForFunction(() => document.querySelector('.thimble-colour-by:not(.thimble-filter-by) b')?.textContent === 'Kind of save')
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => (window as any).__fetches.filter((x: string) => x === 'page').length), pages, 'a Color by change read the page again')
    assert.ok(await frame.evaluate(() => document.querySelector('#blocks .blk.rev')!.getAttribute('data-colour') === 'New page'))
    await page.close()
  })

  test('Color by only colors: a wiki turned off keeps its pages and revisions, drawn without its colour', async () => {
    const { page, frame, errors } = await open()
    const look = () => frame.evaluate(() => {
      const sw = [...document.querySelectorAll('.thimble-colour-chip')].find((c) => c.querySelector('.chip-text')!.textContent === 'dse')!
      const dse = getComputedStyle(sw.querySelector('.chip-sw')!).backgroundColor
      const fills = [...document.querySelectorAll('#hs rect')].map((r) => getComputedStyle(r).fill)
      const rev = document.querySelector('#blocks .blk.rev')!
      return {
        count: document.querySelector('#count')!.textContent,
        dseRows: [...document.querySelectorAll('#vl .row .meta')].filter((m) => m.textContent!.startsWith('dse ·')).length,
        chart: fills.filter((f) => f === dse).length,
        gray: fills.filter((f) => f === 'rgb(161, 157, 148)').length,
        revColour: rev.getAttribute('data-colour'),
        revBar: rev.hasAttribute('data-thimble-bar'),
        revShown: getComputedStyle(rev).display !== 'none' && getComputedStyle(rev).opacity === '1',
        pressed: sw.getAttribute('aria-pressed'),
      }
    })
    const before = await look()
    assert.match(String(before.count), /4,458/)
    assert.ok(before.dseRows > 0 && before.chart > 0 && before.revColour === 'dse' && before.revBar, JSON.stringify(before))
    await frame.locator('.thimble-colour-chip', { hasText: 'dse' }).click()
    await page.waitForTimeout(300)
    const after = await look()
    // every page and revision stays: the count, the rows of dse, the open dse page's revisions, now with no bar
    assert.equal(after.pressed, 'false')
    assert.equal(after.count, before.count)
    assert.ok(after.dseRows > 0, JSON.stringify(after))
    assert.ok(after.revColour === 'dse' && !after.revBar && after.revShown, JSON.stringify(after))
    // the chart keeps dse's revisions, in the gray of the revisions with no value
    assert.equal(after.chart, 0)
    assert.ok(after.gray > before.gray, JSON.stringify({ before, after }))
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('Filter by, beside Color by over the same fields, hides the pages of a wiki turned off and shows them again', async () => {
    const { page, frame, errors } = await open()
    const state = () => frame.evaluate(() => ({
      count: document.querySelector('#count')!.textContent,
      dseRows: [...document.querySelectorAll('#vl .row .meta')].filter((m) => m.textContent!.startsWith('dse ·')).length,
      rows: document.querySelectorAll('#vl .row').length,
    }))
    // in the control row, before Color by, with no choice until the analyst makes one
    const row = await frame.evaluate(() => [...document.getElementById('ctl')!.children].map((e) => e.id || e.className))
    assert.ok(row.indexOf('filter') >= 0 && row.indexOf('filter') < row.indexOf('colour'), JSON.stringify(row))
    assert.equal(await frame.locator('.thimble-filter-by').textContent(), 'Filter by')
    await frame.locator('.thimble-filter-by').click()
    // its menu lists the fields Color by offers
    const fields = await frame.evaluate(() => [...document.querySelectorAll('.thimble-colour-menu [data-by^="f:"]')].map((e) => e.getAttribute('data-by')))
    assert.deepEqual(fields, ['f:wiki', 'f:save', 'f:status', 'f:kind', 'f:signed'])
    await frame.locator('.thimble-colour-menu [data-by="f:wiki"]').click()
    await page.waitForTimeout(200)
    assert.deepEqual(await frame.locator('.thimble-filter-chip .chip-text').allTextContents(), ['dse', 'probier', 'fractal', 'dorfwiki'])
    // dse turned off: its 1,115 pages leave the list, the others stay
    await frame.locator('.thimble-filter-chip', { hasText: 'dse' }).click()
    await page.waitForTimeout(300)
    const hidden = await state()
    assert.match(String(hidden.count), /3,343/)
    assert.equal(hidden.dseRows, 0)
    assert.ok(hidden.rows > 0, JSON.stringify(hidden))
    // Color by is untouched: every chip on
    assert.ok((await frame.locator('.thimble-colour-chip[aria-pressed="false"]').count()) === 0)
    // on again: every page is back
    await frame.locator('.thimble-filter-chip', { hasText: 'dse' }).click()
    await page.waitForTimeout(300)
    const back = await state()
    assert.match(String(back.count), /4,458/)
    assert.ok(back.dseRows > 0, JSON.stringify(back))
    assert.deepEqual(errors, [])
    await page.close()
  })
})
