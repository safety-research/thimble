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
    expect(c.attr({ kind: 'Text only', channel: 'ops' })).toBe(' data-color="Text only" data-color-tracks="[&quot;ops&quot;]"')
    expect(changed).toBe(1)
    // the first unchecked: the next one colours
    ;(menu().querySelector('[data-by="f:kind"]') as HTMLElement).click()
    await wait()
    expect(c.by).toEqual({ field: 'channel', title: 'Channel' })
    expect(c.picks).toEqual([{ field: 'channel', title: 'Channel' }])
    expect(c.attr({ channel: 'ops' })).toBe(' data-color="ops"')
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

})

describe('Color by: how the view opens', () => {
  test('Off without `initial`: no chips, no bars, Off checked in the menu, and no Reset', async () => {
    await load()
    const c = win().thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }, { name: 'channel', title: 'Channel' }] })
    await wait()
    expect(doc().querySelector('.thimble-colour-by')!.textContent).toBe('Color by:Off')
    expect([c.off, c.by, c.picks, c.values, c.query()]).toEqual([true, null, [], [], null])
    expect(chips()).toEqual([])
    expect(doc().querySelectorAll('[data-thimble-colour], [data-thimble-bar], [data-thimble-edge]')).toHaveLength(0)
    expect(doc().querySelector<HTMLButtonElement>('.thimble-reset')!.hidden).toBe(true)
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    expect(doc().querySelector('.thimble-colour-menu [data-by="off"]')!.getAttribute('aria-checked')).toBe('true')
    expect(doc().querySelector('.thimble-colour-menu [data-by="f:kind"]')!.getAttribute('aria-checked')).toBe('false')
    // a view with no field at all opens Off too
    await load()
    const d = win().thimble.colorBy({ mount: '#colour', fields: [] })
    await wait()
    expect([d.off, doc().querySelector('.thimble-colour-by')!.textContent]).toEqual([true, 'Color by:Off'])
  })

  test('`initial` as a field: the view opens colored by it; a name that is none of its fields opens Off', async () => {
    await load()
    const c = mount({ initial: 'channel' })
    await wait()
    expect(c.by).toEqual({ field: 'channel', title: 'Channel' })
    await load()
    const d = mount({ initial: 'speaker' })
    await wait()
    expect([d.off, chips()]).toEqual([true, []])
  })

  test('`initial` as {field, on}: only those values are colored, the others in gray as values turned off; a chip turns one on, and Reset puts back the view as it opens', async () => {
    await load()
    let changed = 0
    const c = mount({ initial: { field: 'kind', on: ['With links'] }, onChange: () => changed++ })
    await wait()
    const barred = () => [...doc().querySelectorAll('[data-thimble-bar]')].map((e) => e.getAttribute('data-anchor'))
    const reset = () => doc().querySelector<HTMLButtonElement>('.thimble-reset')!
    expect(c.by).toEqual({ field: 'kind', title: 'Kind' })
    // every chip shows, only the value it names is on; the records of the others stay, with no bar
    expect(chips()).toEqual([
      ['Text only', '2', 'false'],
      ['With links', '1', 'true'],
      ['No kind', '1', 'false'],
    ])
    expect(barred()).toEqual(['a.jsonl#L2'])
    expect([c.isOn('With links'), c.isOn('Text only'), c.colorOf('Text only'), c.colorOf('With links')]).toEqual([true, false, null, 'var(--label-2)'])
    // a value the records have not shown yet is off too, so its records draw in gray as they come
    expect(c.isOn('Quote')).toBe(false)
    expect(doc().querySelectorAll('.msg')).toHaveLength(4)
    expect(c.query()).toEqual({ field: 'kind' })
    // as the view opens: no Reset, and nothing kept as turned off
    expect(reset().hidden).toBe(true)
    // a chip turns its value on: the view differs from how it opens
    doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[0].click()
    await wait()
    expect(barred()).toEqual(['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3'])
    expect(changed).toBe(1)
    expect(reset().hidden).toBe(false)
    // turned off again, it is as the view opens
    doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[0].click()
    await wait()
    expect(reset().hidden).toBe(true)
    // Alt on Text only keeps it alone; Reset gives back the view's own: With links alone
    doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, altKey: true, detail: 1 }))
    await wait()
    expect(barred()).toEqual(['a.jsonl#L1', 'a.jsonl#L3'])
    expect(reset().hidden).toBe(false)
    reset().click()
    await wait()
    expect(chips().map((x) => x[2])).toEqual(['false', 'true', 'false'])
    expect(barred()).toEqual(['a.jsonl#L2'])
    expect(reset().hidden).toBe(true)
    // another field chosen colors every value of it
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    ;(doc().querySelector('.thimble-colour-menu [data-by="f:channel"]') as HTMLElement).click()
    ;(doc().querySelector('.thimble-colour-menu [data-by="f:kind"]') as HTMLElement).click()
    await wait()
    expect(c.by).toEqual({ field: 'channel', title: 'Channel' })
    expect(c.values.every((v: { on: boolean }) => v.on)).toBe(true)
  })
})

describe('Reset', () => {
  test("shows while a value is off or the row's search field is changed, and puts both back", async () => {
    await load()
    doc().querySelector('.top')!.insertAdjacentHTML('afterbegin', '<input class="field" id="q" type="search">')
    let changed = 0
    let typed = 0
    doc().getElementById('q')!.addEventListener('input', () => typed++)
    const c = mount({ onChange: () => changed++ })
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
    expect(c.by).toEqual({ field: 'kind', title: 'Kind' })
    expect(of('colour').at(-1)!.state).toMatchObject({ off: {} })
    expect(changed).toBe(1)
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

describe("a field's values past the palette's twelve colours", () => {
  test('go under one chip, "Other", which turns them off and on together and says on hover which they are', async () => {
    await load()
    // a page whose records the reader counts: nothing on the page takes a value before
    doc().getElementById('list')!.innerHTML = ''
    const names = Array.from({ length: 15 }, (_, i) => `v${String(i + 1).padStart(2, '0')}`)
    const c = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }], chips: 'filter', initial: 'kind' })
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

})

