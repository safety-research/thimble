// The view kit's Colour by (backend/app/viewer_colour.js, thimble.colourBy) and what it needs of the bridge
// (backend/app/viewer_bridge.js), in a jsdom window of their own: one menu lists the view's fields and every label, the
// chosen field's values are chips with their counts that turn a value's colour off and on, the bridge draws the chosen
// value's bar and none on what is off, whose records stay, a label the analyst turns on takes the colour, a label chosen in the menu asks for
// thimble's label editor beside the menu, and the choice is kept through the `colour` message and handed back as
// window.__thimbleColour. The marks the page hands over name each label's value
// with colours a canvas can draw (src/files/labels.ts viewMarks, src/files/ViewerFrame.tsx colourScript). Layout and
// the drawn bars, the chips' overflow and the coloured scrollbar are tests/public/browser/view-colour.test.ts; the marks'
// colours and values tests/public/view-marks.test.ts.
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
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)

const ROWS = [
  ['a.jsonl#L1', 'Text only', 'ops'],
  ['a.jsonl#L2', 'With links', 'wiki'],
  ['a.jsonl#L3', 'Text only', 'ops'],
  ['a.jsonl#L4', '', 'ops'],
]
/** A page with four anchored messages, each saying its kind (or its channel) as data-colour, and a mount in its top
 * row; `kept` is what thimble kept for the view (window.__thimbleColour); `pre`, a script run before the bridge. */
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
const mount = (opts: object = {}) =>
  win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }, { name: 'channel', title: 'Channel' }], ...opts })

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
    expect(c.attr({ kind: 'With links' })).toBe(' data-colour="With links"')
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

  test('one menu lists Off, the fields and every label, any checked together: the first the colour, each other a track', async () => {
    await load()
    let changed = 0
    const c = mount({ onChange: () => changed++ })
    labels(false)
    await wait()
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    const menu = () => doc().querySelector('.thimble-colour-menu')!
    expect([...menu().querySelectorAll('.thimble-colour-head')].map((h) => h.textContent)).toEqual(['Color by', 'Fields', 'Labels'])
    expect([...menu().querySelectorAll('.thimble-colour-item .thimble-colour-nm')].map((n) => n.textContent)).toEqual(['Off', 'Kind', 'Channel', 'Deadline', 'New label'])
    // a label is a choice as a field is: no switch of its own, a box checked while it is chosen
    expect(menu().querySelector('[data-switch], .thimble-colour-switch')).toBeNull()
    expect(menu().querySelector('[data-by="l:k1"]')!.getAttribute('data-label')).toBe('k1')
    expect([...menu().querySelectorAll('[data-by^="f:"], [data-by^="l:"]')].map((r) => [r.getAttribute('data-by'), r.getAttribute('aria-checked')])).toEqual([
      ['f:kind', 'true'],
      ['f:channel', 'false'],
      ['l:k1', 'false'],
    ])
    // a second field checked: the menu stays open, Kind still colours, Channel is a track
    ;(menu().querySelector('[data-by="f:channel"]') as HTMLElement).click()
    await wait()
    expect(menu()).not.toBeNull()
    expect(c.by).toEqual({ field: 'kind', title: 'Kind' })
    expect(c.picks).toEqual([{ field: 'kind', title: 'Kind' }, { field: 'channel', title: 'Channel' }])
    expect(doc().querySelector('.thimble-colour-by')!.textContent).toBe('Color by:Kind+1')
    expect(menu().querySelector('[data-by="f:channel"] .thimble-colour-track-n')!.textContent).toBe('track')
    expect(c.attr({ kind: 'Text only', channel: 'ops' })).toBe(' data-colour="Text only" data-colour-tracks="[&quot;ops&quot;]"')
    expect(changed).toBe(1)
    // the first unchecked: the next one colours
    ;(menu().querySelector('[data-by="f:kind"]') as HTMLElement).click()
    await wait()
    expect(c.by).toEqual({ field: 'channel', title: 'Channel' })
    expect(c.picks).toEqual([{ field: 'channel', title: 'Channel' }])
    expect(c.attr({ channel: 'ops' })).toBe(' data-colour="ops"')
    expect(changed).toBe(2)
    expect(of('colour').at(-1)!.state).toMatchObject({ by: 'f:channel', picks: ['f:channel'], field: 'channel' })
    // the last unchecked: Color by is Off
    ;(menu().querySelector('[data-by="f:channel"]') as HTMLElement).click()
    await wait()
    expect(c.off).toBe(true)
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

  test('the choice kept for the view is where the page starts, and a label it saw on then does not take the colour again', async () => {
    await load({ v: 1, by: 'f:channel', field: 'channel', off: { 'f:channel': ['wiki'] }, seen: ['k1'], colours: { channel: { wiki: 0, ops: 1 } } }, 'channel')
    const c = mount()
    labels(true)
    await wait()
    expect(c.by).toEqual({ field: 'channel', title: 'Channel' })
    expect(c.isOn('wiki')).toBe(false)
    expect(c.colourOf('ops')).toBe(c.colourOf('ops'))
    expect(chips().map((x) => x[0])).toEqual(['wiki', 'ops'])
    // a choice from before its labels were saved: a label on now takes the colour
    await load({ v: 1, by: 'f:channel', field: 'channel', off: {}, seen: [], colours: {} })
    const d = mount()
    labels(true)
    await wait()
    expect(d.by).toEqual({ label: 'k1', title: 'Deadline' })
  })

  test("counts the page gives replace those of the page's elements, and the undeclared values take colours by count", async () => {
    await load()
    const c = mount()
    c.counts({ 'Text only': 900, 'With links': 120, '': 3 })
    await wait()
    expect(chips()).toEqual([
      ['Text only', '900', 'true'],
      ['With links', '120', 'true'],
      ['No kind', '3', 'true'],
    ])
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    ;(doc().querySelector('[data-by="f:channel"]') as HTMLElement).click()
    ;(doc().querySelector('[data-by="f:kind"]') as HTMLElement).click()
    // the kinds the page drew for Kind are no values of Channel: they are taken off the page until it draws again
    expect(doc().querySelectorAll('.msg[data-colour]')).toHaveLength(0)
    c.counts([['wiki', 40], ['ops', 7], ['press', 90]])
    await wait()
    expect(chips().map((x) => x[0])).toEqual(['press', 'wiki', 'ops'])
    expect(of('colour').at(-1)!.state).toMatchObject({ colours: { channel: { press: 0, wiki: 1, ops: 2 } } })
  })
})

describe('several choices', () => {
  /** Each record's bands as the bridge draws them, by its ref: its edge and the colours of its set of bands as the
   * page's sheet gives them ('transparent' for an empty band); null for a record with none. */
  const bands = () => {
    const css = doc().querySelector('style[data-thimble="labels"]')?.textContent ?? ''
    return Object.fromEntries(
      [...doc().querySelectorAll('#list [data-anchor]')].map((e) => {
        const k = e.getAttribute('data-thimble-bands')
        if (k == null) return [e.getAttribute('data-anchor'), null]
        const grad = new RegExp(`\\[data-thimble-bands="${k}"\\]\\{--thimble-bands:linear-gradient\\(to right,(.*?)\\);`).exec(css)?.[1] ?? ''
        // its stops: a band, a gap, a band, ..., then the rest of the element
        const stops = grad.split(/,(?![^(]*\))/)
        return [e.getAttribute('data-anchor'), { edge: e.getAttribute('data-thimble-edge'), bar: e.hasAttribute('data-thimble-bar'), colours: stops.filter((_, i) => i % 2 === 0 && i < stops.length - 1).map((x) => x.replace(/ \d+px \d+px$/, '')) }]
      }),
    )
  }
  // each record's channel as the page writes it for the track (attr)
  const channels = () => {
    for (const [ref, , channel] of ROWS) doc().querySelector(`[data-anchor="${ref}"]`)!.setAttribute('data-colour-tracks', JSON.stringify([channel || null]))
  }

  test("two fields: a band each on every record with a value of either, in the colour of its value of each, an empty one where it has none; one set of colours, one slot", async () => {
    await load({ v: 1, by: 'f:kind', picks: ['f:kind', 'f:channel'], field: 'kind', off: {}, seen: [], colours: {} })
    const c = mount()
    await wait()
    expect(c.picks.map((p: { title: string }) => p.title)).toEqual(['Kind', 'Channel'])
    channels()
    await wait()
    const got = bands()
    const ops = got['a.jsonl#L1']!.colours[1]
    const wiki = got['a.jsonl#L2']!.colours[1]
    expect(ops).toBeTruthy()
    expect(wiki).toBeTruthy()
    expect(wiki).not.toBe(ops)
    expect(got['a.jsonl#L1']).toEqual({ edge: 'bands', bar: false, colours: [c.colourOf('Text only'), ops] })
    expect(got['a.jsonl#L2']).toEqual({ edge: 'bands', bar: false, colours: [c.colourOf('With links'), wiki] })
    // no kind: an empty first band, then its channel's
    expect(got['a.jsonl#L4']).toEqual({ edge: 'bands', bar: false, colours: ['transparent', ops] })
    expect(doc().querySelector('[data-anchor="a.jsonl#L1"]')!.getAttribute('data-thimble-bands')).toBe(doc().querySelector('[data-anchor="a.jsonl#L3"]')!.getAttribute('data-thimble-bands'))
    // a record with no channel: its kind's band, then an empty one
    doc().querySelector('[data-anchor="a.jsonl#L3"]')!.setAttribute('data-colour-tracks', '[null]')
    await wait()
    expect(bands()['a.jsonl#L3']).toEqual({ edge: 'bands', bar: false, colours: [c.colourOf('Text only'), 'transparent'] })
    // Channel unchecked: the one bar, and no bands
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    ;(doc().querySelector('.thimble-colour-menu [data-by="f:channel"]') as HTMLElement).click()
    await wait()
    expect(doc().querySelectorAll('[data-thimble-bands]')).toHaveLength(0)
    expect([...doc().querySelectorAll('[data-thimble-bar]')].map((e) => e.getAttribute('data-anchor'))).toEqual(['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3'])
    // Off: nothing on any edge
    ;(doc().querySelector('.thimble-colour-menu [data-by="off"]') as HTMLElement).click()
    await wait()
    expect(doc().querySelectorAll('[data-thimble-bands], [data-thimble-bar], [data-thimble-edge]')).toHaveLength(0)
  })

  test("a label as the second choice: its band where it marks the record, in its value's colour, an empty one where it does not", async () => {
    await load({ v: 1, by: 'f:kind', picks: ['f:kind', 'l:k1'], field: 'kind', off: {}, seen: ['k1'], colours: {} })
    const c = mount()
    const marks = {
      'a.jsonl#L2': { bar: '#025ac3', names: ['Deadline'], values: [{ id: 'k1', label: 'Deadline', value: 'deadline', colour: '#025ac3' }], spans: [] },
      'a.jsonl#L4': { bar: '#025ac3', names: ['Deadline'], values: [{ id: 'k1', label: 'Deadline', value: 'deadline', colour: '#025ac3' }], spans: [] },
    }
    labels(true, marks)
    await wait()
    expect(c.picks.map((p: { title: string }) => p.title)).toEqual(['Kind', 'Deadline'])
    expect(bands()).toEqual({
      'a.jsonl#L1': { edge: 'bands', bar: false, colours: [c.colourOf('Text only'), 'transparent'] },
      'a.jsonl#L2': { edge: 'bands', bar: false, colours: [c.colourOf('With links'), '#025ac3'] },
      'a.jsonl#L3': { edge: 'bands', bar: false, colours: [c.colourOf('Text only'), 'transparent'] },
      'a.jsonl#L4': { edge: 'bands', bar: false, colours: ['transparent', '#025ac3'] },
    })
    expect(doc().querySelector('[data-anchor="a.jsonl#L4"]')!.getAttribute('data-thimble-colour')).toBe('')
  })
})

describe('Color by: Off', () => {
  test('colors nothing: no chips, no bars, no choice for the reader; it is kept, and the page starts on it', async () => {
    await load()
    let changed = 0
    const c = mount({ onChange: () => changed++ })
    await wait()
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    ;(doc().querySelector('.thimble-colour-menu [data-by="off"]') as HTMLElement).click()
    await wait()
    expect(doc().querySelector('.thimble-colour-by')!.textContent).toBe('Color by:Off')
    expect(chips()).toEqual([])
    expect(doc().querySelectorAll('[data-thimble-colour], [data-thimble-label], [data-thimble-bar]')).toHaveLength(0)
    expect([c.off, c.by, c.field, c.label, c.query(), c.colourOf('Text only'), c.valueOf({ kind: 'Text only' }), c.attr({ kind: 'Text only' })]).toEqual([true, null, null, null, null, null, null, ''])
    expect(changed).toBe(1)
    expect(of('colour').at(-1)!.state).toMatchObject({ by: 'off' })
    // the page built again starts on Off, and a label that was on already draws no bar either
    await load({ ...(of('colour').at(-1)!.state as object), seen: ['k1'] })
    const d = mount()
    labels(true, { 'a.jsonl#L2': { bar: '#025ac3', names: ['Deadline'], values: [{ id: 'k1', label: 'Deadline', value: 'deadline', colour: '#025ac3' }], spans: [] } })
    await wait()
    expect(d.off).toBe(true)
    expect(doc().querySelectorAll('[data-thimble-bar]')).toHaveLength(0)
  })

  test('thimble.colorBy and thimble.colourBy are the one control', async () => {
    await load()
    expect(win().thimble.colorBy).toBe(win().thimble.colourBy)
  })
})

describe('Reset', () => {
  test("shows while a value is off or the row's search field is changed, and puts both back, Color by's choice kept", async () => {
    await load({ v: 1, by: 'f:channel', field: 'channel', off: {}, seen: [], colours: {} }, 'channel')
    doc().querySelector('.top')!.insertAdjacentHTML('afterbegin', '<input class="field" id="q" type="search">')
    let changed = 0
    let typed = 0
    doc().getElementById('q')!.addEventListener('input', () => typed++)
    mount({ onChange: () => changed++ })
    await wait()
    const reset = () => doc().querySelector<HTMLButtonElement>('.thimble-reset')!
    expect(reset().hidden).toBe(true)
    doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[0].click()
    const q = doc().getElementById('q') as HTMLInputElement
    q.value = 'relay'
    q.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await wait()
    expect(reset().hidden).toBe(false)
    expect(reset().textContent).toBe('Reset')
    changed = 0
    typed = 0
    reset().click()
    await wait()
    expect(q.value).toBe('')
    expect(typed).toBe(1)
    expect(chips().every((x) => x[2] === 'true')).toBe(true)
    expect(of('colour').at(-1)!.state).toMatchObject({ by: 'f:channel', off: {} })
    expect(changed).toBe(1)
    expect(reset().hidden).toBe(true)
  })

  test("the page's own state: changed() shows Reset, and reset() alone draws the page again", async () => {
    await load()
    let changed = 0
    mount({ onChange: () => changed++ })
    const state = { user: null as string | null, draws: 0 }
    const r = win().thimble.onReset({ changed: () => state.user != null, reset: () => { state.user = null; state.draws++ } })
    state.user = 'ash'
    r.check()
    await wait()
    const reset = () => doc().querySelector<HTMLButtonElement>('.thimble-reset')!
    expect(reset().hidden).toBe(false)
    doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[0].click()
    await wait()
    changed = 0
    reset().click()
    await wait()
    expect([state.user, state.draws, changed]).toEqual([null, 1, 0])
    expect(chips().every((x) => x[2] === 'true')).toBe(true)
    expect(reset().hidden).toBe(true)
  })
})

describe('a label chosen in the menu', () => {
  // the analyst's click as the bridge reads it, which jsdom has no notion of: transient activation held throughout
  const ACTIVE = script('class Activation { get isActive() { return true } }; Object.defineProperty(navigator, "userActivation", { value: new Activation() })')
  // the view kept on Off, the label seen already: checking it makes it the one choice
  const ready = async (on: boolean) => {
    await load({ v: 1, by: 'off', picks: [], field: 'kind', off: {}, seen: ['k1'], colours: {} }, 'kind', ACTIVE)
    const c = mount()
    labels(on)
    fromPage({ type: 'thimble:key', key: 'key' })
    await wait()
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    return c
  }
  const row = () => doc().querySelector<HTMLElement>('.thimble-colour-menu [data-by="l:k1"]')!
  const calls = () => of('labelCall').map((m) => [m.op, m.args])

  test('checked, it colours by it and asks for its editor beside the menu, which stays open with the label checked', async () => {
    const c = await ready(true)
    row().click()
    await wait()
    expect(c.by).toEqual({ label: 'k1', title: 'Deadline' })
    const [edit] = of('labelCall').filter((m) => m.op === 'edit')
    expect(edit.args).toEqual({ id: 'k1', anchor: { left: 0, top: 0, width: 0, height: 0 } })
    expect(doc().querySelector('.thimble-colour-menu'), 'the menu stays open').not.toBeNull()
    expect(row().getAttribute('aria-checked')).toBe('true')
    // the editor closed from inside: the focus comes back to the label's row
    fromPage({ type: 'thimble:labelDone', id: edit.id })
    fromPage({ type: 'thimble:labelEditorClosed', id: edit.id, focus: true })
    await wait()
    expect(doc().activeElement).toBe(row())
  })

  test('closed by a click elsewhere, it leaves the focus alone', async () => {
    await ready(true)
    row().click()
    await wait()
    const [edit] = of('labelCall').filter((m) => m.op === 'edit')
    const field = doc().body.appendChild(doc().createElement('input'))
    field.focus()
    fromPage({ type: 'thimble:labelDone', id: edit.id })
    fromPage({ type: 'thimble:labelEditorClosed', id: edit.id, focus: false })
    await wait()
    expect(doc().activeElement).toBe(field)
  })

  test('a label that is off is turned on first, then its editor asked for, in the same click', async () => {
    await ready(false)
    row().click()
    await wait()
    expect(calls()).toEqual([
      ['on', { id: 'k1', on: true }],
      ['edit', { id: 'k1', anchor: { left: 0, top: 0, width: 0, height: 0 } }],
    ])
  })

  test('unchecked, it leaves the choices and is turned off in Files, with no editor', async () => {
    const c = await ready(true)
    row().click()
    await wait()
    expect(c.by).toEqual({ label: 'k1', title: 'Deadline' })
    row().click()
    await wait()
    expect(c.off).toBe(true)
    expect(calls().map((x) => x[0])).toEqual(['edit', 'on'])
    expect(calls()[1]).toEqual(['on', { id: 'k1', on: false }])
    expect(row().getAttribute('aria-checked')).toBe('false')
  })

  test('a field or Off asks for no editor, and there is no button for a definition, beside Color by or in the menu', async () => {
    const c = await ready(true)
    expect(doc().querySelector('.thimble-colour-menu [data-info], .thimble-colour-menu .thimble-def')).toBeNull()
    ;(doc().querySelector('.thimble-colour-menu [data-by="f:channel"]') as HTMLElement).click()
    await wait()
    expect(c.by).toEqual({ field: 'channel', title: 'Channel' })
    expect(doc().querySelector('.thimble-colour-menu'), 'a field checked keeps the menu open').not.toBeNull()
    ;(doc().querySelector('.thimble-colour-menu [data-by="off"]') as HTMLElement).click()
    await wait()
    expect(doc().querySelector('.thimble-colour-menu'), 'Off closes it').toBeNull()
    expect(calls()).toEqual([])
    // the label as the colour has no button beside Color by
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    row().click()
    await wait()
    expect(doc().querySelector('.thimble-colour-about')).toBeNull()
  })
})

describe('a declared value that names its colour', () => {
  test('takes that palette colour whatever was kept, and the other values take the places left in order', async () => {
    // kept from an earlier version of the view, which declared 'With links' second
    await load({ v: 1, by: 'f:kind', field: 'kind', off: {}, seen: [], colours: { kind: { 'Text only': 0, 'With links': 1 } } })
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', { name: 'With links', colour: 6 }, 'Quote'] }] })
    c.counts({ 'Text only': 2, 'With links': 1, Quote: 1, Other: 4 })
    await wait()
    // jsdom resolves no CSS variable, so a colour reads as the palette token it is
    expect(['Text only', 'With links', 'Quote', 'Other'].map((v) => c.colourOf(v))).toEqual(['var(--label-1)', 'var(--label-6)', 'var(--label-2)', 'var(--label-3)'])
    expect(chips().map((x) => x[0])).toEqual(['Text only', 'With links', 'Quote', 'Other'])
  })
})

describe("a field's values without a colour of their own", () => {
  test('take the palette in the order new values take it, so the first five hold no second blue', async () => {
    await load()
    // the page's own records say the first two, the commonest, whichever counts the control reads first
    const values = ['Text only', 'With links', 'c', 'd', 'e', 'f', 'g', 'h']
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })
    c.counts(Object.fromEntries(values.map((v, i) => [v, 100 - i])))
    await wait()
    expect(values.map((v) => c.colourOf(v))).toEqual([1, 2, 3, 5, 6, 7, 4, 8].map((n) => `var(--label-${n})`))
  })

  test('take the places in that order around the colours declared values name, and a named place is its hue', async () => {
    await load()
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['a', 'b', { name: 'c', colour: 4 }, 'd', 'e'] }] })
    c.counts({ a: 1, b: 1, c: 1, d: 1, e: 1 })
    await wait()
    expect(['a', 'b', 'c', 'd', 'e'].map((v) => c.colourOf(v))).toEqual([1, 2, 4, 3, 5].map((n) => `var(--label-${n})`))
  })
})

describe("a field's values past the palette's twelve colours", () => {
  test('go under one chip, "Other", which turns them off and on together and says on hover which they are', async () => {
    await load()
    // a page whose records the reader counts: nothing on the page takes a value before
    doc().getElementById('list')!.innerHTML = ''
    const names = Array.from({ length: 15 }, (_, i) => `v${String(i + 1).padStart(2, '0')}`)
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }], chips: 'filter' })
    c.counts(Object.fromEntries(names.map((v, i) => [v, 100 - i])))
    await wait()
    const shown = chips()
    expect(shown.map((x) => x[0])).toEqual([...names.slice(0, 12), 'Other'])
    // the three it stands for, their counts summed, in the grey of a value with no place in the palette
    expect(shown.at(-1)).toEqual(['Other', String(88 + 87 + 86), 'true'])
    const other = doc().querySelector<HTMLElement>('.thimble-colour-chip[data-other]')!
    expect(other.getAttribute('style')).toContain('var(--label-none)')
    expect(other.querySelector('[data-palette]'), 'no palette: the grey is no colour of its own').toBeNull()
    expect(other.hasAttribute('title')).toBe(false)
    // the page still hears of every value, each in its place
    expect(c.values.map((v: { value: string }) => v.value)).toEqual(names)
    expect(c.colourOf('v14')).toBe('var(--label-none)')
    const off = () => c.values.filter((v: { on: boolean }) => !v.on).map((v: { value: string }) => v.value)
    other.click()
    await wait()
    expect(chips().at(-1)![2]).toBe('false')
    expect(off()).toEqual(['v13', 'v14', 'v15'])
    expect(['v12', 'v13', 'v15'].map((v) => c.isOn(v))).toEqual([true, false, false])
    // turned off, they draw in no colour, and the reader hears none of them
    expect(c.colourOf('v14')).toBeNull()
    expect(c.query()).toEqual({ field: 'kind' })
    doc().querySelector<HTMLElement>('.thimble-colour-chip[data-other]')!.click()
    await wait()
    expect(off()).toEqual([])
    // Alt keeps the values under it alone
    doc().querySelector<HTMLElement>('.thimble-colour-chip[data-other]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, altKey: true, detail: 1 }))
    await wait()
    expect(off()).toEqual(names.slice(0, 12))
    // hovering it names the values it stands for
    doc().querySelector('.thimble-colour-chip[data-other]')!.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }))
    expect(doc().querySelector('.thimble-tip .thimble-tip-m')!.textContent).toBe('v13 88 · v14 87 · v15 86')
  })

  test('a field of twelve values or fewer has no "Other"', async () => {
    await load()
    doc().getElementById('list')!.innerHTML = ''
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })
    c.counts(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`v${i}`, 20 - i])))
    await wait()
    // in the order of their counts, which is the order they took the palette in
    expect(chips().map((x) => x[0])).toEqual(Array.from({ length: 12 }, (_, i) => `v${i}`))
    expect(doc().querySelector('[data-other]')).toBeNull()
  })
})

describe('the menu of a field that declares no values', () => {
  test("says how many values the records the page hands the kit take, and shows them, the commonest first, in the colours they would take; none is kept", async () => {
    await load()
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }, { name: 'service', title: 'Service' }, { name: 'n', title: 'Row', value: (i: number) => (i % 2 ? 'odd' : 'even') }] })
    // the page draws its records, each through attr (a record twice, as a redraw does, counts once), and the rows by index
    const recs = [
      { kind: 'a', service: 'api' },
      { kind: 'a', service: 'db' },
      { kind: 'b', service: 'db' },
      { kind: 'a', service: 'db' },
      { kind: 'c', service: '' },
    ]
    for (const r of [...recs, recs[0]]) c.attr(r)
    for (const i of [0, 1, 2, 2]) c.valueOf(i)
    await wait()
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    const row = (by: string) => {
      const r = doc().querySelector(`.thimble-colour-menu [data-by="${by}"]`)!
      return [r.querySelector('.thimble-colour-top .thimble-colour-n')?.textContent ?? '', [...r.querySelectorAll('.thimble-colour-pchip')].map((p) => [p.textContent, (p.querySelector('.thimble-colour-sw') as HTMLElement).getAttribute('style')])]
    }
    expect(row('f:service')).toEqual(['2 values', [['db', '--c:var(--label-1)'], ['api', '--c:var(--label-2)']]])
    expect(row('f:n')).toEqual(['2 values', [['even', '--c:var(--label-1)'], ['odd', '--c:var(--label-2)']]])
    // the field chosen keeps its colours by the counts the page gives, not by what the menu showed
    expect(JSON.stringify(of('colour').at(-1)?.state ?? {})).not.toContain('service')
  })
})

describe('a field that says its own value', () => {
  test('takes any record the page has, such as a row index into columns', async () => {
    await load()
    const kinds = ['Text only', 'With links', '']
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', value: (i: number) => kinds[i] }] })
    expect([0, 1, 2].map((i) => c.valueOf(i))).toEqual(['Text only', 'With links', null])
    expect(c.attr(1)).toBe(' data-colour="With links"')
    expect(c.keeps(0)).toBe(true)
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

describe('color marks the records alone', () => {
  test("a group's row, which carries no anchor, takes no bar, and is no record the chips count", async () => {
    await load()
    doc().getElementById('list')!.insertAdjacentHTML('afterbegin', '<div class="group" data-colour="Text only">a page</div>')
    mount()
    await wait()
    expect(doc().querySelector('.group')!.hasAttribute('data-thimble-bar')).toBe(false)
    expect(chips()[0]).toEqual(['Text only', '2', 'true'])
  })

  test("thimble.mix draws a group's share of each value in its colour, a value off in gray, nothing for Off", async () => {
    await load()
    const c = mount()
    await wait()
    const el = doc().body.appendChild(doc().createElement('span'))
    win().thimble.mix(el, { 'With links': 1, 'Text only': 3, '': 2 })
    const parts = () => [...el.querySelectorAll('.thimble-mix > span')].map((s) => (s as HTMLElement).style.flexGrow)
    const fills = () => [...el.querySelectorAll('.thimble-mix > span')].map((s) => (s as HTMLElement).style.background)
    // the chips' order, the records with no value last
    expect(parts()).toEqual(['3', '1', '2'])
    expect(el.querySelector('.thimble-mix')!.getAttribute('title')).toBe('Kind: Text only 3 · With links 1 · No kind 2')
    const [textOnly, withLinks, none] = fills()
    expect(textOnly).not.toBe(none)
    expect(win().thimble.mix({ 'Text only': 1 })).toContain('class="thimble-mix"')
    doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[0].click()
    await wait()
    // a value turned off keeps its share, in the gray of the records with no value
    win().thimble.mix(el, { 'With links': 1, 'Text only': 3, '': 2 })
    expect(parts()).toEqual(['3', '1', '2'])
    expect(fills()).toEqual([none, withLinks, none])
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    ;(doc().querySelector('.thimble-colour-menu [data-by="off"]') as HTMLElement).click()
    await wait()
    expect(c.off).toBe(true)
    win().thimble.mix(el, { 'Text only': 3 })
    expect(el.querySelector('.thimble-mix')!.hasAttribute('hidden')).toBe(true)
  })
})

describe('the color picker', () => {
  const WHEEL = JSON.parse(readFileSync(path.join(APP, 'label_wheel.json'), 'utf8')) as number[][]
  test('shows every hue around the color wheel, a light and a dark of each, red, purple and pink among them', async () => {
    await load(undefined, 'kind', `<script>window.__thimbleLabelWheel = ${JSON.stringify(WHEEL)}</script>`)
    const c = mount()
    await wait()
    ;(doc().querySelector('.thimble-colour-chip .chip-sw[data-palette]') as HTMLElement).click()
    const picks = [...doc().querySelectorAll('.thimble-colour-palette [data-pick]')].map((b) => Number(b.getAttribute('data-pick')) + 1)
    expect(picks).toEqual(WHEEL.flat())
    expect(picks).toHaveLength(18)
    // red first, then around the wheel to pink
    expect(picks.slice(0, 2)).toEqual([13, 14])
    expect(picks.slice(-4)).toEqual([15, 16, 17, 18])
    // red picked for a value: it takes it, and keeps a chip of its own
    ;(doc().querySelector('.thimble-colour-palette [data-pick="12"]') as HTMLElement).click()
    await wait()
    expect(c.colourOf('Text only')).toBe('var(--label-13)')
    expect(of('colour').at(-1)!.state).toMatchObject({ picked: { kind: { 'Text only': 12 } } })
    expect(chips()[0][0]).toBe('Text only')
  })

  test('red, purple and pink are never given by themselves: new values take the twelve, past them "Other"', async () => {
    await load()
    doc().getElementById('list')!.innerHTML = ''
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })
    const names = Array.from({ length: 18 }, (_, i) => `v${i}`)
    c.counts(Object.fromEntries(names.map((v, i) => [v, 100 - i])))
    await wait()
    const given = names.map((v) => c.colourOf(v))
    expect(given.slice(0, 12).every((x: string) => /var\(--label-([1-9]|1[0-2])\)$/.test(x))).toBe(true)
    expect(given.slice(12).every((x: string) => x === 'var(--label-none)')).toBe(true)
  })
})

describe("every choice of the kit's controls", () => {
  test('is listed for the checks, each one a go() that chooses it: Off, the fields, the labels on, and two together', async () => {
    await load()
    const c = mount()
    labels(true)
    await wait()
    const list = win().thimble.__choices() as { control: string; choice: string; go: () => void }[]
    expect(list.map((x) => `${x.control}: ${x.choice}`)).toEqual(['Color by: Off', 'Color by: Kind', 'Color by: Channel', 'Color by: Deadline', 'Color by: Kind + Channel'])
    list[0].go()
    await wait()
    expect(c.off).toBe(true)
    list[4].go()
    await wait()
    expect(c.picks.map((p: { title: string }) => p.title)).toEqual(['Kind', 'Channel'])
  })
})
