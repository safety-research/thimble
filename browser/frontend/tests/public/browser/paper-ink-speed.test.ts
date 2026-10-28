// A large figure mends its ink in about the time it takes to draw (I26; src/lib/ink.ts, src/components/Outputs.tsx
// InlineSvg). A 30×30 annotated heatmap, as matplotlib writes it (900 cells as paths, a label on each, ticks drawn
// with <use>), on Dark: its black labels on its light cells take the dark ink, and its mount and each width change
// block the page about as long as on Warm, where nothing is mended.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let script: string
let css: string

const N = 30
const X0 = 81
const Y0 = 576.72
const W = 16.74
const H = 16.632
// viridis, from its dark end to its light end
const VIRIDIS = [
  [0x44, 0x01, 0x54],
  [0x3b, 0x52, 0x8b],
  [0x21, 0x91, 0x8c],
  [0x5e, 0xc9, 0x62],
  [0xfd, 0xe7, 0x25],
]
const hex = (z: number) => {
  const at = z * (VIRIDIS.length - 1)
  const i = Math.min(Math.floor(at), VIRIDIS.length - 2)
  const f = at - i
  return '#' + VIRIDIS[i].map((c, k) => Math.round(c + (VIRIDIS[i + 1][k] - c) * f).toString(16).padStart(2, '0')).join('')
}

/** What matplotlib writes for `pcolormesh` and a label on each cell, white on a dark cell and black (no fill) on a
 * light one: the cells, then the axes' ticks, then the labels. */
function heatmap(): string {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const z = Array.from({ length: N * N }, rand)
  const font = "font-size: 6px; font-family: 'Hanken Grotesk', 'DejaVu Sans', 'Bitstream Vera Sans', sans-serif; text-anchor: middle"
  const cells: string[] = []
  const labels: string[] = []
  z.forEach((v, k) => {
    const [i, j] = [Math.floor(k / N), k % N]
    const [x0, x1, y0, y1] = [X0 + j * W, X0 + (j + 1) * W, Y0 - i * H, Y0 - (i + 1) * H].map((n) => +n.toFixed(3))
    cells.push(`<path d="M ${x0} ${y0} \nL ${x1} ${y0} \nL ${x1} ${y1} \nL ${x0} ${y1} \nL ${x0} ${y0} \n" clip-path="url(#pclip)" style="fill: ${hex(v)}"/>`)
    const [x, y] = [+(x0 + W / 2).toFixed(3), +((y0 + y1) / 2 + 2.2).toFixed(3)]
    labels.push(`<g id="text_${k + 15}"><text id="label_${k}" style="${font}${v > 0.5 ? '' : '; fill: #ffffff'}" x="${x}" y="${y}" transform="rotate(-0 ${x} ${y})">${v.toFixed(1)}</text></g>`)
  })
  const ticks = (axis: string, d: string, at: (n: number) => [number, number]) =>
    Array.from({ length: 7 }, (_, n) => {
      const [x, y] = at(n)
      const def = n ? '' : `<defs><path id="m${axis}" d="${d}" style="stroke: #64625b; stroke-width: 0.8"/></defs>`
      return `<g id="${axis}tick_${n + 1}"><g id="line2d_${axis}${n}">${def}<g><use xlink:href="#m${axis}" x="${x}" y="${y}" style="fill: #64625b; stroke: #64625b; stroke-width: 0.8"/></g></g>`
        + `<g id="text_${axis}${n}"><text style="${font}; fill: #64625b" x="${x}" y="${y + 12}">${n * 5}</text></g></g>`
    }).join('\n')
  return `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="648pt" height="648pt" viewBox="0 0 648 648" xmlns="http://www.w3.org/2000/svg" version="1.1">
 <defs><style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style></defs>
 <g id="figure_1"><g id="patch_1"><path d="M 0 648 L 648 648 L 648 0 L 0 0 L 0 648 z" style="fill: none"/></g>
 <g id="axes_1"><g id="patch_2"><path d="M 81 576.72 L 583.2 576.72 L 583.2 77.76 L 81 77.76 L 81 576.72 z" style="fill: none"/></g>
 <g id="QuadMesh_1">
${cells.join('\n')}
 </g>
 <g id="matplotlib.axis_1">${ticks('x', 'M 0 0 L 0 3.5', (n) => [X0 + n * 5 * W, Y0])}</g>
 <g id="matplotlib.axis_2">${ticks('y', 'M 0 0 L -3.5 0', (n) => [X0, Y0 - n * 5 * H])}</g>
 <g id="patch_3"><path d="M 81 576.72 L 81 77.76 " style="fill: none; stroke: #a19d94; stroke-width: 0.8"/></g>
 <g id="patch_4"><path d="M 81 576.72 L 583.2 576.72 " style="fill: none; stroke: #a19d94; stroke-width: 0.8"/></g>
${labels.join('\n')}
 </g></g>
 <defs><clipPath id="pclip"><rect x="81" y="77.76" width="502.2" height="498.96"/></clipPath></defs>
</svg>`
}

beforeAll(async () => {
  script = await bundle(
    'paper-ink-speed',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Output } from '${src('components/Outputs.tsx')}'`,
      `const svg = ${JSON.stringify(heatmap())}`,
      `const w = window as any`,
      `const root = createRoot(document.getElementById('root')!)`,
      `let n = 0`,
      // each pass writes its mark on each text it mends (lib/ink MENDED), and takes it off first
      `w.writes = 0`,
      `new MutationObserver((rs) => { w.writes += rs.length }).observe(document.getElementById('root')!, { subtree: true, attributeFilter: ['data-thimble-ink'] })`,
      // how long an act and the frame after it take: the frame lays the figure out and runs its observers
      `const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))`,
      `const timed = async (act: () => void) => { await frame(); const t = performance.now(); act(); await frame(); return performance.now() - t }`,
      `w.unmount = () => root.render(<div />)`,
      `w.mount = () => timed(() => root.render(<div id="wrap" style={{ width: 900, background: 'var(--surface-card)' }}><div id="fig"><Output key={++n} bundle={{ 'image/svg+xml': svg }} /></div></div>))`,
      `w.widen = (px: number) => timed(() => { (document.getElementById('wrap') as HTMLElement).style.width = px + 'px' })`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page on `paper` with the heatmap's bundle loaded and nothing drawn. */
async function open(paper: 'warm' | 'dark'): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate((p) => localStorage.setItem('thimble:paper', p), paper)
  await page.reload()
  await page.addScriptTag({ path: script })
  return page
}

type Measure = { mount: number; resize: number; mountWrites: number; resizeWrites: number; mended: number }

/** The heatmap's mount on each page in turn, three times (the least time counts, as the machine may be busy), then
 * three width changes: how long each took with its frame, and how many marks the ink passes wrote. */
async function measure(pages: Page[]): Promise<Measure[]> {
  const mounts = pages.map(() => [] as number[])
  const writes = pages.map(() => 0)
  for (let i = 0; i < 3; i++)
    for (const [k, page] of pages.entries()) {
      await page.evaluate(() => (window as any).unmount())
      await page.evaluate(() => ((window as any).writes = 0))
      mounts[k].push(await page.evaluate(() => (window as any).mount()))
      writes[k] = await page.evaluate(() => (window as any).writes)
    }
  const out: Measure[] = []
  for (const [k, page] of pages.entries()) {
    const mended = await page.evaluate(() => document.querySelectorAll('[data-thimble-ink]').length)
    await page.evaluate(() => ((window as any).writes = 0))
    let resize = 0
    for (const w of [800, 700, 850]) resize += await page.evaluate((w) => (window as any).widen(w), w)
    const resizeWrites = await page.evaluate(() => (window as any).writes)
    out.push({ mount: Math.round(Math.min(...mounts[k])), resize: Math.round(resize), mountWrites: writes[k], resizeWrites, mended })
  }
  return out
}

test("on Dark, a 30×30 annotated heatmap's black labels on its light cells take the dark ink in one pass, and it mounts and resizes about as fast as on Warm", async () => {
  const pages = [await open('warm'), await open('dark')]
  const [warm, dark] = await measure(pages)
  console.log(JSON.stringify({ warm, dark }))
  // every label reads on its cell: the dark ink on a light cell, white on a dark one
  const low = await pages[1].evaluate(() => {
    const rgb = (s: string) => (/rgba?\(([^)]+)\)/.exec(s)?.[1] ?? '0,0,0').split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number)
    const lum = (c: number[]) => c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
    const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const cells = Array.from(document.querySelectorAll('[id$="QuadMesh_1"] > path'))
    const labels = Array.from(document.querySelectorAll('text[id*="label_"]'))
    return labels.map((t, k) => ratio(rgb(getComputedStyle(t).fill), rgb(getComputedStyle(cells[k]).fill))).filter((r) => r < 3).length
  })
  assert.equal(low, 0, `${low} of ${N * N} labels read under 3:1 on their cells`)
  assert.ok(dark.mended > 0, 'the black labels on light cells are mended')
  // one pass on mount, which marks each text it mends once, and none when the width changes
  assert.equal(dark.mountWrites, dark.mended, `the mount wrote ${dark.mountWrites} marks for ${dark.mended} mended labels`)
  assert.equal(dark.resizeWrites, 0, `three width changes wrote ${dark.resizeWrites} marks`)
  // within 100 ms of Warm where Warm mounts the figure in 250 ms or less, and in proportion on a busier machine
  const slack = 100 * Math.max(1, warm.mount / 250)
  assert.ok(dark.mount <= warm.mount + slack, `on Dark the mount takes ${dark.mount} ms, on Warm ${warm.mount} ms`)
  assert.ok(dark.resize <= warm.resize + slack, `on Dark three width changes take ${dark.resize} ms, on Warm ${warm.resize} ms`)
  for (const page of pages) await page.close()
}, 240_000)
