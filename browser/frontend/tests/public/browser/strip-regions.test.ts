// The reader's strip (src/files/Tracks.tsx ReaderTracks) over a transcript of fewer records than the ruler's bins, in
// headless Chromium at a pixel ratio of 1 and 2: each record takes its share of the strip's height, consecutive records
// of one value draw as one block with no gap between them, and a record with no value leaves the lane's own background.
// With SBC_SHOT set to a folder, it saves a crop of the strip there.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let dir = ''

/** the records' values, a run of each, a record with none (-1) here and there: 65 records, as a short transcript */
const VALUES = [0, 0, 1, 1, 1, 2, 2, -1, 0, 1, 1, 1, 1, 2, 2, 2, 0, 0, 0, -1, -1, 1, 2, 2, 0, 0, 0, 0, 1, 1, 2, 1, 1, 1, 0, 0, -1, 2, 2, 2, 2, 0, 1, 1, 1, 1, 1, 2, 2, 0, 0, 0, 1, -1, 2, 2, 2, 0, 0, 1, 1, 1, 2, 2, 2]
const BINS = 2000

beforeAll(async () => {
  const script = await bundle(
    'strip-regions',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { labelPaint, PlaceFeed, ReaderTracks } from '${src('files/Tracks.tsx')}'`,
      `const VALUES = ${JSON.stringify(VALUES)}`,
      `const BINS = ${BINS}`,
      `const TOTAL = VALUES.length`,
      `const names = ['review', 'claimed PR', 'board']`,
      // the server's binning: line l in bin ⌊(l − 1) · BINS / TOTAL⌋, a record a line
      `const bins = {}, counts = {}`,
      `VALUES.forEach((v, i) => { if (v < 0) return; const n = names[v]; (bins[n] ??= []).push(Math.floor((i * BINS) / TOTAL)); (counts[n] ??= []).push(1) })`,
      `const ruler = { path: 'agent.jsonl', total: TOTAL, bins: BINS, labels: [{ concept_id: 'k', bins, counts }] }`,
      `const k = { id: 'k', labels: [...names, 'other'], classes: [{ name: 'review', color: 1, highlight: true }, { name: 'claimed PR', color: 2, highlight: true }, { name: 'board', color: 3, highlight: true }, { name: 'other', color: 0, highlight: false }] }`,
      `const paint = labelPaint(k, ruler, new Set())`,
      `const feed = new PlaceFeed()`,
      `feed.set({ top: 0.7, height: 0.2, scroll: 0, h: 600, content: 3000, start: false, end: true })`,
      `createRoot(document.getElementById('root')!).render(<div style={{ height: 600, display: 'flex', justifyContent: 'flex-end', background: 'var(--bg-app)' }}><ReaderTracks total={TOTAL} feed={feed} paint={paint} markers={[]} onSeek={() => {}} onScrollBy={() => 0} onMark={() => {}} /></div>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  dir = path.dirname(script)
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function open(dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 400, height: 600 }, deviceScaleFactor: dpr })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/')
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>',
      })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('.track-canvas')
  await page.waitForTimeout(250)
  return page
}

for (const dpr of [1, 2])
  test(`at a pixel ratio of ${dpr}, each record covers its share of the strip and a run of one value is one block`, async () => {
    const page = await open(dpr)
    const shot = process.env.SBC_SHOT
    if (shot) {
      const r = await page.evaluate(() => {
        const b = document.querySelector('.tracks')!.getBoundingClientRect()
        return { x: b.left - 6, y: 0, width: b.width + 12, height: 600 }
      })
      await page.screenshot({ path: path.join(shot, `strip-dpr${dpr}.png`), clip: r })
    }
    // the color lane's middle column, one value per device row: the lane's background or a color
    const rows: string[] = await page.evaluate((dpr) => {
      const cv = document.querySelector('.track-canvas') as HTMLCanvasElement
      const x = Math.round(6.5 * dpr)
      const d = cv.getContext('2d')!.getImageData(x, 0, 1, cv.height).data
      const out: string[] = []
      for (let y = 0; y < cv.height; y++) out.push(`${d[y * 4]},${d[y * 4 + 1]},${d[y * 4 + 2]},${d[y * 4 + 3]}`)
      return out
    }, dpr)
    const H = rows.length
    const bg = rows[Math.floor(((7 + 0.5) / VALUES.length) * H)]
    // each record's middle row in its value's color, one color per value, the background for none
    const colorOf = new Map<number, string>()
    VALUES.forEach((v, i) => {
      const got = rows[Math.floor(((i + 0.5) / VALUES.length) * H)]
      if (v < 0) return assert.equal(got, bg, `record ${i + 1} has no value`)
      assert.notEqual(got, bg, `record ${i + 1} is drawn`)
      if (!colorOf.has(v)) colorOf.set(v, got)
      assert.equal(got, colorOf.get(v), `record ${i + 1} in its value's color`)
    })
    // the strip's runs of one color are the records' runs of one value: no gap inside one, none between two
    const runs = (xs: readonly string[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1])
    assert.deepEqual(runs(rows), runs(VALUES.map((v) => (v < 0 ? bg : colorOf.get(v)!))))
    await page.close()
  })
