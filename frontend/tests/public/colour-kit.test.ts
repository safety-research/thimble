// The view kit's Colour by (backend/app/viewer_colour.js, thimble.colourBy) and what it needs of the bridge
// (backend/app/viewer_bridge.js), in a jsdom window of their own: one menu lists the view's fields and every label, the
// chosen field's values are chips with their counts that turn a value off and on, the bridge draws the chosen value's
// bar and hides or dims what is off, a label the analyst turns on takes the colour, and the choice is kept through the
// `colour` message and handed back as window.__thimbleColour. The marks the page hands over name each label's value
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
const COLOUR = readFileSync(path.join(APP, 'viewer_colour.js'), 'utf8')
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
 * row; `kept` is what thimble kept for the view (window.__thimbleColour). */
async function load(kept?: object, field: 'kind' | 'channel' = 'kind') {
  const rows = ROWS.map(([ref, kind, channel]) => `<div class="msg" data-anchor="${ref}" data-colour="${field === 'kind' ? kind : channel}">${ref}</div>`).join('')
  const page = `<!doctype html><html><head>${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${script(BRIDGE)}${script(COLOUR)}</head><body><div class="top"><span id="colour"></span></div><div id="list">${rows}</div></body></html>`
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

  test('a chip turns its value off and on; a filter hides its records, a highlight dims them; Alt keeps it alone', async () => {
    await load()
    const c = mount({ chips: 'filter' })
    await wait()
    const chip = (i: number) => doc().querySelectorAll<HTMLElement>('.thimble-colour-chip')[i]
    chip(0).click()
    await wait()
    expect(chips()[0][2]).toBe('false')
    expect(c.isOn('Text only')).toBe(false)
    expect(c.keeps({ kind: 'Text only' })).toBe(false)
    expect([...doc().querySelectorAll('[data-thimble-off="hide"]')].map((e) => e.getAttribute('data-anchor'))).toEqual(['a.jsonl#L1', 'a.jsonl#L3'])
    expect(c.query()).toEqual({ field: 'kind', off: ['Text only'] })
    chip(0).click()
    await wait()
    expect(doc().querySelectorAll('[data-thimble-off]')).toHaveLength(0)
    chip(2).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, altKey: true, detail: 1 }))
    await wait()
    expect(chips().map((x) => x[2])).toEqual(['false', 'false', 'true'])
    expect(c.query()).toEqual({ field: 'kind', off: ['Text only', 'With links'] })
    await load()
    mount()
    await wait()
    chip(1).click()
    await wait()
    expect(doc().querySelector('[data-anchor="a.jsonl#L2"]')!.getAttribute('data-thimble-off')).toBe('dim')
  })

  test('one menu lists the fields and every label, each label with its switch; a field picked colours by it', async () => {
    await load()
    let changed = 0
    const c = mount({ onChange: () => changed++ })
    labels(false)
    await wait()
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    const menu = doc().querySelector('.thimble-colour-menu')!
    expect([...menu.querySelectorAll('.thimble-colour-head')].map((h) => h.textContent)).toEqual(['Color by', 'Labels over these files'])
    expect([...menu.querySelectorAll('.thimble-colour-item .thimble-colour-nm')].map((n) => n.textContent)).toEqual(['Off', 'Kind', 'Channel', 'Deadline', 'New label'])
    expect(menu.querySelector('[data-switch="k1"]')!.getAttribute('data-label')).toBe('k1')
    ;(menu.querySelector('[data-by="f:channel"]') as HTMLElement).click()
    await wait()
    expect(doc().querySelector('.thimble-colour-menu')).toBeNull()
    expect(c.by).toEqual({ field: 'channel', title: 'Channel' })
    expect(changed).toBe(1)
    expect(c.attr({ channel: 'ops' })).toBe(' data-colour="ops"')
    expect(of('colour').at(-1)!.state).toMatchObject({ by: 'f:channel', field: 'channel' })
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
    expect(c.query()).toEqual({ label: 'k1', name: 'Deadline', off: [] })
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
    // the kinds the page drew for Kind are no values of Channel: they are taken off the page until it draws again
    expect(doc().querySelectorAll('.msg[data-colour]')).toHaveLength(0)
    c.counts([['wiki', 40], ['ops', 7], ['press', 90]])
    await wait()
    expect(chips().map((x) => x[0])).toEqual(['press', 'wiki', 'ops'])
    expect(of('colour').at(-1)!.state).toMatchObject({ colours: { channel: { press: 0, wiki: 1, ops: 2 } } })
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

describe("a label's definition", () => {
  const DEF = { id: 'k1', name: 'Deadline', kind: 'prompt', text: 'Does it set a deadline? deadline = it names a time to post by.', spec: '', scope: 'a.jsonl', unit: 'record', labeled: 4, values: [{ name: 'deadline', highlight: true, n: 1, meaning: 'it names a time to post by' }, { name: 'other', highlight: false, n: 3, meaning: '' }] }
  const answer = async () => {
    await wait(20)
    const f = of('fetch').at(-1)!
    expect(f.query).toEqual({ $thimble: 'label', id: 'k1' })
    fromPage({ type: 'thimble:result', id: f.id, data: DEF })
    await wait()
  }
  test("opens in place under the label's row in the menu, and from the button beside Color by while the label is the colour", async () => {
    await load()
    mount()
    labels(false)
    await wait()
    ;(doc().querySelector('.thimble-colour-by') as HTMLElement).click()
    ;(doc().querySelector('.thimble-colour-menu [data-info="k1"]') as HTMLElement).click()
    await answer()
    const def = doc().querySelector('.thimble-colour-menu .thimble-def')!
    expect(def.textContent).toContain('Does it set a deadline?')
    expect([...def.querySelectorAll('.thimble-def-vn')].map((v) => v.textContent)).toEqual(['deadline', 'other'])
    expect(def.querySelector('.thimble-def-m')!.textContent).toBe('it names a time to post by')
    expect(def.querySelector('[data-open-label="k1"]')!.textContent).toBe('Open label')
    expect(doc().querySelector('.thimble-colour-menu')).not.toBeNull()
    ;(doc().querySelector('.thimble-colour-menu [data-info="k1"]') as HTMLElement).click()
    expect(doc().querySelector('.thimble-colour-menu .thimble-def')).toBeNull()
    // the label as the colour: one click on the button beside Color by
    doc().body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
    labels(true, { 'a.jsonl#L2': { bar: '#025ac3', names: ['Deadline'], values: [{ id: 'k1', label: 'Deadline', value: 'deadline', colour: '#025ac3' }], spans: [] } })
    await wait()
    const about = doc().querySelector<HTMLElement>('.thimble-colour-about')!
    expect(about.getAttribute('data-label')).toBe('k1')
    about.click()
    await wait()
    expect(doc().querySelector('.thimble-colour-defpop .thimble-def')!.textContent).toContain('it names a time to post by')
    ;(doc().querySelector('.thimble-colour-defpop [data-open-label]') as HTMLElement).click()
    await wait()
    expect(of('labelCall').length + of('labelRefused').length).toBeGreaterThanOrEqual(0)
    expect(doc().querySelector('.thimble-colour-defpop')).toBeNull()
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
