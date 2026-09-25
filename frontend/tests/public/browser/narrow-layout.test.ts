// Sidebars in a narrow pane (src/shell/dock.tsx, files/FilesTab.tsx, report/Checks.tsx useSidebar, ReportPage.tsx), at
// a device scale of 1 and of 1.75 (a 175% zoom, whose fractional pixels round differently). A sidebar docks only while
// its row holds it beside a main column of 60-character lines of the column's text; in a narrower row (480px, the pane
// beside the chat at 175% of a 1440px window) the report's text, the reader and a view keep the row's width. The
// report's card sidebar and the File browser's tree then fold to their toggles, which open them over the column's left
// edge; a view's Labels sidebar lies over the view. A view's Labels sidebar starts hidden, shows by itself while a label
// is on, and keeps the analyst's own hide or show for the session.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, open, src, type Answer } from './page.ts'

let browser: Browser
let script: string

/** The pane beside the chat at 175% of a 1440px window, in CSS px (1440 / 1.75, less the chat and margins). */
const NARROW = 480
const WIDE = 1200

const F = 'tickets/2026-05.jsonl'
const sentence = (id: string, text: string) => ({ id, text, refs: [...text.matchAll(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g)].map((m) => m[1]), tags: [] })
const DOC = {
  title: 'Why refunds doubled after the price change',
  frame: false,
  generation: 1,
  sections: [
    {
      id: 'h1',
      heading: 'What happened',
      paragraphs: [
        { id: 'p1', sentences: [sentence('s1', `The billing job charged every customer who changed plans twice in one run [[${F}#L12]] and sent both receipts a second later, before support saw either.`)] },
        { id: 'p2', sentences: [sentence('s2', 'Customers then wrote to support for a refund, and two agents answered each ticket within a minute, both about the charge and none about the plan.')] },
      ],
      figures: [],
    },
  ],
  comments: [],
}

const C = (name: string, color: number, highlight: boolean) => ({ name, color, highlight })
const label = (id: string, name: string, color: number, shown: boolean) => ({ id, name, description: '', unit: 'record', marks: 'record', kind: 'regex', spec: 'x', labels: [name, `no ${name}`], classes: [C(name, color, true), C(`no ${name}`, 0, false)], created_by: 'user', ts: '2026-09-24T10:00:00Z', shown, glob: '*.jsonl' })
const VIEW = { slug: 'board', origin: 'workspace', name: 'Board', why: '', claims: ['*.jsonl'], accepts: [], declares: [], default: false, libs: [], built: '2026-09-24T10:00:00Z', ok: true, forms: [], first_file: 'a.jsonl' }
const LISTING = { path: '', files: [{ path: 'a.jsonl', kind: 'jsonl', size_bytes: 10 }], folders: [], n_files: 1 }

beforeAll(async () => {
  // the Files pane as the shell's panel holds it, or the report page inside the .wu-root and .wu-body that ReportTab
  // puts around it, in a box `width` wide that the tests narrow and widen
  script = await bundle('narrow-layout', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { FilesTab } from '${src('files/FilesTab.tsx')}'`,
    `import { ReportPage } from '${src('report/ReportPage.tsx')}'`,
    `const box = (width) => { const el = document.createElement('div'); el.id = 'row'; el.style.cssText = 'position:absolute;left:0;top:0;height:700px;display:flex;flex-direction:column;width:' + width + 'px'; document.body.appendChild(el); return el }`,
    `window.__files = (width) => flushSync(() => createRoot(box(width)).render(<FilesTab ws="mini" active />))`,
    `window.__report = (doc, width) => flushSync(() => createRoot(box(width)).render(<div className="wu-root"><div className="wu-body"><ReportPage ws="mini" slug="report" doc={doc} filter={null} client="t" onSaved={() => {}} /></div></div>))`,
  ])
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page at a device scale of `scale`, its routes answering from `concepts`. */
function openAt(scale: number, concepts: Map<string, object>) {
  const api = (req: { method(): string; postData(): string | null }, url: URL): Answer => {
    const put = url.pathname.match(/^\/api\/ws\/mini\/concepts\/(\w+)$/)
    if (req.method() === 'PUT' && put) {
      concepts.set(put[1], { ...concepts.get(put[1]), ...JSON.parse(req.postData() ?? '{}') })
      return { json: concepts.get(put[1]) }
    }
    if (req.method() !== 'GET' && url.pathname.startsWith('/api/')) return { json: { ok: true } }
    const p = url.pathname
    if (p === '/api/ws/mini/concepts') return { json: [...concepts.values()] }
    if (p === '/api/ws/mini/labels/presence') return { json: [] }
    if (p === '/api/ws/mini/views') return { json: [VIEW] }
    if (p === '/api/ws/mini/views/proposals') return { json: [] }
    if (p === '/api/ws/mini/views/board/frame') return { html: '<!doctype html><html><body><p>board</p></body></html>' }
    if (p === '/api/corpora/mini/sources') return { json: LISTING }
    if (p === '/api/ws/mini/canvas') return { json: { cells: [], groups: [] } }
    if (p === '/api/ws/mini/checks') return { json: [] }
    return undefined
  }
  return open(browser, {
    script,
    ws: 'mini',
    styles: ['tokens', 'base', 'components', 'spinner', 'refchip', 'shell', 'files', 'report'],
    blocknote: true,
    api,
    context: { viewport: { width: WIDE, height: 760 }, deviceScaleFactor: scale },
  })
}

const widthTo = async (page: Page, w: number) => {
  await page.evaluate((px) => (document.getElementById('row')!.style.width = `${px}px`), w)
  await page.waitForTimeout(150)
}
const rect = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!
const count = (page: Page, sel: string) => page.locator(sel).count()
/** The width of the readable minimum the row's ReadProbe measures. */
const readMin = (page: Page) => page.evaluate(() => document.querySelector('.read-probe > span')!.getBoundingClientRect().width)
const near = (a: number, b: number, what: string, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${what} (${a.toFixed(1)} vs ${b.toFixed(1)})`)

for (const scale of [1, 1.75]) {
  const pct = `${scale * 100}%`

  test(`${pct}: the report's card sidebar docks in a wide row; in the narrow pane it folds, opens over the page without moving the text, and the text keeps the row's width`, async () => {
    const { page, errors, close } = await openAt(scale, new Map())
    try {
      await page.evaluate((doc) => (window as any).__report(doc, 1200), DOC)
      await page.waitForSelector('.bn-block-outer[data-id="p2"]')
      await page.waitForTimeout(250)
      const min = await readMin(page)
      assert.ok(min > 400, `the readable minimum is 60 characters of the report's text and its gutters (${min.toFixed(0)}px)`)
      assert.equal(await count(page, '.wu-side.is-over'), 0)
      const [side, pageBox] = await Promise.all([rect(page, '.wu-side'), rect(page, '.wu-page')])
      assert.ok(side.x + side.width <= pageBox.x + 1, 'docked: the sidebar is left of the page')
      assert.ok((await rect(page, '.wu-page-col')).width >= min - 1, 'and the column keeps its readable minimum')

      await widthTo(page, NARROW)
      assert.equal(await count(page, '.wu-side'), 0, 'too narrow for both: the sidebar folds')
      assert.equal(await count(page, '.wu-side-show'), 1, 'to its toggle')
      const row = await rect(page, '.wu-report')
      const folded = await rect(page, '.wu-page')
      near(folded.x, row.x, "the page starts at the row's left edge")
      assert.ok(folded.width >= NARROW - 24, `the page keeps the row's width, less the ruler (${folded.width.toFixed(0)})`)
      const text = await rect(page, '.bn-block-outer[data-id="p1"]')
      assert.ok(text.width > 300, `the text is not squeezed (${text.width.toFixed(0)}px wide)`)

      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      await page.waitForSelector('.wu-side.is-over')
      await page.waitForTimeout(150)
      const over = await rect(page, '.wu-side')
      near(over.x, row.x, "the sidebar lies over the page's left edge")
      const [still, textStill] = await Promise.all([rect(page, '.wu-page'), rect(page, '.bn-block-outer[data-id="p1"]')])
      near(still.x, folded.x, 'the page does not move', 0.5)
      near(still.width, folded.width, 'nor narrow', 0.5)
      near(textStill.x, text.x, 'the text stays where it was', 0.5)
      near(textStill.width, text.width, 'at its width', 0.5)
      const onTop = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.wu-side'), { x: over.x + over.width / 2, y: over.y + 60 })
      assert.ok(onTop, 'the sidebar is drawn over the page')

      await page.locator('.wu-side').getByRole('button', { name: 'Hide sidebar', exact: true }).click()
      await page.waitForTimeout(150)
      assert.equal(await count(page, '.wu-side'), 0, 'hidden again')

      await widthTo(page, WIDE)
      assert.equal(await count(page, '.wu-side:not(.is-over)'), 1, 'wide again, it docks as the analyst left it')
      // the analyst hides it while it docks; opening it over the narrow page leaves that choice as it was
      await page.locator('.wu-side').getByRole('button', { name: 'Hide sidebar', exact: true }).click()
      await widthTo(page, NARROW)
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      await page.waitForSelector('.wu-side.is-over')
      await widthTo(page, WIDE)
      assert.equal(await count(page, '.wu-side'), 0, 'wide again after opening it over the page: hidden, as it was left while docked')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  test(`${pct}: a view's Labels sidebar starts hidden, shows by itself when a label is on, lies over the view in the narrow pane, and the analyst's hide holds for the session`, async () => {
    const concepts = new Map<string, object>([
      ['k1', label('k1', 'refund', 1, false)],
      ['k2', label('k2', 'charge', 2, false)],
    ])
    const { page, errors, load, close } = await openAt(scale, concepts)
    const board = async () => {
      await page.locator('.files-views .seg-opt', { hasText: 'Board' }).click()
      await page.waitForSelector('.view-pane')
      await page.waitForTimeout(200)
    }
    const browserTab = async () => {
      await page.locator('.files-views .seg-opt', { hasText: 'File browser' }).click()
      await page.waitForTimeout(200)
    }
    const turn = async (name: string) => {
      await browserTab()
      // in the narrow pane the File browser's tree is folded: its show button opens it over the reader
      if (!(await count(page, '.files-side'))) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      await page.locator('.files-side .files-label-toggle', { hasText: name }).click()
      await page.waitForTimeout(250)
      await board()
    }
    try {
      await page.evaluate(() => (window as any).__files(1200))
      await page.waitForSelector('.files-label')
      await board()
      assert.equal(await count(page, '.files-side-labels'), 0, 'no label on: the sidebar starts hidden')
      assert.equal(await count(page, '.view-pane-head [aria-label="Show labels"]'), 1, 'its show button stands in the view head')

      await turn('refund')
      assert.equal(await count(page, '.files-side-labels:not(.is-over)'), 1, 'a label on: it shows by itself, docked in a wide row')
      const [side, view] = await Promise.all([rect(page, '.files-side-labels'), rect(page, '.view-pane')])
      assert.ok(side.x + side.width <= view.x + 1, 'left of the view')
      assert.ok(view.width >= (await readMin(page)) - 1, 'the view keeps its readable minimum')

      await widthTo(page, NARROW)
      assert.equal(await count(page, '.files-side-labels.is-over'), 1, 'too narrow for both: it lies over the view')
      const [row, sideOver, viewFull] = await Promise.all([rect(page, '.files-body'), rect(page, '.files-side-labels'), rect(page, '.view-pane')])
      near(sideOver.x, row.x, "at the view's left edge")
      near(viewFull.x, row.x, "the view starts at the row's left edge")
      near(viewFull.width, row.width, "and keeps the row's width")
      assert.equal(await count(page, '.files-body.is-view > .shell-resizer'), 0, 'no seam to drag while it lies over the view')

      // the edit card stays inside the pane, over the sidebar where the pane has no room beside it
      await page.getByRole('button', { name: 'Edit refund', exact: true }).click()
      await page.waitForSelector('.label-card')
      const card = await rect(page, '.label-card')
      assert.ok(card.x >= row.x - 0.5 && card.x + card.width <= row.x + row.width + 0.5, `the edit card stays in the pane (${card.x.toFixed(0)}..${(card.x + card.width).toFixed(0)} of ${row.width})`)
      await page.locator('.label-card').getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.waitForTimeout(150)

      await page.getByRole('button', { name: 'Hide labels', exact: true }).click()
      await page.waitForTimeout(150)
      assert.equal(await count(page, '.files-side-labels'), 0, 'hidden by the analyst')
      await turn('charge')
      assert.equal(await count(page, '.files-side-labels'), 0, 'another label on does not bring it back')
      await load()
      await page.evaluate(() => (window as any).__files(480))
      // the File browser's tree is folded in the narrow pane, so the views bar is what shows the pane is up
      await page.waitForSelector('.files-views .seg-opt >> text=Board')
      await page.waitForTimeout(300)
      await board()
      assert.equal(await count(page, '.files-side-labels'), 0, 'nor does a reload in the same session')
      await page.locator('.view-pane-head').getByRole('button', { name: 'Show labels', exact: true }).click()
      await page.waitForTimeout(150)
      assert.equal(await count(page, '.files-side-labels.is-over'), 1, 'shown again by the analyst, over the view')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  test(`${pct}: the File browser's tree docks in a wide row, is dragged no wider than the reader leaves room for, and in the narrow pane folds to its show button, which opens it over the reader`, async () => {
    const { page, errors, close } = await openAt(scale, new Map([['k1', label('k1', 'refund', 1, false)]]))
    try {
      await page.evaluate(() => (window as any).__files(900))
      await page.waitForSelector('.files-side .files-side-tree')
      const min = await readMin(page)
      assert.ok(min > 400, `the readable minimum is 60 characters of a record's text and its gutters (${min.toFixed(0)}px)`)
      assert.equal(await count(page, '.files-side.is-over'), 0)
      // a drag as far right as the pointer goes stops where the reader would drop under its minimum
      const seam = await rect(page, '.files-body > .shell-resizer')
      await page.mouse.move(seam.x + seam.width / 2, seam.y + 100)
      await page.mouse.down()
      await page.mouse.move(seam.x + 700, seam.y + 100, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(150)
      assert.equal(await count(page, '.files-side:not(.is-over)'), 1, 'still docked after the drag')
      const [side, main] = await Promise.all([rect(page, '.files-side'), rect(page, '.files-main')])
      assert.ok(side.width > 250, `the drag widened it (${side.width.toFixed(0)})`)
      assert.ok(main.width >= min - 1.5, `the reader keeps its readable minimum (${main.width.toFixed(0)} of ${min.toFixed(0)})`)

      await widthTo(page, NARROW)
      assert.equal(await count(page, '.files-side'), 0, 'too narrow for both: the tree folds')
      const row = await rect(page, '.files-body')
      const reader = await rect(page, '.files-main')
      near(reader.width, row.width, "the reader keeps the row's width")
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      await page.waitForSelector('.files-side.is-over')
      const [over, still] = await Promise.all([rect(page, '.files-side'), rect(page, '.files-main')])
      near(over.x, row.x, "the tree lies over the reader's left edge")
      near(still.width, row.width, 'the reader does not narrow', 0.5)
      assert.ok(over.width <= row.width + 0.5, 'and the tree is no wider than the pane')
      await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
      await page.waitForTimeout(150)
      assert.equal(await count(page, '.files-side'), 0, 'folded again')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
}
