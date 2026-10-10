// The view kit's row controls, side panel and lanes (backend/app/viewer_controls.js, viewer_side.js) in a real browser,
// a page holding the view in a sandboxed frame as ViewerFrame does: Filter by's toggle hides the rows of its value;
// Rows regroups the lanes by a field, a tree of them with its guides, and by a label, a class added to the label being a
// new lane; hovering a lane draws a thin cursor line, never a band over the marks; the detail list's rows in view are a
// tint across the lanes that follows the list as it scrolls; a record opens in a side panel beside the list that starts
// wide enough to read it, a drag of its edge resizes it, and the page built again opens it at that width; the divider's
// drag gives the overview its height, kept too; a failure in the lanes is a ✕ in the problem red that stands out from
// the marks and the paper, light and dark. What the controls decide without layout is tests/public/controls-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_range.js'].map((n) => `<script>${inline(read(n))}</script>`).join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--text-placeholder:#a09c93;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-sm:13px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--border-hairline:rgba(27,26,24,0.08);--border-strong:rgba(27,26,24,0.3);--status-negative:#c93a28;--surface-selected:rgba(27,26,24,0.06);--font-body:sans-serif;--font-mono:monospace}'
const T0 = Date.UTC(2026, 4, 16, 9) / 1000

// a lead and its subagents, forty calls each, every seventh failed, in a list that scrolls under the lanes
const view = (kept?: unknown) => `<!doctype html><html><head><style>${TOKENS} html,body{margin:0;height:100%} body{font:12px sans-serif;background:#fffdf8;overflow:hidden}
#view{height:100%;display:flex;flex-direction:column} .top{flex:none;display:flex;align-items:center;gap:8px;padding:8px}
#overview{flex:none;height:180px;display:flex;flex-direction:column;min-height:0} #range{flex:none;margin-left:160px} #lanes{flex:1;min-height:0;overflow:auto}
#body{flex:1;min-height:0} #list{overflow:auto} .row{box-sizing:border-box;height:24px;padding:4px 8px}</style>
${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${KIT}</head><body>
<div id="view"><div class="top"><span id="filter"></span><span id="rows"></span><span id="colour"></span></div>
<div id="overview"><div id="range"></div><div id="lanes"></div></div><div id="body"><div id="list"></div></div></div>
<script>
const PARENT = { lead: null, explore: 'lead', grep: 'explore', test: 'lead' }
const tools = ['Bash', 'Read', 'Grep']
const calls = []
Object.keys(PARENT).forEach((s, si) => { for (let i = 0; i < 40; i++) calls.push({ ref: 'r1/' + s + '.jsonl#L' + (i + 1), t: ${T0} + si * 600 + i * 60, session: s, tool: tools[i % 3], outcome: i % 7 === 3 ? 'error' : 'ok' }) })
calls.sort((a, b) => a.t - b.t)
window.calls = calls
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }], onChange: draw })
window.filter = thimble.filterBy({ mount: '#filter', fields: [{ name: 'outcome', title: 'Outcome', values: ['ok', 'error'] }], onChange: draw })
window.range = thimble.timeRange({ mount: '#range', times: calls.map((c) => c.t), onChange: draw })
window.rows = thimble.rows({ mount: '#rows', fields: [{ name: 'session', title: 'Session', parentOf: (k) => PARENT[k] }, { name: 'tool', title: 'Tool' }], onChange: draw })
window.lanes = thimble.lanes({ mount: '#lanes', rows, range, names: 160, problem: (c) => c.outcome !== 'ok', follow: '#list', onMark: (c) => openCall(c) })
window.side = thimble.side({ mount: '#body' })
window.divider = thimble.divider({ top: '#overview' })
function draw() {
  const shown = calls.filter((c) => range.has(c.t) && filter.keeps(c))
  lanes.draw(shown)
  document.getElementById('list').innerHTML = shown.map((c) => '<div class="row" data-anchor="' + c.ref + '" data-t="' + c.t + '"' + colour.attr(c) + '>' + c.session + ' ' + c.tool + ' ' + c.outcome + '</div>').join('')
}
function openCall(c) { side.open({ title: c.tool + ' · ' + c.session, sub: c.ref, ref: c.ref, html: '<pre>' + JSON.stringify(c, null, 2) + '</pre>' }) }
document.getElementById('list').addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) openCall(calls.find((c) => c.ref === r.dataset.anchor)) })
draw()
</script></body></html>`

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page holding the view in a sandboxed frame 900 px wide; what the view asks thimble to keep is window.__kept. */
async function framed(kept?: unknown): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:900px;height:640px"></iframe></body></html>`)
  await page.evaluate(() => {
    const w = window as unknown as { __kept: unknown[] }
    w.__kept = []
    window.addEventListener('message', (e) => e.data && e.data.type === 'thimble:colour' && w.__kept.push(e.data.state))
  })
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view(kept))
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-lane', { state: 'attached' })
  return { page, frame }
}
const lastKept = (page: Page) => page.evaluate(() => (window as unknown as { __kept: any[] }).__kept.at(-1))
const laneNames = (frame: () => Frame) => frame().evaluate(() => [...document.querySelectorAll('.thimble-lane-nm')].map((e) => e.textContent))
const labels = (page: Page, values: string[], marks: Record<string, string>) =>
  page.evaluate(
    ([values, marks]) => {
      const vs = (values as string[]).map((v) => ({ name: v, colour: '#025ac3', highlight: true }))
      const m: Record<string, object> = {}
      for (const [ref, v] of Object.entries(marks as Record<string, string>)) m[ref] = { bar: '#025ac3', names: ['Tactic'], values: [{ id: 'k1', label: 'Tactic', value: v, colour: '#025ac3' }], spans: [] }
      ;(document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(
        { type: 'thimble:labels', marks: m, on: [{ id: 'k1', name: 'Tactic', colour: '#025ac3', values: vs }], filter: null, all: [{ id: 'k1', name: 'Tactic', on: true, here: true, colour: '#025ac3', values: vs, count: 2 }], palette: ['#025ac3'] },
        '*',
      )
    },
    [values, marks] as const,
  )

// the lanes of three sessions in the theme's own tokens, light or dark, their marks in Color by's colours, every fifth
// call failed
const THEME = readFileSync(path.join(FRONTEND, 'src', 'styles', 'tokens.css'), 'utf8') + ':root{--font-body:sans-serif;--font-mono:monospace}'
const failures = (dark: boolean) => `<!doctype html><html${dark ? ' data-paper="dark"' : ''}><head><style>${THEME} html,body{margin:0} body{background:var(--surface-card)}
#lanes{width:860px;padding:8px}</style>${KIT}</head><body><span id="colour"></span><div id="lanes"></div>
<script>
const calls = []
;['lead', 'explore', 'test'].forEach((s, si) => { for (let i = 0; i < 30; i++) calls.push({ ref: 'r1/' + s + '.jsonl#L' + (i + 1), t: ${T0} + si * 40 + i * 120, session: s, tool: ['Bash', 'Read', 'Grep', 'Edit'][i % 4], outcome: i % 5 === 2 ? 'error' : 'ok' }) })
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }] })
window.lanes = thimble.timeline({ mount: '#lanes', rows: 'session', problem: (c) => c.outcome !== 'ok' })
lanes.draw(calls)
</script></body></html>`

describe('a failure in the lanes', () => {
  for (const dark of [false, true]) {
    test(`a ✕ in the problem red at its mark's foot, over a halo of the paper, easy to see beside the marks' colours (${dark ? 'dark' : 'light'})`, async () => {
      const page = await browser.newPage({ viewport: { width: 900, height: 300 } })
      await page.setContent(failures(dark))
      await page.waitForSelector('.thimble-lane-bad', { state: 'attached' })
      const got = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.cssText = 'color:var(--status-negative);background:var(--surface-card)'
        document.body.appendChild(probe)
        const want = getComputedStyle(probe)
        const bads = [...document.querySelectorAll('.thimble-lane-bad')]
        const x = getComputedStyle(bads[0].querySelector('.thimble-lane-bad-x')!)
        const halo = getComputedStyle(bads[0].querySelector('.thimble-lane-bad-halo')!)
        const r = bads[0].getBoundingClientRect()
        return { n: bads.length, red: want.color, paper: want.backgroundColor, stroke: x.stroke, width: parseFloat(x.strokeWidth), halo: halo.stroke, box: { x: r.x, y: r.y, w: r.width, h: r.height } }
      })
      // one ✕ for each failed call, six of thirty in each of three lanes
      assert.equal(got.n, 18)
      assert.equal(got.stroke, got.red)
      assert.equal(got.halo, got.paper)
      assert.ok(got.width >= 1.5 && got.box.w >= 6 && got.box.h >= 6, `a ✕ big enough to see (${JSON.stringify(got)})`)
      // in a picture of the page, the ✕'s red stands out: many of its pixels in the problem red, which keeps 3:1 or more
      // against the paper
      const png = await page.screenshot({ clip: { x: Math.floor(got.box.x) - 1, y: Math.floor(got.box.y) - 1, width: Math.ceil(got.box.w) + 2, height: Math.ceil(got.box.h) + 2 } })
      const seen = await page.evaluate(
        async ([b64, red, paper]) => {
          const rgb = (c: string) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
          const lum = ([r, g, b]: number[]) => {
            const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
          }
          const [a, b] = [lum(rgb(red)), lum(rgb(paper))]
          const img = new Image()
          img.src = 'data:image/png;base64,' + b64
          await img.decode()
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const g = c.getContext('2d')!
          g.drawImage(img, 0, 0)
          const d = g.getImageData(0, 0, img.width, img.height).data
          const want = rgb(red)
          let near = 0
          for (let i = 0; i < d.length; i += 4) if (Math.hypot(d[i] - want[0], d[i + 1] - want[1], d[i + 2] - want[2]) < 70) near++
          return { near, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
        },
        [png.toString('base64'), got.red, got.paper] as const,
      )
      assert.ok(seen.near >= 12, `the ✕ draws its red (${JSON.stringify(seen)})`)
      assert.ok(seen.contrast >= 3, `the problem red keeps 3:1 against the paper (${JSON.stringify(seen)})`)
      await page.close()
    })
  }
})

describe('the row controls in a frame', () => {
  test("Filter by's menu picks a field and a toggle hides its value's rows from the list and the lanes", async () => {
    const { page, frame } = await framed()
    const rows = () => frame().evaluate(() => document.querySelectorAll('.row').length)
    assert.equal(await rows(), 160)
    await frame().locator('.thimble-filter-by').click()
    await frame().locator('.thimble-colour-menu [data-by="f:outcome"]').click()
    await page.waitForTimeout(100)
    const chips = await frame().evaluate(() => [...document.querySelectorAll('.thimble-filter-chip')].map((c) => c.textContent))
    assert.deepEqual(chips, ['ok136', 'error24'])
    await frame().locator('.thimble-filter-chip', { hasText: 'error' }).click()
    await page.waitForTimeout(100)
    assert.equal(await rows(), 136)
    assert.equal(await frame().evaluate(() => document.querySelectorAll('.thimble-lane-bad').length), 0, 'the lanes lose the failed calls too')
    assert.deepEqual((await lastKept(page)).parts.filter, { by: 'f:outcome', off: { 'f:outcome': ['error'] } })
    await page.close()
  })

  test('Rows regroups the lanes by a field and by a label; a class added to the label is a new lane, with no click', async () => {
    const { page, frame } = await framed()
    assert.deepEqual(await laneNames(frame), ['lead', 'explore', 'grep', 'test'])
    // the tree's guides: drawn lines left-aligned, a cell a level, the child's guide reaching to its row's middle
    const guides = await frame().evaluate(() => [...document.querySelectorAll('.thimble-lane')].map((l) => [...l.querySelectorAll('.thimble-lane-guide')].map((g) => g.className.replace('thimble-lane-guide thimble-lane-g-', ''))))
    assert.deepEqual(guides, [[], ['tee'], ['pipe', 'elbow'], ['elbow']])
    const lefts = await frame().evaluate(() => [...document.querySelectorAll('.thimble-lane-name')].map((n) => Math.round(n.getBoundingClientRect().left)))
    assert.equal(new Set(lefts).size, 1, 'every name column starts on one edge')
    // by the tool
    await frame().locator('.thimble-rows-by').click()
    await frame().locator('.thimble-colour-menu [data-by="f:tool"]').click()
    await page.waitForTimeout(100)
    assert.deepEqual(await laneNames(frame), ['Bash', 'Read', 'Grep'])
    // by a label: its classes, then the calls it does not mark
    await labels(page, ['explore', 'verify'], { 'r1/lead.jsonl#L1': 'explore', 'r1/test.jsonl#L5': 'verify' })
    await page.waitForTimeout(100)
    await frame().locator('.thimble-rows-by').click()
    await frame().locator('.thimble-colour-menu [data-by="l:k1"]').click()
    await page.waitForTimeout(150)
    assert.deepEqual(await laneNames(frame), ['explore', 'verify', 'Not marked'])
    await labels(page, ['explore', 'verify', 'plan'], { 'r1/lead.jsonl#L1': 'explore', 'r1/test.jsonl#L5': 'verify', 'r1/grep.jsonl#L2': 'plan' })
    await page.waitForTimeout(150)
    assert.deepEqual(await laneNames(frame), ['explore', 'verify', 'plan', 'Not marked'])
    await page.close()
  })

  test('hovering a lane draws a thin cursor line across the lanes, never a band; the list\'s rows in view are a tint that follows its scroll', async () => {
    const { page, frame } = await framed()
    const lane = (await frame().locator('.thimble-lane-track').nth(1).boundingBox())!
    await page.mouse.move(lane.x + lane.width / 2, lane.y + 9)
    await page.waitForTimeout(100)
    const cur = await frame().evaluate(() => {
      const c = document.querySelector('.thimble-lanes-cursor') as HTMLElement
      const r = c.getBoundingClientRect()
      const body = document.querySelector('.thimble-lanes-body')!.getBoundingClientRect()
      return { display: getComputedStyle(c).display, width: r.width, height: Math.round(r.height), bodyHeight: Math.round(body.height), tip: (document.querySelector('.thimble-tip') as HTMLElement)?.textContent ?? '' }
    })
    assert.equal(cur.display, 'block')
    assert.equal(cur.width, 1, 'a 1 px line')
    assert.ok(cur.height >= cur.bodyHeight - 1, `it crosses every lane: ${JSON.stringify(cur)}`)
    assert.match(cur.tip, /^explore · /)
    // no element over the marks is filled or inverted
    const filled = await frame().evaluate(() => [...document.querySelectorAll('.thimble-lanes-body *')].filter((e) => getComputedStyle(e).mixBlendMode !== 'normal' || /invert/.test(getComputedStyle(e).filter)).length)
    assert.equal(filled, 0)
    // the tint: where the list's rows in view lie, moving right as the list scrolls
    const tint = () => frame().evaluate(() => { const s = document.querySelector('.thimble-lanes-span') as HTMLElement; return { display: getComputedStyle(s).display, left: s.getBoundingClientRect().left, width: s.getBoundingClientRect().width } })
    const t0 = await tint()
    assert.equal(t0.display, 'block')
    await frame().evaluate(() => (document.getElementById('list')!.scrollTop = 2000))
    await page.waitForTimeout(150)
    const t1 = await tint()
    assert.ok(t1.left > t0.left + 20, `the tint follows the list: ${JSON.stringify([t0, t1])}`)
    await page.close()
  })
})

describe('the side panel and the divider in a frame', () => {
  test('a record opens beside the list, wide enough to read it; a drag of its edge resizes it; the page built again opens it at that width', async () => {
    const { page, frame } = await framed()
    await frame().locator('.row').nth(2).click()
    await page.waitForTimeout(100)
    const open = await frame().evaluate(() => {
      const s = document.querySelector('.thimble-side') as HTMLElement
      const list = document.getElementById('list')!
      return { width: Math.round(s.getBoundingClientRect().width), body: Math.round(document.getElementById('body')!.getBoundingClientRect().width), list: Math.round(list.getBoundingClientRect().width), title: s.querySelector('.thimble-side-title')!.textContent, under: list.querySelector('.thimble-side') !== null }
    })
    assert.ok(Math.abs(open.width - open.body * 0.4) <= 2, `it opens at two fifths of the view: ${JSON.stringify(open)}`)
    assert.ok(open.list <= open.body - open.width + 1, 'the list narrows beside it')
    assert.equal(open.under, false)
    assert.match(open.title!, /· lead$/)
    // drag its left edge 150 px to the left
    const grip = (await frame().locator('.thimble-side-grip').boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 100)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2 - 150, grip.y + 100, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    const wide = await frame().evaluate(() => Math.round(document.querySelector('.thimble-side')!.getBoundingClientRect().width))
    assert.ok(Math.abs(wide - (open.width + 150)) <= 3, `${wide}`)
    const kept = await lastKept(page)
    assert.ok(Math.abs(kept.parts['side:body'].share - wide / open.body) < 0.01, JSON.stringify(kept.parts))
    await page.close()
    // built again on what thimble kept, it opens at that width
    const again = await framed(kept)
    await again.frame().locator('.row').nth(5).click()
    await again.page.waitForTimeout(100)
    const w2 = await again.frame().evaluate(() => Math.round(document.querySelector('.thimble-side')!.getBoundingClientRect().width))
    assert.ok(Math.abs(w2 - wide) <= 3, `${w2} ${wide}`)
    await again.page.close()
  })

  test("the divider's drag gives the overview its height, which the page built again keeps", async () => {
    const { page, frame } = await framed()
    const h0 = await frame().evaluate(() => Math.round(document.getElementById('overview')!.getBoundingClientRect().height))
    const bar = (await frame().locator('.thimble-divider').boundingBox())!
    await page.mouse.move(bar.x + 200, bar.y + bar.height / 2)
    await page.mouse.down()
    await page.mouse.move(bar.x + 200, bar.y + bar.height / 2 + 120, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    const h1 = await frame().evaluate(() => Math.round(document.getElementById('overview')!.getBoundingClientRect().height))
    assert.ok(Math.abs(h1 - (h0 + 120)) <= 3, `${h0} ${h1}`)
    const kept = await lastKept(page)
    assert.ok(kept.parts['divider:overview'].share > 0.3, JSON.stringify(kept.parts))
    await page.close()
    const again = await framed(kept)
    await again.page.waitForTimeout(100)
    const h2 = await again.frame().evaluate(() => Math.round(document.getElementById('overview')!.getBoundingClientRect().height))
    assert.ok(Math.abs(h2 - h1) <= 3, `${h1} ${h2}`)
    await again.page.close()
  })
})

// the timeline with no other part of the kit: one lane of commits with no name (#alone), a lane per author (#authors)
// and a lane per agent on plain numbers, its turns (#turns), each on its records' own span with an axis of its own
const alone = () => `<!doctype html><html><head><style>${TOKENS} html,body{margin:0} body{font:12px sans-serif;background:#fffdf8;padding:12px}
section{margin-bottom:16px}</style>${KIT}</head><body>
<section id="alone"></section><section id="authors"></section><section id="turns"></section>
<script>
const authors = ['ana', 'bo', 'cy']
const commits = Array.from({ length: 31 }, (_, i) => ({ t: new Date((${T0} + i * 120) * 1000).toISOString(), author: authors[i % 3], text: 'commit ' + i }))
window.a = thimble.timeline({ mount: '#alone' })
a.draw(commits)
window.b = thimble.timeline({ mount: '#authors', rows: 'author' })
b.draw(commits)
window.c = thimble.timeline({ mount: '#turns', rows: (s) => s.agent, unit: 'n', time: (s) => s.turn })
c.draw(Array.from({ length: 40 }, (_, i) => ({ turn: i, agent: i % 4 ? 'lead' : 'sub' })))
</script></body></html>`

describe('the timeline alone in a frame', () => {
  test("its own axis stands over its tracks, a label over the moment it names; with no lanes to tell apart the track takes the whole width; nothing runs past the frame", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:900px;height:640px"></iframe></body></html>`)
    await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), alone())
    const frame = () => page.frames().find((f) => f !== page.mainFrame())!
    await page.waitForTimeout(300)
    await frame().waitForSelector('#turns .thimble-axis-lab', { state: 'attached' })
    const got = await frame().evaluate(() => {
      const box = (e: Element) => e.getBoundingClientRect()
      const mid = (e: Element) => (box(e).left + box(e).right) / 2
      const lab = [...document.querySelectorAll('#alone .thimble-axis-lab')].find((l) => l.textContent === '09:30')!
      // commit 15, at 09:30, is the 16th mark
      const mark = document.querySelectorAll('#alone .thimble-lane-mark')[15]
      const track = (id: string) => box(document.querySelector('#' + id + ' .thimble-lane-track')!)
      return {
        lab: mid(lab),
        mark: mid(mark),
        alone: [track('alone').left, track('alone').right, box(document.getElementById('alone')!).left, box(document.getElementById('alone')!).right],
        authors: [track('authors').left, box(document.querySelector('#authors .thimble-lanes-axis')!).left, box(document.querySelector('#authors .thimble-lanes-axis')!).width, track('authors').width],
        names: [...document.querySelectorAll('#authors .thimble-lane-nm')].map((n) => n.textContent),
        turns: [...document.querySelectorAll('#turns .thimble-axis-lab')].map((l) => l.textContent),
        wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    assert.ok(Math.abs(got.lab - got.mark) <= 2, `the label 09:30 over its commit: ${JSON.stringify(got)}`)
    assert.ok(Math.abs(got.alone[0] - got.alone[2]) <= 1 && Math.abs(got.alone[1] - got.alone[3]) <= 1, `the track as wide as its mount: ${got.alone}`)
    assert.ok(Math.abs(got.authors[0] - got.authors[1]) <= 1 && Math.abs(got.authors[2] - got.authors[3]) <= 1, `the axis over the tracks, past the names: ${got.authors}`)
    assert.deepEqual(got.names, ['ana', 'bo', 'cy'])
    assert.ok(got.turns.length > 2 && got.turns.every((l) => /^\d+$/.test(l!)), `turns on the axis: ${got.turns}`)
    assert.equal(got.wide, 0)
    await page.close()
  })
})

// timelines with no range: runs by author, some failed, so the key shows (#runs); a lane per agent whose first name is
// too long to show whole (#long)
const fitted = () => `<!doctype html><html><head><style>${TOKENS} html,body{margin:0} body{font:12px sans-serif;background:#fffdf8;padding:12px}
section{margin-bottom:16px}</style>${KIT}</head><body>
<section id="runs"></section><section id="long"></section>
<script>
const authors = ['ana', 'bo', 'cy']
window.runs = thimble.timeline({ mount: '#runs', rows: 'author', problem: (r) => r.failed })
runs.draw(Array.from({ length: 30 }, (_, i) => ({ t: ${T0} + i * 120, author: authors[i % 3], failed: i % 7 === 3 })))
window.long = thimble.timeline({ mount: '#long', rows: 'agent' })
long.draw(Array.from({ length: 30 }, (_, i) => ({ t: ${T0} + i * 120, agent: i % 2 ? 'sub' : 'a-lead-agent-whose-name-runs-on-past-any-column-of-names' })))
</script></body></html>`

describe('a timeline with no range fits its names', () => {
  test("the names' column as wide as the longest name, at most 200 px and a third of the width; a key with no room beside the axis stands under it, from the tracks' left edge", async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:900px;height:640px"></iframe></body></html>`)
    const frame = () => page.frames().find((f) => f !== page.mainFrame())!
    const measure = () =>
      frame().evaluate(() => {
        const box = (s: string) => document.querySelector(s)!.getBoundingClientRect()
        const nm = [...document.querySelectorAll('#runs .thimble-lane-nm')].map((n) => n.getBoundingClientRect().right)
        return {
          runs: { track: box('#runs .thimble-lane-track').left, mount: box('#runs').left, widest: Math.max(...nm), axis: box('#runs .thimble-lanes-axis'), key: box('#runs .thimble-lanes-key') },
          long: { track: box('#long .thimble-lane-track').left, mount: box('#long').left, width: box('#long').width, clipped: [...document.querySelectorAll('#long .thimble-lane-nm')].map((n) => n.scrollWidth > n.clientWidth) },
          wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }
      })
    await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), fitted())
    await page.waitForTimeout(300)
    await frame().waitForSelector('#long .thimble-lane-track', { state: 'attached' })
    let got = await measure()
    // three short names: a column just past the widest of them, far under 200 px
    assert.ok(got.runs.track - got.runs.mount < 70 && got.runs.track >= got.runs.widest, `the column fits ana, bo and cy: ${JSON.stringify(got.runs)}`)
    // the key, too wide for that column, under the axis and lined up with the tracks
    assert.ok(got.runs.key.top >= got.runs.axis.bottom - 1 && Math.abs(got.runs.key.left - got.runs.track) <= 1, `the key under the axis: ${JSON.stringify(got.runs)}`)
    // a name too long for 200 px: the column stops there, the name cut short
    assert.equal(Math.round(got.long.track - got.long.mount), 200)
    assert.deepEqual(got.long.clipped, [true, false])
    assert.equal(got.wide, 0)
    // in a narrow frame the column takes a third of the width at most, so the tracks keep the rest
    await page.evaluate(() => ((document.getElementById('f') as HTMLIFrameElement).style.width = '360px'))
    await page.waitForTimeout(300)
    got = await measure()
    assert.ok(got.long.track - got.long.mount <= got.long.width / 3 + 1, `a third at most: ${JSON.stringify(got.long)}`)
    assert.equal(got.wide, 0)
    await page.close()
  })
})
