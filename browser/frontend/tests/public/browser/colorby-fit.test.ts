// The value chips of Files' Color by and Filter by (src/files/ColorBy.tsx fitChips) in a real browser's layout, with
// the page's stylesheet and faces, which jsdom cannot lay out: at every width of the reader, as a 1024 px page gives it
// and narrower, each chip shows whole or goes behind "N more". The chips' box cuts what runs past its right edge, and
// fitting by its scrollWidth and clientWidth, whole pixels with a pixel of slack, left a chip that ran a pixel past the
// edge drawn there without its right border.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

// the reader's widths tried, each a pixel apart: a 1024 px page's and narrower ones
const FROM = 480
const TO = 720

let browser: Browser
let page: Page

beforeAll(async () => {
  // the row of the Transcript mode: Filter by a key, Color by a label with values it leaves unmarked, Collapse all
  const script = await bundle('colorby-fit', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { ColorBy } from '${src('files/ColorBy.tsx')}'`,
    `import { FilterBy } from '${src('files/FilterBy.tsx')}'`,
    `import { Button } from '${src('components/Button.tsx')}'`,
    `import { labelChips } from '${src('files/colorChoice.ts')}'`,
    `const label = { id: 'k1', name: 'step kind', description: '', unit: 'record', kind: 'code', spec: '', labels: ['read', 'edit', 'test', 'other'], created_by: 'claude', ts: '', classes: [{ name: 'read', color: 1, highlight: true }, { name: 'edit', color: 2, highlight: true }, { name: 'test', color: 3, highlight: true }, { name: 'other', color: 0, highlight: false }] }`,
    `const counts = { read: 9, edit: 171, test: 24, other: 52 }`,
    `const types = [['assistant', 434], ['user', 266], ['attachment', 189], ['system', 44], ['queue-operation', 28]].map(([v, n]) => ({ id: v, name: v, n, color: null }))`,
    `const none = () => undefined`,
    `const pane = document.createElement('div')`,
    `pane.className = 'files-main'`,
    `pane.style.height = '200px'`,
    `document.body.appendChild(pane)`,
    `flushSync(() => createRoot(pane).render(`,
    `  <div className="reader"><div className="reader-colorbar">`,
    `    <FilterBy choice={{ by: 'key', key: 'type' }} keys={[]} labels={[label]} values={types} off={[]} onChoose={none} onToggle={none} countsOf={() => counts} />`,
    `    <ColorBy choice={{ by: 'label', id: 'k1' }} keys={[]} labels={[label]} values={labelChips(label, counts, 1123)} off={[]} onChoose={none} onToggle={none} countsOf={() => counts} />`,
    `    <Button size="sm" className="reader-foldall" onClick={none}>Collapse all</Button>`,
    `  </div></div>))`,
    `window.__pane = pane`,
  ])
  // the page's one stylesheet with its faces in it, as the app loads them
  const css = await build({ entryPoints: [`${FRONTEND}/src/styles/index.css`], bundle: true, write: false, loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, logLevel: 'error' })
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1024, height: 400 } })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.protocol === 'data:') return route.continue()
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addStyleTag({ content: css.outputFiles[0].text })
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.colorby-chip')
  await page.evaluate(() => document.fonts.ready)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test('at every width of the reader, each chip of Color by and Filter by shows whole or goes behind "N more"', async () => {
  const cut = await page.evaluate(
    async ([from, to]) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      const out: string[] = []
      for (let w = from; w <= to; w++) {
        ;(window as unknown as { __pane: HTMLElement }).__pane.style.width = `${w}px`
        // the row's resize is heard in this frame, and the chips are fitted in the next
        await frame()
        await frame()
        await frame()
        for (const box of document.querySelectorAll<HTMLElement>('.colorby-chips, .filterby-chips')) {
          const shown = [...box.children].filter((c) => !(c as HTMLElement).hidden)
          const last = shown[shown.length - 1]
          const over = last ? last.getBoundingClientRect().right - box.getBoundingClientRect().right : 0
          if (over > 0.05) out.push(`${w}px: ${box.className} cuts ${last.textContent} by ${over.toFixed(2)}px`)
        }
      }
      return out
    },
    [FROM, TO],
  )
  assert.deepEqual(cut, [])
})
