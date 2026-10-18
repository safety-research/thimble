// The view kit's time range selector (backend/app/viewer_range.js, thimble.timeRange), in a jsdom window of its own with
// the bridge and Color by: it opens on the whole span, and a range set is told once to the page and kept per view with
// the Color by choice (the bridge's `colour` message), so the page built again starts on it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const APP = path.resolve(__dirname, '../../../backend/app')
const read = (n: string) => readFileSync(path.join(APP, n), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
// the kit as views.frame_document loads it: the bridge, the order new values take the palette in, Color by and the range
const KIT = script(read('viewer_bridge.js')) + script(`window.__thimbleLabelOrder = ${read('label_order.json')}`) + script(read('viewer_colour.js')) + script(read('viewer_range.js'))

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any }
const doc = () => dom.window.document
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)

const H = 3600
const T0 = Date.UTC(2026, 5, 16) / 1000
// two bursts of records two days apart: Jun 16 00:00 to 06:00, and Jun 18 06:00 to 08:00
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
    expect(doc().querySelector('.thimble-range-dates')!.textContent).toBe('Jun 16 00:00 – Jun 18 08:00')
    expect(doc().querySelector('.thimble-range-len')!.textContent).toBe('2d 8h')
    expect(doc().querySelector('.thimble-range-win')!.getAttribute('aria-valuetext')).toBe('Jun 16 00:00 – Jun 18 08:00')
  })

  test('a range set is drawn, told once to the page and kept per view; the page built again starts on it', async () => {
    await load()
    let told = 0
    const r = mount({ onChange: () => told++ })
    r.set(T0 + H, T0 + 3 * H)
    await wait()
    expect([r.full, r.from, r.to, told]).toEqual([false, T0 + H, T0 + 3 * H, 1])
    expect(r.has(T0 + 2 * H) && !r.has(T0 + 4 * H)).toBe(true)
    expect(doc().querySelector('.thimble-range-dates')!.textContent).toBe('Jun 16 01:00 – 03:00')
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
})
