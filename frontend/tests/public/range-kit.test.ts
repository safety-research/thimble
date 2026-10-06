// The view kit's time range selector (backend/app/viewer_range.js, thimble.timeRange) and the scale and axis it gives a
// view's chart, in a jsdom window of their own with the bridge and Color by: it opens on the whole span, a range set is
// kept per view with the Color by choice (the bridge's `colour` message) and the page built again starts on it, Reset
// in Color by's row brings back the whole span, and the scale lays the range out with the overview's breaks. Dragging
// the viewfinder, its edges, the wheel and the overview's colours are tests/public/browser/view-range.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const APP = path.resolve(__dirname, '../../../backend/app')
const read = (n: string) => readFileSync(path.join(APP, n), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
const KIT = script(read('viewer_bridge.js')) + script(read('viewer_colour.js')) + script(read('viewer_range.js'))

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any }
const doc = () => dom.window.document
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)

const H = 3600
const T0 = Date.UTC(2026, 5, 16) / 1000
// two bursts of records two days apart: 16 Jun 00:00 to 06:00, and 18 Jun 06:00 to 08:00
const TIMES = [...Array.from({ length: 61 }, (_, i) => T0 + i * 360), ...Array.from({ length: 21 }, (_, i) => T0 + 54 * H + i * 360)]

async function load(kept?: object) {
  const page = `<!doctype html><html><head>${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${KIT}</head><body><div class="top"><span id="colour"></span></div><div id="range"></div><div id="list"></div></body></html>`
  dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  sent = []
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  // jsdom lays nothing out: the overview is 600 px wide
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 })
  await wait()
}
afterEach(() => dom?.window.close())

const mount = (opts: object = {}) => {
  win().thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })
  return win().thimble.timeRange({ mount: '#range', times: TIMES, ...opts })
}

describe('the time range selector', () => {
  test('opens on the whole span, with its start, end and length in the readout', async () => {
    await load()
    const r = mount()
    await wait()
    expect(r.full).toBe(true)
    expect(r.from).toBeLessThanOrEqual(TIMES[0])
    expect(r.to).toBeGreaterThanOrEqual(TIMES.at(-1)!)
    expect(r.has(TIMES[0]) && r.has(TIMES.at(-1)!)).toBe(true)
    expect(doc().querySelector('.thimble-range-dates')!.textContent).toBe('16 Jun 00:00 – 18 Jun 08:00')
    expect(doc().querySelector('.thimble-range-len')!.textContent).toBe('2d 8h')
    expect(doc().querySelector('.thimble-range-win')!.getAttribute('aria-valuetext')).toBe('16 Jun 00:00 – 18 Jun 08:00')
  })

  test('a range set is drawn, told once to the page and kept per view; the page built again starts on it', async () => {
    await load()
    let told = 0
    const r = mount({ onChange: () => told++ })
    r.set(T0 + H, T0 + 3 * H)
    await wait()
    expect([r.full, r.from, r.to, told]).toEqual([false, T0 + H, T0 + 3 * H, 1])
    expect(r.has(T0 + 2 * H) && !r.has(T0 + 4 * H)).toBe(true)
    expect(doc().querySelector('.thimble-range-dates')!.textContent).toBe('16 Jun 01:00 – 03:00')
    const kept = of('colour').at(-1)!.state as { range: Record<string, number[]> }
    expect(kept.range).toEqual({ time: [T0 + H, T0 + 3 * H] })
    await load(kept)
    const again = mount()
    await wait()
    expect([again.full, again.from, again.to]).toEqual([false, T0 + H, T0 + 3 * H])
    // set(null) shows the whole span, and the kept range goes
    again.set(null)
    await wait()
    expect(again.full).toBe(true)
    expect((of('colour').at(-1)!.state as { range: object }).range).toEqual({})
  })

  test("Reset in Color by's row shows while the range is zoomed in and brings back the whole span", async () => {
    await load()
    let told = 0
    const r = mount({ onChange: () => told++ })
    await wait()
    const reset = () => doc().querySelector<HTMLButtonElement>('.thimble-reset')!
    expect(reset().hidden).toBe(true)
    r.set(T0 + H, T0 + 2 * H)
    await wait()
    expect(reset().hidden).toBe(false)
    told = 0
    reset().click()
    await wait()
    expect([r.full, told, reset().hidden]).toEqual([true, 1, true])
  })

  test('the scale of the range lays its time across a chart, a long empty stretch as a narrow break', async () => {
    await load()
    const r = mount({ gap: 6 * H })
    await wait()
    const s = r.scale(600)
    expect(s.broken).toBe(true)
    const gaps = s.gaps()
    expect(gaps).toHaveLength(1)
    expect(gaps[0][1] - gaps[0][0]).toBe(10)
    // the two bursts share the chart in proportion to their lengths, six hours and two
    const end1 = s.x(TIMES[60])
    const start2 = s.x(TIMES[61])
    expect(start2 - end1).toBeGreaterThanOrEqual(10)
    expect(end1 / (600 - start2)).toBeGreaterThan(2.5)
    for (const t of [TIMES[0], TIMES[30], TIMES[70]]) expect(Math.abs(s.t(s.x(t)) - t)).toBeLessThan(1)
    // ticks every hour or so, none in the break, labelled as times of day
    const ticks = s.ticks(60)
    expect(ticks.length).toBeGreaterThan(3)
    expect(ticks.every((k: { x: number }) => k.x <= gaps[0][0] || k.x >= gaps[0][1])).toBe(true)
    expect(ticks.filter((k: { label: string }) => k.label).every((k: { label: string }) => /^\d\d:\d\d$|^\d+ Jun$/.test(k.label))).toBe(true)
    // bins of a chart at least 3 px wide, aligned to the clock
    const bins = s.bins(3)
    expect(bins[0][0] % s.step(3)).toBe(0)
    expect(s.binOf(TIMES[0])).toBeGreaterThanOrEqual(0)
    // an edge set in the break moves to the data beside it
    r.set(T0 + 24 * H, T0 + 60 * H)
    expect(r.from).toBe(TIMES[61])
    r.set(T0 + H, T0 + 24 * H)
    expect(r.to).toBe(TIMES[60])
    // the range zoomed into the first burst: no break in it
    r.set(T0, T0 + 6 * H)
    expect(r.scale(600).broken).toBe(false)
  })

  test("thimble.timeAxis draws the chart's one axis and its point events as labelled flags", async () => {
    await load()
    const r = mount()
    await wait()
    doc().body.insertAdjacentHTML('beforeend', '<div id="ax"></div>')
    let hovered: unknown = 'none'
    win().thimble.timeAxis('#ax', r.scale(600), { marks: [{ t: T0 + 3 * H, label: 'context compaction' }], onMark: (m: unknown) => (hovered = m) })
    const ax = doc().getElementById('ax')!
    expect(ax.querySelectorAll('.thimble-axis-lab').length).toBeGreaterThan(2)
    const flag = ax.querySelector('.thimble-axis-flag')!
    expect(flag.textContent).toBe('context compaction')
    flag.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }))
    expect(hovered).toEqual({ t: T0 + 3 * H, label: 'context compaction' })
    ax.dispatchEvent(new dom.window.Event('pointerleave'))
    expect(hovered).toBeNull()
  })

  test('a long range reads in months and years', async () => {
    await load()
    win().thimble.colorBy({ mount: '#colour', fields: [] })
    const r = win().thimble.timeRange({ mount: '#range', span: [Date.UTC(2023, 8, 22) / 1000, Date.UTC(2026, 8, 20) / 1000] })
    await wait()
    expect(doc().querySelector('.thimble-range-len')!.textContent).toBe('2y 11mo')
    r.set(Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 3, 12) / 1000)
    await wait()
    expect(doc().querySelector('.thimble-range-len')!.textContent).toBe('3mo 10d')
  })

  test('a span the page gives is the whole range the readout gives, beyond the records', async () => {
    await load()
    const r = mount()
    r.data({ times: TIMES, span: [T0, T0 + 4 * 24 * H] })
    await wait()
    expect(doc().querySelector('.thimble-range-dates')!.textContent).toBe('16 Jun – 19 Jun')
    expect(r.span).toEqual([T0, T0 + 4 * 24 * H])
  })

  test('plain numbers, such as turns, read as numbers', async () => {
    await load()
    win().thimble.colorBy({ mount: '#colour', fields: [] })
    const r = win().thimble.timeRange({ mount: '#range', unit: 'n', span: [0, 400] })
    r.set(100, 250)
    await wait()
    expect(doc().querySelector('.thimble-range-dates')!.textContent).toBe('100 – 250')
    expect(doc().querySelector('.thimble-range-len')!.textContent).toBe('150')
  })
})
