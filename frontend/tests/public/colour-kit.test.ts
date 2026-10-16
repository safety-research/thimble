// The view kit's Colour by (backend/app/viewer_colour.js, thimble.colourBy) and what it needs of the bridge
// (backend/app/viewer_bridge.js), in a jsdom window of their own: the chosen field's values are chips with their
// counts, the bridge draws each record's bar, a chip turns a value's colour off while its records stay, a label the
// analyst turns on takes the colour, the choice thimble keeps for a view reaches the page whole and cannot end its
// script, and the American names and the British ones kept as aliases are one API. The marks' colours and values are
// tests/public/view-marks.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'
import { colourScript } from '../../src/files/ViewerFrame.tsx'

const APP = path.resolve(__dirname, '../../../backend/app')
const BRIDGE = readFileSync(path.join(APP, 'viewer_bridge.js'), 'utf8')
// the kit's Color by, after the order new values take the palette in, which views.frame_document puts before it
const COLOUR = `window.__thimbleLabelOrder = ${readFileSync(path.join(APP, 'label_order.json'), 'utf8')}\n` + readFileSync(path.join(APP, 'viewer_colour.js'), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any }
const doc = () => dom.window.document
const fromPage = (data: object) => win().dispatchEvent(new dom.window.MessageEvent('message', { data, source: win().parent as any }))

const ROWS = [
  ['a.jsonl#L1', 'Text only', 'ops'],
  ['a.jsonl#L2', 'With links', 'wiki'],
  ['a.jsonl#L3', 'Text only', 'ops'],
  ['a.jsonl#L4', '', 'ops'],
]
/** A page with four anchored messages, each saying its kind (or its channel) as data-colour, the British spelling of
 * the data-color the kit's attr writes, which the kit still reads, and a mount in its top row; `kept` is what thimble
 * kept for the view (window.__thimbleColour); `pre`, a script run before the bridge. */
async function load(kept?: object, field: 'kind' | 'channel' = 'kind', pre = '') {
  const rows = ROWS.map(([ref, kind, channel]) => `<div class="msg" data-anchor="${ref}" data-colour="${field === 'kind' ? kind : channel}">${ref}</div>`).join('')
  const page = `<!doctype html><html><head>${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${pre}${script(BRIDGE)}${script(COLOUR)}</head><body><div class="top"><span id="colour"></span></div><div id="list">${rows}</div></body></html>`
  dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  sent = []
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  await wait()
}
afterEach(() => dom?.window.close())

const LABEL = { id: 'k1', name: 'Deadline', on: true, here: true, colour: '#025ac3', values: [{ name: 'deadline', colour: '#025ac3', highlight: true }, { name: 'other', colour: '#a09c93', highlight: false }], count: 2 }
const labels = (on: boolean, marks: object = {}) =>
  fromPage({ type: 'thimble:labels', marks, on: on ? [{ id: 'k1', name: 'Deadline', colour: '#025ac3', values: [{ name: 'deadline', colour: '#025ac3' }] }] : [], filter: null, all: [{ ...LABEL, on }], palette: ['#025ac3'] })
const chips = () => [...doc().querySelectorAll('.thimble-colour-chip')].map((c) => [c.querySelector('.chip-text')!.textContent, c.querySelector('.chip-count')!.textContent, c.getAttribute('aria-pressed')])
// a view that opens colored by Kind (`initial`); without `initial` a view opens Off ('Color by: how the view opens')
const mount = (opts: object = {}) =>
  win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }, { name: 'channel', title: 'Channel' }], initial: 'kind', ...opts })

describe('Colour by', () => {
  test("shows the chosen field's values as chips with the counts the page shows, and draws each record's bar", async () => {
    await load()
    const c = mount()
    await wait()
    expect(doc().querySelector('.thimble-colour-by')!.textContent).toContain('Kind')
    expect(chips()).toEqual([
      ['Text only', '2', 'true'],
      ['With links', '1', 'true'],
      ['No kind', '1', 'true'],
    ])
    expect(c.by).toEqual({ field: 'kind', title: 'Kind' })
    expect(c.attr({ kind: 'With links' })).toBe(' data-color="With links"')
    // the bridge draws the bar on each record with a value, not on the one with none
    expect([...doc().querySelectorAll('[data-thimble-colour]')].map((e) => e.getAttribute('data-anchor'))).toEqual(['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3'])
    expect(doc().querySelector('[data-anchor="a.jsonl#L1"]')!.getAttribute('data-thimble-bar')).toBe(doc().querySelector('[data-anchor="a.jsonl#L3"]')!.getAttribute('data-thimble-bar'))
  })

  test("a chip turns its value's colour off and on: its records stay, without the bar, under 'filter' as under the default; Alt keeps it alone", async () => {
    await load()
    // 'filter' once hid the records of a value turned off; it is still taken, and does nothing
    const c = mount({ chips: 'filter' })
    await wait()
    const chip = (i: number) => doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[i]
    const barred = () => [...doc().querySelectorAll('[data-thimble-bar]')].map((e) => e.getAttribute('data-anchor'))
    const off = () => c.values.filter((v: { on: boolean }) => !v.on).map((v: { value: string | null }) => v.value)
    expect(barred()).toEqual(['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3'])
    chip(0).click()
    await wait()
    expect(chips()[0][2]).toBe('false')
    expect(c.isOn('Text only')).toBe(false)
    expect(off()).toEqual(['Text only'])
    // Color by only colors: the records of a value turned off stay, drawn with no colour (Filter by hides records)
    expect(c.keeps({ kind: 'Text only' })).toBe(true)
    expect(c.colourOf('Text only')).toBeNull()
    expect(c.colourOf('With links')).toBe('var(--label-2)')
    expect(barred()).toEqual(['a.jsonl#L2'])
    expect(doc().querySelectorAll('[data-thimble-off],[data-thimble-drop]')).toHaveLength(0)
    expect([...doc().querySelectorAll('.msg')].map((e) => dom.window.getComputedStyle(e).display)).toEqual(['block', 'block', 'block', 'block'])
    // the reader hears no value turned off, so it keeps and counts every record
    expect(c.query()).toEqual({ field: 'kind' })
    chip(0).click()
    await wait()
    expect(barred()).toEqual(['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3'])
    chip(2).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, altKey: true, detail: 1 }))
    await wait()
    expect(chips().map((x) => x[2])).toEqual(['false', 'false', 'true'])
    expect(off()).toEqual(['Text only', 'With links'])
    expect(c.query()).toEqual({ field: 'kind' })
    expect(barred()).toEqual([])
    expect(doc().querySelectorAll('.msg')).toHaveLength(4)
    await load()
    mount()
    await wait()
    chip(1).click()
    await wait()
    const l2 = doc().querySelector('[data-anchor="a.jsonl#L2"]')!
    expect(l2.hasAttribute('data-thimble-bar')).toBe(false)
    expect(l2.hasAttribute('data-thimble-off')).toBe(false)
    expect(barred()).toEqual(['a.jsonl#L1', 'a.jsonl#L3'])
  })

  test("a label turned on takes the colour: its values are the chips, each record's mark its bar, its id their data-label", async () => {
    await load()
    let changed = 0
    const c = mount({ onChange: () => changed++ })
    labels(false)
    await wait()
    expect(c.field).toBe('kind')
    const marks = { 'a.jsonl#L2': { bar: '#025ac3', names: ['Deadline'], values: [{ id: 'k1', label: 'Deadline', value: 'deadline', colour: '#025ac3' }], spans: [] } }
    labels(true, marks)
    await wait()
    expect(c.by).toEqual({ label: 'k1', title: 'Deadline' })
    expect(changed).toBe(1)
    expect(chips()).toEqual([
      ['deadline', '1', 'true'],
      ['Not marked', '3', 'true'],
    ])
    expect([...doc().querySelectorAll('.thimble-colour-chip')].every((e) => e.getAttribute('data-label') === 'k1')).toBe(true)
    expect([...doc().querySelectorAll('[data-thimble-label]')].map((e) => e.getAttribute('data-anchor'))).toEqual(['a.jsonl#L2'])
    expect(doc().querySelectorAll('[data-thimble-colour]')).toHaveLength(0)
    expect(c.valueOf({ ref: 'a.jsonl#L2' })).toBe('deadline')
    expect(c.valueOf('a.jsonl#L1')).toBeNull()
    expect(c.attr({ kind: 'Text only' })).toBe('')
    expect(c.query()).toEqual({ label: 'k1', name: 'Deadline' })
    // its value turned off: the record keeps its place and loses its bar; on again, the bar is back
    ;(doc().querySelector('.thimble-colour-chip') as HTMLElement).click()
    await wait()
    expect(c.isOn('deadline')).toBe(false)
    expect(doc().querySelectorAll('[data-thimble-label]')).toHaveLength(0)
    expect(doc().querySelectorAll('[data-thimble-off]')).toHaveLength(0)
    expect(c.keeps({ ref: 'a.jsonl#L2' })).toBe(true)
    expect(c.query()).toEqual({ label: 'k1', name: 'Deadline' })
    ;(doc().querySelector('.thimble-colour-chip') as HTMLElement).click()
    await wait()
    expect([...doc().querySelectorAll('[data-thimble-label]')].map((e) => e.getAttribute('data-anchor'))).toEqual(['a.jsonl#L2'])
    // the label turned off again: the field the analyst chose last is the colour again
    labels(false)
    await wait()
    expect(c.by).toEqual({ field: 'kind', title: 'Kind' })
  })
})

describe('the choice thimble keeps for a view', () => {
  test("reaches its page whole, and nothing in it can end the page's script", () => {
    const html = colourScript({ by: 'f:a</script><script>alert(1)</script>', off: {} })
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain('\\u003c/script>')
    expect(colourScript(null)).toBe('')
  })
})

describe('the American names, the British ones kept as aliases', () => {

  test("markOf and onLabels give each color as color and colour; setLabelColour is setLabelColor", async () => {
    await load()
    const heard: any[] = []
    win().thimble.onLabels((s: unknown) => heard.push(s))
    labels(true, { 'a.jsonl#L2': { bar: '#025ac3', names: ['Deadline'], values: [{ id: 'k1', label: 'Deadline', value: 'deadline', colour: '#025ac3' }], spans: [{ text: 'due', colour: '#025ac3', id: 'k1' }] } })
    await wait()
    const m = win().thimble.markOf('a.jsonl#L2')
    expect([m.values[0].color, m.values[0].colour, m.spans[0].color, m.spans[0].colour]).toEqual(['#025ac3', '#025ac3', '#025ac3', '#025ac3'])
    const state = heard.at(-1)
    for (const l of [...state.labels, ...state.all]) {
      expect(l.color).toBe(l.colour)
      for (const v of l.values) expect(v.color).toBe(v.colour)
    }
    const calls: unknown[][] = []
    win().thimble.setLabelColor = (...a: unknown[]) => (calls.push(a), Promise.resolve())
    win().thimble.setLabelColour('k1', 'deadline', '#025ac3')
    expect(calls).toEqual([['k1', 'deadline', '#025ac3']])
  })
})
