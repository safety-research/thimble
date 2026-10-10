// The find's colors (tokens.css --find-bg and --find-bg-strong, and the accent as text for a tick) in headless
// Chromium on the theme's own tokens, light and dark, iris and pink: the view kit's search (viewer_search.js,
// viewer_kit.css) washes every match in a tint of the accent and the current one in a stronger tint, a kept record whose
// words do not show takes the matches' tint for a moment, and its ticks on the list's strip (viewer_colour.js) are the
// accent as text; the tree's and the record's own find (viewer_parts.css) and Files' find (files.css
// ::highlight(reader-find), the folder search's marks) take the same tints. On every paper and accent the text and the
// secondary text read at 4.5:1 or more on the current match's tint, each tint stands as far apart from the cell and from
// the other as on iris (the accent's --find-mix), and a tick reads at 3:1 or more on the cell. Files' strip draws its find's ticks in the same color
// (tests/public/browser/tracks.test.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_messages.js', 'viewer_search.js', 'viewer_table.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS = readFileSync(path.join(FRONTEND, 'src', 'styles', 'tokens.css'), 'utf8') + ':root{--font-body:sans-serif;--font-mono:monospace}'
const FILES_CSS = readFileSync(path.join(FRONTEND, 'src', 'styles', 'files.css'), 'utf8')

type RGB = [number, number, number]
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB
/** `c` at `a` over the opaque `bg`, as the browser composites it */
const over = (c: RGB, a: number, bg: RGB): RGB => c.map((v, i) => Math.round(a * v + (1 - a) * bg[i])) as RGB
const near = (got: number[], want: number[], tol = 3) => got.slice(0, 3).every((v, i) => Math.abs(v - want[i]) <= tol)
const lum = (c: number[]) => {
  const l = c.slice(0, 3).map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}
const contrast = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
const apart = (a: number[], b: number[]) => Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i])))
/** the distance of two colors in OKLab, times 100 */
const oklab = (c: number[]) => {
  const [r, g, b] = c.slice(0, 3).map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const dE = (a: number[], b: number[]) => 100 * Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]))

// the papers' cells and the accents' fills and inks, as tokens.css sets them
const CELL: Record<string, RGB> = { light: hex('#fffdf8'), dark: hex('#25252a') }
const FILL: Record<string, RGB> = { iris: hex('#5135ff'), pink: hex('#d6336c') }
const INK: Record<string, RGB> = { iris: hex('#5135ff'), pink: hex('#b4295a') }
// the tints' shares of the accent (its --find-mix): the match's and the current match's, on the light papers and on Dark
const SHARE: Record<string, Record<string, [number, number]>> = {
  light: { iris: [0.2, 0.32], pink: [0.26, 0.4] },
  dark: { iris: [0.32, 0.5], pink: [0.32, 0.5] },
}
const THEMES = [
  ['light', 'iris'],
  ['light', 'pink'],
  ['dark', 'iris'],
  ['dark', 'pink'],
] as const

const html = (theme: string, accent: string, head: string, body: string) =>
  `<!doctype html><html${theme === 'dark' ? ' data-paper="dark"' : ''} data-accent="${accent}"><head><style>${TOKENS} html,body{margin:0;height:100%} body{background:var(--surface-card)}</style>${head}</head><body>${body}</body></html>`

const ROWS = Array.from({ length: 80 }, (_, i) => `<div data-anchor="log.jsonl#L${i + 1}" style="padding:0 8px">row ${i}${i % 5 === 3 ? ' xxxx' : ''}</div>`).join('')
/** a list that scrolls, the search over it, and the parts' own find marks */
const SEARCH = (theme: string, accent: string) =>
  html(
    theme,
    accent,
    KIT,
    `<div style="padding:8px"><span id="search"></span></div>
<div id="list" style="height:400px;overflow-y:auto;font:24px/36px sans-serif">${ROWS}</div>
<p><mark class="thimble-tree-hit" id="tree-hit">gale</mark> <mark class="thimble-record-hit" id="record-hit">gale</mark>
<i id="probe-find" style="background:var(--find-bg)">probe</i> <i id="probe-hl" style="background:var(--hl-bg)">probe</i>
<i id="probe-accent" style="color:var(--text-accent)">probe</i> <i id="probe-text" style="color:var(--text-primary)">probe</i></p>
<script>window.search = thimble.search({ mount: '#search', in: '#list' })</script>`,
  )

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function open(doc: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 })
  await page.setContent(doc)
  await page.waitForTimeout(200)
  return page
}

/** the color of the page's pixel at (x, y), from a picture of it */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    return Array.from(g.getImageData(0, 0, 1, 1).data)
  }, png.toString('base64'))
}

/** a point inside a highlight's range clear of the glyphs: above the x-height of "xxxx", at the middle of its width */
const inRange = (name: string, visible = true) =>
  async (page: Page) =>
    page.evaluate(
      ([name, visible]) => {
        const list = document.getElementById('list')!.getBoundingClientRect()
        for (const r of (CSS as any).highlights.get(name) ?? []) {
          const b = (r as Range).getBoundingClientRect()
          if (!visible || (b.top >= list.top && b.bottom <= list.bottom)) return { x: b.left + b.width / 2, y: b.top + 3 }
        }
        return null
      },
      [name, visible] as const,
    )

/** a color as the canvas draws it (rgba 0-255), the page's computed color of `css` on an element */
const drawn = (page: Page, sel: string, prop: 'color' | 'backgroundColor') =>
  page.evaluate(
    ([sel, prop]) => {
      const c = document.createElement('canvas')
      c.width = c.height = 1
      const g = c.getContext('2d')!
      g.fillStyle = getComputedStyle(document.querySelector(sel)!)[prop]
      g.fillRect(0, 0, 1, 1)
      return Array.from(g.getImageData(0, 0, 1, 1).data)
    },
    [sel, prop] as const,
  )

describe("the view kit's search", () => {
  for (const [theme, accent] of THEMES) {
    test(`${theme}, ${accent}: every match in a tint of the accent, the current one stronger, the strip's ticks the accent as text`, async () => {
      const page = await open(SEARCH(theme, accent))
      await page.evaluate(() => (window as any).search.set('xxxx'))
      await page.waitForTimeout(400)
      assert.equal(await page.evaluate(() => (window as any).search.count), 16)
      await page.evaluate(() => (window as any).search.go(1))
      await page.waitForTimeout(200)
      const cur = (await inRange('thimble-search-current')(page))!
      const other = (await inRange('thimble-search')(page))!
      assert.ok(cur && other, 'a current match and another on screen')
      const [m, s] = SHARE[theme][accent]
      const want = { match: over(FILL[accent], m, CELL[theme]), current: over(FILL[accent], s, CELL[theme]) }
      const got = { match: await pixel(page, other.x, other.y), current: await pixel(page, cur.x, cur.y) }
      assert.ok(near(got.match, want.match), `the match's tint: ${got.match}, want ${want.match}`)
      assert.ok(near(got.current, want.current), `the current match's tint: ${got.current}, want ${want.current}`)
      // the strip's lane of ticks: the accent as text, never the text's ink
      const tick = await page.evaluate(() => {
        const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
        const dpr = window.devicePixelRatio || 1
        const data = cv.getContext('2d')!.getImageData(Math.round(6 * dpr), 0, 1, cv.height).data
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 250) return Array.from(data.slice(i, i + 4))
        return null
      })
      assert.ok(tick, 'a tick drawn in the lane')
      const ink = theme === 'light' ? INK[accent] : await drawn(page, '#probe-accent', 'color')
      assert.ok(near(tick!, ink, 2), `the tick: ${tick}, want the accent as text ${ink}`)
      assert.ok(apart(tick!, await drawn(page, '#probe-text', 'color')) > 40, `the tick is not the text's ink: ${tick}`)
      // the tree's and the record's own find marks take the matches' tint
      const marks = await page.evaluate(() => ['#tree-hit', '#record-hit', '#probe-find', '#probe-hl'].map((s) => getComputedStyle(document.querySelector(s)!).backgroundColor))
      assert.equal(marks[0], marks[2])
      assert.equal(marks[1], marks[2])
      assert.notEqual(marks[2], marks[3])
      await page.close()
    })
  }

  test('dark, graphite: the tints take the accent as text, since its fill is too near the cell to show', async () => {
    const page = await open(SEARCH('dark', 'graphite'))
    await page.evaluate(() => (window as any).search.set('xxxx'))
    await page.waitForTimeout(400)
    const other = (await inRange('thimble-search')(page))!
    const got = await pixel(page, other.x, other.y)
    assert.ok(contrast(got, CELL.dark) >= 1.3, `the match's tint ${got} stands apart from the cell: ${contrast(got, CELL.dark).toFixed(2)}`)
    await page.close()
  })

  test("a kept record whose words do not show takes the matches' tint for a moment when gone to", async () => {
    const doc = html(
      'light',
      'pink',
      KIT,
      `<div style="padding:8px"><span id="search"></span></div><div id="list" style="height:400px;overflow-y:auto;font:16px/28px sans-serif">${ROWS}</div>
<script>window.search = thimble.search({ mount: '#search', in: '#list', onChange: (s) => s.kept(s.text ? ['log.jsonl#L3', 'log.jsonl#L6'] : null) })</script>`,
    )
    const page = await open(doc)
    await page.evaluate(() => (window as any).search.set('gale'))
    await page.waitForFunction(() => document.querySelector('[data-thimble-snap]'), null, { timeout: 3000 })
    const row = await page.evaluate(() => {
      const el = document.querySelector('[data-thimble-snap]') as HTMLElement
      const b = el.getBoundingClientRect()
      return { ref: el.getAttribute('data-anchor'), snap: el.getAttribute('data-thimble-snap'), anim: getComputedStyle(el).animationName, x: b.right - 20, y: b.top + b.height / 2 }
    })
    assert.deepEqual([row.ref, row.snap, row.anim], ['log.jsonl#L3', 'search', 'thimble-snap-search'])
    const got = await pixel(page, row.x, row.y)
    const want = over(FILL.pink, SHARE.light.pink[0], CELL.light)
    assert.ok(near(got, want, 4), `the kept record's tint: ${got}, want ${want}`)
    await page.close()
  })
})

describe("Files' find", () => {
  for (const [theme, accent] of THEMES) {
    test(`${theme}, ${accent}: the reader's matches and the folder search's marks in the same tints`, async () => {
      const page = await open(
        html(
          theme,
          accent,
          `<style>${FILES_CSS}</style>`,
          `<p id="text" style="font:24px/36px sans-serif;padding:8px">xxxx and xxxx</p>
<div class="files-found-row"><mark id="found">gale</mark></div><i id="probe-find" style="background:var(--find-bg)">probe</i>
<script>
const t = document.getElementById('text').firstChild
const at = (a) => { const r = document.createRange(); r.setStart(t, a); r.setEnd(t, a + 4); return r }
CSS.highlights.set('reader-find', new Highlight(at(0)))
CSS.highlights.set('reader-find-current', new Highlight(at(9)))
</script>`,
        ),
      )
      const spots = await page.evaluate(() =>
        ['reader-find', 'reader-find-current'].map((n) => {
          const b = ([...(CSS as any).highlights.get(n)][0] as Range).getBoundingClientRect()
          return { x: b.left + b.width / 2, y: b.top + 3 }
        }),
      )
      const [m, s] = SHARE[theme][accent]
      const match = await pixel(page, spots[0].x, spots[0].y)
      const current = await pixel(page, spots[1].x, spots[1].y)
      assert.ok(near(match, over(FILL[accent], m, CELL[theme])), `the match's tint: ${match}`)
      assert.ok(near(current, over(FILL[accent], s, CELL[theme])), `the current match's tint: ${current}`)
      const marks = await page.evaluate(() => ['#found', '#probe-find'].map((s) => getComputedStyle(document.querySelector(s)!).backgroundColor))
      assert.equal(marks[0], marks[1])
      await page.close()
    })
  }
})

test('on every paper and accent, the text reads on the tints, each tint stands apart, and a tick reads on the cell', async () => {
  const page = await open(html('light', 'iris', '', '<i id="probe">probe</i>'))
  const bad: string[] = []
  for (const paper of ['warm', 'neutral', 'dark']) {
    for (const accent of ['iris', 'pink', 'orange', 'yellow', 'lime', 'blue', 'graphite']) {
      const c = await page.evaluate(
        ([paper, accent]) => {
          const root = document.documentElement
          if (paper === 'warm') root.removeAttribute('data-paper')
          else root.setAttribute('data-paper', paper)
          root.setAttribute('data-accent', accent)
          const probe = document.getElementById('probe')!
          const cv = document.createElement('canvas')
          cv.width = cv.height = 1
          const g = cv.getContext('2d')!
          // a token's color drawn over a ground (one of the cell's), as the page composites it
          const draw = (token: string, ground?: number[]) => {
            probe.style.color = `var(${token})`
            g.clearRect(0, 0, 1, 1)
            if (ground) {
              g.fillStyle = `rgb(${ground.join(',')})`
              g.fillRect(0, 0, 1, 1)
            }
            g.fillStyle = getComputedStyle(probe).color
            g.fillRect(0, 0, 1, 1)
            return Array.from(g.getImageData(0, 0, 1, 1).data)
          }
          const out: Record<string, number[]> = {}
          for (const ground of ['--surface-card', '--bg-panel']) {
            const bg = draw(ground)
            out[ground] = bg
            out[ground + ' match'] = draw('--find-bg', bg)
            out[ground + ' current'] = draw('--find-bg-strong', bg)
          }
          for (const t of ['--text-primary', '--text-secondary', '--text-accent']) out[t] = draw(t)
          return out
        },
        [paper, accent] as const,
      )
      for (const ground of ['--surface-card', '--bg-panel']) {
        const at = `${paper} ${accent} on ${ground}`
        const cur = c[ground + ' current']
        const match = c[ground + ' match']
        for (const t of ['--text-primary', '--text-secondary']) if (contrast(c[t], cur) < 4.5) bad.push(`${at}: ${t} on the current match ${contrast(c[t], cur).toFixed(2)}`)
        if (apart(match, c[ground]) < 16) bad.push(`${at}: the match's tint ${match} too near the ground ${c[ground]}`)
        if (apart(cur, match) < 12) bad.push(`${at}: the current match's tint ${cur} too near the match's ${match}`)
        // as far as on iris, whose match is 11.8 from Warm's cell and its current match 7.2 from a match
        if (dE(match, c[ground]) < 10) bad.push(`${at}: the match's tint ${match} only ${dE(match, c[ground]).toFixed(1)} from the ground ${c[ground]}`)
        if (dE(cur, match) < 6) bad.push(`${at}: the current match's tint ${cur} only ${dE(cur, match).toFixed(1)} from the match's ${match}`)
      }
      if (contrast(c['--text-accent'], c['--surface-card']) < 3) bad.push(`${paper} ${accent}: a tick on the cell ${contrast(c['--text-accent'], c['--surface-card']).toFixed(2)}`)
    }
  }
  assert.deepEqual(bad, [])
  await page.close()
})
