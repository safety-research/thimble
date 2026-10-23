// A label card on the real Canvas (src/canvas/Canvas.tsx): the card shows no record
// of the corpus, and its Definition and records opens the card's details at the board's right, where the label's
// definition and its records under each value are (DetailPanel LabelDetails), from the board and from focus mode.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const VALUES = ['message to other agents', 'list of links', 'other']
const COUNTS = { 'message to other agents': 4124, 'list of links': 9096, other: 1371 }
const RUN = { ts: '2026-10-15T11:58:00+00:00', paths: ['revisions.jsonl'], total: 14591, matched_total: 14591, labeled: 14591, failed: 0, status: 'done', matches: 4124 }
const LABEL = {
  id: 'k1',
  name: 'edit kind',
  description: '',
  unit: 'record',
  kind: 'code',
  spec: 'def label(r):\n    return "other", 1.0',
  glob: 'revisions.jsonl',
  marks: 'record',
  labels: VALUES,
  counts: COUNTS,
  n_labeled: 14591,
  created_by: 'model',
  ts: '2026-10-15T11:57:00+00:00',
  shown: true,
  classes: [
    { name: 'message to other agents', color: 1, highlight: true },
    { name: 'list of links', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
  last_run: RUN,
}
const RECORD = 'Beschreibe hier die neue Seite. Hallo an die anderen Agenten'
const CELL = { id: 'c1', notebook: 'g', kind: 'label', title: 'What kind of content does each wiki edit hold?', takeaway: 'Most edits hold lists of links.', created_by: 'model', ts: '2026-10-15T12:00:00+00:00', status: 'ok', labels: ['k1'], payload: { concept: 'k1' } }
const CANVAS = { groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }], cells: [CELL] }

beforeAll(async () => {
  const script = await bundle(
    'label-card',
    [`import '${src('styles/index.css')}'`, `import { createRoot } from 'react-dom/client'`, `import { Canvas } from '${src('canvas/Canvas.tsx')}'`, `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/concepts') return json([LABEL])
    if (p === '/api/ws/w/concepts/k1') return json({ ...LABEL, applications: [RUN], run: null, calibration: { n: 0, agreed: 0, disagreed: 0, est_precision: {} }, est_precision: null })
    if (p === '/api/ws/w/concepts/k1/rows') {
      const value = url.searchParams.get('value') ?? ''
      return json({ rows: [{ ref: 'revisions.jsonl#L12', label: value, rationale: '', analyst: null, text: `${RECORD} (${value})`, confidence: 1 }], total: 1, next: null })
    }
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="c1"] .bcell-label[data-settled="true"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const records = () => page.locator('[data-cell="c1"] .bcell-label button', { hasText: 'Definition and records' }).first()

test("the card shows no record; Definition and records opens the card's details with the label's records under each value", async () => {
  assert.equal(await page.locator('[data-cell="c1"] .bcell-label-row .bcell-kind-tag').first().innerText(), 'LABEL')
  assert.ok(!(await page.locator('article.canvas-card[data-cell="c1"]').first().innerText()).includes('Beschreibe'))
  assert.equal(await page.locator('.bdetail').count(), 0)
  await records().click()
  await page.waitForSelector('.bdetail')
  await page.waitForFunction((t) => document.querySelector('.bdetail')?.textContent?.includes(t), RECORD, { timeout: 5000 })
  // the card itself still shows none
  assert.ok(!(await page.locator('article.canvas-card[data-cell="c1"]').first().innerText()).includes('Beschreibe'))
  await page.locator('.bdetail-close').click()
  await page.waitForFunction(() => !document.querySelector('.bdetail'))
})

test("on a narrow card the label row's words go under its tags, whole, and the two tags stay on one line", async () => {
  const wide = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-cell="c1"] .bcell-label-row')!
    const top = (s: string) => row.querySelector(s)!.getBoundingClientRect().top
    return { meta: top('.bcell-label-meta'), tag: top('.bcell-kind-tag') }
  })
  assert.ok(Math.abs(wide.meta - wide.tag) < 8, 'on a wide card the row is one line')
  await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-cell="c1"]')!
    ;(card.closest<HTMLElement>('.bcell') ?? card).style.width = '360px'
  })
  await page.waitForTimeout(200)
  const narrow = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-cell="c1"] .bcell-label-row')!
    const meta = row.querySelector<HTMLElement>('.bcell-label-meta')!
    const box = (s: string) => row.querySelector(s)!.getBoundingClientRect()
    return { cut: meta.scrollWidth > meta.clientWidth, metaTop: box('.bcell-label-meta').top, kindTop: box('.bcell-kind-tag').top, kindBottom: box('.bcell-kind-tag').bottom, tagTop: box('.bcell-tag').top, rowRight: row.getBoundingClientRect().right, metaRight: box('.bcell-label-meta').right }
  })
  assert.equal(narrow.cut, false, 'how the label is defined and what it ran on show whole')
  assert.ok(narrow.metaTop >= narrow.kindBottom - 1, 'they stand under the tags')
  assert.ok(Math.abs(narrow.kindTop - narrow.tagTop) < 4, 'the Label tag and the label tag share a line')
  assert.ok(narrow.metaRight <= narrow.rowRight + 1)
  await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-cell="c1"]')!
    ;(card.closest<HTMLElement>('.bcell') ?? card).style.width = ''
  })
})

test('from focus mode it leaves focus mode and opens the same details', async () => {
  // the card is selected (Definition and records selected it), and Enter opens focus mode on it
  await page.keyboard.press('Enter')
  await page.waitForSelector('.bfocus')
  await page.locator('.bfocus .bcell-label button', { hasText: 'Definition and records' }).click()
  await page.waitForFunction(() => !document.querySelector('.bfocus') && !!document.querySelector('.bdetail'))
  await page.waitForFunction((t) => document.querySelector('.bdetail')?.textContent?.includes(t), RECORD, { timeout: 5000 })
})
