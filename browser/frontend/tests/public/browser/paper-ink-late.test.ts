// A custom card's own script that gives a box a white background after its page has loaded (I26; src/lib/ink.ts
// inkScript): on Dark, the box's title that sets no color has the paper's light ink, which vanishes on the new white
// box; the ink pass runs again when a style or a class changes, so the title takes the dark ink, whether the script set
// the box's style or gave it a class.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const CARD = `<html><head><style>body{margin:0;padding:12px 14px}
.box{border-radius:6px;padding:9px 12px;margin-bottom:8px}.box.white{background:#fff}.title{font-weight:600}</style></head><body>
<div class="box" id="styled"><div class="title" id="t1">Scheduler starts the run</div></div>
<div class="box" id="classed"><div class="title" id="t2">Build</div></div>
<script>addEventListener('load', function () { setTimeout(function () {
  document.getElementById('styled').style.background = '#ffffff'
  document.getElementById('classed').classList.add('white')
  document.body.setAttribute('data-done', '')
}, 400) })</script>
</body></html>`

beforeAll(async () => {
  const script = await bundle(
    'paper-ink-late',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CustomFrame } from '${src('canvas/DataViz.tsx')}'`,
      `const card = ${JSON.stringify(CARD)}`,
      `createRoot(document.getElementById('root')!).render(<div style={{ width: 600, background: 'var(--surface-card)' }}><CustomFrame html={card} title="steps" height={200} /></div>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => localStorage.setItem('thimble:paper', 'dark'))
  await page.reload()
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.canvas-card-frame[data-settled="true"]')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = (): Frame => page.frames().find((f) => f !== page.mainFrame())!

test("on Dark, a box's title reads on the dark ink once the card's own script gives the box a white background, by its style or by a class", async () => {
  await frame().waitForSelector('body[data-done]')
  // the pass waits 100 ms for more changes
  await page.waitForTimeout(600)
  const got = await frame().evaluate(() => {
    const rgb = (s: string) => (/rgba?\(([^)]+)\)/.exec(s)?.[1] ?? '0,0,0').split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number)
    const lum = (c: number[]) => c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
    const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    return ['t1', 't2'].map((id) => {
      const t = document.getElementById(id)!
      return { id, box: getComputedStyle(t.parentElement!).backgroundColor, color: getComputedStyle(t).color, contrast: Math.round(ratio(rgb(getComputedStyle(t).color), rgb(getComputedStyle(t.parentElement!).backgroundColor)) * 10) / 10 }
    })
  })
  for (const r of got) {
    assert.equal(r.box, 'rgb(255, 255, 255)', `${r.id}'s box is white`)
    assert.ok(r.contrast >= 3, `${r.id} reads at ${r.contrast}:1 on its white box (${r.color})`)
  }
})
