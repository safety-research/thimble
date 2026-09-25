// The report page's layout while it changes under the analyst (src/report/ReportPage.tsx, Margin.tsx RAIL_ROOM,
// ReportTab.tsx, styles/report.css). While a check is on, its comments can arrive at any moment, so the margin stands
// from the start, empty, wherever the page holds it beside a column of 40 characters of the report's text: the first
// comment lands in it and the text keeps its width and place. With every check off there is no margin until a card has
// to show, and a page too narrow for both takes the margin only while it has a card. Switching the Report tab's
// documents never leaves the body empty (the one shown stays until the next is read, the answers held a moment as a
// server takes), and a document read before comes back at once.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, open, src } from './page.ts'

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const sentence = (id: string, text: string) => ({ id, text, refs: [], tags: [] })
const DOC = {
  title: 'Refunds',
  frame: false,
  generation: 3,
  sections: [
    {
      id: 'h1',
      heading: 'Findings',
      paragraphs: [
        { id: 'p1', sentences: [sentence('x1', 'Refunds rose in March, and half of them came from one store, which changed its policy on the first of the month.'), sentence('x2', 'The rise follows the new policy by a week, in every region the store serves.')] },
        { id: 'p2', sentences: [sentence('x3', 'The other stores kept the old policy and saw no rise over the same weeks.')] },
      ],
      figures: [],
    },
  ],
  comments: [],
}

describe('the margin', () => {
  let script: string
  const COMMENT = { id: 'c1', sentence_id: 'x1', text: 'The March card shows it.', author: 'check', check: 'verified', run: 'r1', status: 'open', ts: '' }
  const check = (shown: boolean) => ({ id: 'verified', name: 'Verified', prompt: 'Comment on each claim a card shows.', colour: 3, shown, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {} })
  const withComment = { ...DOC, comments: [COMMENT] }

  beforeAll(async () => {
    // the page in a row of a given width; __render gives it a new document, as a save or a check's comment does
    script = await bundle('report-margin', [
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { ReportPage } from '${src('report/ReportPage.tsx')}'`,
      `let root = null`,
      `const page = (doc) => <div className="wu-root"><div className="wu-body"><ReportPage ws="w" slug="report" doc={doc} filter={null} client="t" onSaved={() => {}} /></div></div>`,
      `window.__mount = (doc, width) => { const el = document.createElement('div'); el.id = 'row'; el.style.cssText = 'position:absolute;left:0;top:0;height:760px;display:flex;width:' + width + 'px'; document.body.appendChild(el); root = createRoot(el); flushSync(() => root.render(page(doc))) }`,
      `window.__render = (doc) => flushSync(() => root.render(page(doc)))`,
    ])
  })

  /** The report page in a row `width` wide, the Verified check on or off, the sidebar hidden so the page has the row. */
  async function openMargin(width: number, on: boolean) {
    const app = await open(browser, {
      script,
      styles: ['tokens', 'base', 'components', 'spinner', 'refchip', 'report'],
      context: { viewport: { width: 1400, height: 760 } },
      init: () => {
        try {
          localStorage.setItem('thimble:w:report-side', 'false')
        } catch {
          /* the sidebar's choice is only a convenience here */
        }
      },
      api: (_req, url) => (url.pathname === '/api/ws/w/checks' ? { json: [check(on)] } : url.pathname === '/api/ws/w/canvas' ? { json: { cells: [], groups: [] } } : undefined),
    })
    await app.page.evaluate(([doc, w]: any) => (window as any).__mount(doc, w), [DOC, width] as const)
    await app.page.waitForSelector('.bn-block-outer[data-id="p2"]')
    // the checks arrive from the server after the first render
    await app.page.waitForTimeout(400)
    return app
  }
  const text = async (page: Page) => (await page.locator('.bn-block-outer[data-id="p1"]').first().boundingBox())!
  const rails = (page: Page) => page.locator('.wu-rail').count()

  test('while a check is on, the margin stands from the start, and its first comment arrives without moving the text', async () => {
    const { page, errors, close } = await openMargin(1100, true)
    try {
      assert.equal(await rails(page), 1, 'the margin stands, empty, before any comment')
      assert.equal(await page.locator('.wu-cm').count(), 0)
      const before = await text(page)
      await page.evaluate((doc) => (window as any).__render(doc), withComment)
      await page.waitForSelector('.wu-rail .wu-cm')
      await page.waitForTimeout(100)
      const after = await text(page)
      assert.ok(Math.abs(after.width - before.width) < 0.5, `the text keeps its width (${before.width} then ${after.width})`)
      assert.ok(Math.abs(after.x - before.x) < 0.5, `and its place (${before.x} then ${after.x})`)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  test('with every check off there is no margin until a card has to show', async () => {
    const { page, errors, close } = await openMargin(1100, false)
    try {
      assert.equal(await rails(page), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  test('a page too narrow for the margin beside 40 characters of text takes the margin only while it has a card', async () => {
    const { page, errors, close } = await openMargin(480, true)
    try {
      assert.equal(await rails(page), 0, 'no empty margin squeezes the text')
      assert.ok((await text(page)).width > 300, 'the text keeps the page')
      await page.evaluate((doc) => (window as any).__render(doc), withComment)
      await page.waitForSelector('.wu-rail .wu-cm')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})

describe("switching the Report tab's documents", () => {
  const HOLD_MS = 250
  // the report written, the slides and the story not yet: their frames, as the types route answers them
  const TYPES = {
    report: { exists: true, generation: 1, renderer: 'document', name: 'Report' },
    slides: { exists: false, renderer: 'slides', frame: false, name: 'Slides' },
    story: { exists: false, renderer: 'story', frame: false, name: 'Story' },
  }
  const frame = (slug: string) => ({ id: slug, type: slug, renderer: slug, title: '', sections: [], frame: true, generation: 0 })
  const base = '/api/ws/mini/investigations/main/types'

  test('switching documents never leaves the body empty, and a document read before comes back at once', async () => {
    const script = await bundle('report-switch', [
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { ReportTab } from '${src('report/ReportTab.tsx')}'`,
      `window.__mount = () => { const el = document.createElement('div'); el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column'; document.body.appendChild(el); flushSync(() => createRoot(el).render(<ReportTab ws="mini" active={true} />)) }`,
    ])
    const { page, errors, close } = await open(browser, {
      script,
      ws: 'mini',
      styles: ['tokens', 'base', 'components', 'spinner', 'refchip', 'report'],
      context: { viewport: { width: 1200, height: 700 } },
      api: async (_req, url) => {
        const p = url.pathname
        if (p.startsWith(base)) await new Promise((r) => setTimeout(r, HOLD_MS))
        if (p === base) return { json: TYPES }
        if (p === `${base}/report/frame` || p === `${base}/report`) return { json: DOC }
        const m = new RegExp(`^${base}/(slides|story)/frame$`).exec(p)
        if (m) return { json: frame(m[1]) }
        if (p === '/api/ws/mini/chats') return { json: [] }
        if (p === '/api/ws/mini/canvas') return { json: { cells: [], groups: [] } }
        if (p === '/api/ws/mini/checks') return { json: [] }
        if (p === '/api/ws/mini/filters') return { json: {} }
        return undefined
      },
    })
    try {
      await page.evaluate(() => (window as any).__mount())
      await page.waitForSelector('.wu-body .bn-block-outer', { timeout: 10000 })

      /** Click a document's tab and watch the body on every frame from the click for `ms`: whether it stood empty
       * (the loading status alone) and which view it showed. */
      const switchTo = async (name: string, ms = HOLD_MS * 3) => {
        await page.evaluate((ms) => {
          const frames: { empty: boolean; report: boolean; arranged: boolean }[] = ((window as any).__frames = [])
          document.addEventListener(
            'click',
            () => {
              const t0 = performance.now()
              const tick = () => {
                const body = document.querySelector('.wu-body')!
                const empty = !!body.querySelector(':scope > .wu-status') && !body.querySelector('.wu-report, .wu-arranged')
                frames.push({ empty, report: !!body.querySelector('.wu-report:not(.wu-arranged)'), arranged: !!body.querySelector('.wu-arranged') })
                if (performance.now() - t0 < ms) requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            },
            { capture: true, once: true },
          )
        }, ms)
        await page.locator('.wu-types').getByRole('tab', { name, exact: true }).click()
        await page.waitForTimeout(ms + 100)
        return page.evaluate((): { empty: boolean; report: boolean; arranged: boolean }[] => (window as any).__frames)
      }

      const toSlides = await switchTo('Slides')
      assert.equal(toSlides.filter((f) => f.empty).length, 0, 'no empty frame while the slides are read')
      assert.ok(toSlides[0].report, 'the report stays while the slides are read')
      assert.ok(toSlides[toSlides.length - 1].arranged, 'then the slides show')
      const back = await switchTo('Report')
      assert.equal(back.filter((f) => f.empty).length, 0)
      assert.ok(back[0].report && back.every((f) => f.report), 'the report, read before, shows at once and stays')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
