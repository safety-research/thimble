// The view kit's record card (backend/app/viewer_colour.js thimble.recordCard), in a jsdom window of its own: the html
// it writes for a record, its text escaped and the page's own markup kept where the page says so, its anchor, and its
// colour, which only Color by gives it (data-colour while a field is the colour, nothing with Off), never a colour of
// the card's own; with several Color by choices, a band per choice that the bridge draws in their order, empty where
// the record has no value or its value's colour is turned off, and the room they take on the root
// (--thimble-bands-w). How the card and its bars look is tests/public/browser/view-card.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const APP = path.resolve(__dirname, '../../../backend/app')
const BRIDGE = readFileSync(path.join(APP, 'viewer_bridge.js'), 'utf8')
const COLOUR = `window.__thimbleLabelOrder = ${readFileSync(path.join(APP, 'label_order.json'), 'utf8')}\n` + readFileSync(path.join(APP, 'viewer_colour.js'), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`

let dom: JSDOM
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any }

/** A page with the bridge and Color by, which starts on what thimble kept for the view (`kept`) when given. */
async function load(kept?: object) {
  dom?.window.close()
  const pre = kept ? script(`window.__thimbleColour = ${JSON.stringify(kept)}`) : ''
  const page = `<!doctype html><html><head>${pre}${script(BRIDGE)}${script(COLOUR)}</head><body><div class="top"><span id="colour"></span></div><div id="col"></div></body></html>`
  dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  dom.window.postMessage = (() => {}) as typeof dom.window.postMessage
  await wait()
}
afterEach(() => dom?.window.close())

/** The card `opts` draws, as an element. */
function card(opts: object): HTMLElement {
  const col = win().document.getElementById('col')!
  col.innerHTML = win().thimble.recordCard(opts)
  return col.firstElementChild as HTMLElement
}

test('a card holds its parts in order, escapes text, keeps {html} and anchors its record', async () => {
  await load()
  const el = card({ ref: 'forge.db#prs/66599', key: '#66599', chips: ['agent-08', ''], title: 'Fix <b>this</b> & that', body: 'one "two"', foot: { html: '<span class="dots">3</span>' } })
  expect(el.className).toBe('thimble-card thimble-card-act')
  expect(el.getAttribute('data-anchor')).toBe('forge.db#prs/66599')
  expect([...el.children].map((c) => c.className)).toEqual(['thimble-card-head', 'thimble-card-title', 'thimble-card-body', 'thimble-card-foot'])
  expect(el.querySelector('.thimble-card-key')!.textContent).toBe('#66599')
  expect([...el.querySelectorAll('.thimble-card-meta .chip')].map((c) => [c.className, c.textContent])).toEqual([['chip chip-sans chip-tone-neutral', 'agent-08']])
  expect(el.querySelector('.thimble-card-title')!.textContent).toBe('Fix <b>this</b> & that')
  expect(el.querySelector('.thimble-card-title b')).toBeNull()
  expect(el.querySelector('.thimble-card-body')!.textContent).toBe('one "two"')
  expect(el.querySelector('.thimble-card-foot .dots')!.textContent).toBe('3')
  // what is not given is left out; no colour, style or stripe of the card's own
  const bare = card({ title: 'Only a title', act: false, active: true, attrs: { 'data-pr': 7, onclick: 'alert(1)', hidden: true, 'bad name': 1 } })
  expect(bare.className).toBe('thimble-card active')
  expect([...bare.children].map((c) => c.className)).toEqual(['thimble-card-title'])
  expect(bare.getAttribute('data-pr')).toBe('7')
  expect(bare.hasAttribute('hidden')).toBe(true)
  expect(bare.hasAttribute('onclick')).toBe(false)
  expect(bare.hasAttribute('data-anchor')).toBe(false)
  // a class the page gives joins the card's, escaped, rather than a second class attribute the parser drops
  const dim = card({ title: 't', attrs: { class: 'still "x"', 'data-n': 3 } })
  expect(dim.className).toBe('thimble-card thimble-card-act still "x"')
  expect(dim.getAttribute('data-n')).toBe('3')
  for (const el2 of [el, bare]) {
    expect(el2.getAttribute('style')).toBeNull()
    expect(el2.innerHTML).not.toMatch(/style=/)
  }
})

test("a card's colour comes from Color by: its field's value while a field is the colour, nothing with Off or with no control", async () => {
  await load()
  const pr = { number: 66599, claimant: 'agent-08' }
  expect(card({ ref: 'forge.db#prs/66599', record: pr, title: 't' }).hasAttribute('data-colour')).toBe(false)
  const colour = win().thimble.colourBy({ mount: '#colour', fields: [{ name: 'claimant', title: 'Claimant' }] })
  await wait()
  expect(card({ ref: 'forge.db#prs/66599', record: pr, title: 't' }).getAttribute('data-colour')).toBe('agent-08')
  expect(card({ ref: 'forge.db#prs/66191', record: { claimant: 'a "q" <b>' }, title: 't' }).getAttribute('data-colour')).toBe('a "q" <b>')
  win().document.querySelector<HTMLElement>('.thimble-colour-by')!.click()
  await wait()
  win().document.querySelector<HTMLElement>('.thimble-colour-menu [data-by="off"]')!.click()
  await wait()
  expect(colour.off).toBe(true)
  expect(card({ ref: 'forge.db#prs/66599', record: pr, title: 't' }).hasAttribute('data-colour')).toBe(false)
})

describe('several Color by choices', () => {
  // three fields, each value in a palette place of its own, so every band's colour says which value drew it
  const FIELDS = [
    { name: 'claimant', title: 'Claimant', values: [{ name: 'agent-08', colour: 1 }, { name: 'agent-21', colour: 2 }] },
    { name: 'state', title: 'State', values: [{ name: 'open', colour: 3 }, { name: 'merged', colour: 5 }] },
    { name: 'kind', title: 'Kind', values: [{ name: 'doc', colour: 7 }, { name: 'bug', colour: 8 }] },
  ]
  const PRS = [
    { ref: 'forge.db#prs/1', claimant: 'agent-08', state: 'open', kind: 'doc' },
    { ref: 'forge.db#prs/2', claimant: 'agent-21', state: 'merged', kind: 'bug' },
    { ref: 'forge.db#prs/3', claimant: '', state: 'open', kind: '' },
  ]
  /** What the bridge draws palette place `k` in here: its token, resolved where the window resolves it (realColour). */
  const place = (k: number) => {
    const doc = win().document
    const i = doc.createElement('i')
    doc.head.appendChild(i)
    i.style.color = `var(--label-${k})`
    const got = win().getComputedStyle(i).color
    i.remove()
    return got && !got.includes('var(') ? got : `var(--label-${k})`
  }
  /** The cards of PRS in the column, drawn as the page draws them on each change of Color by. */
  const draw = () => {
    win().document.getElementById('col')!.innerHTML = PRS.map((pr) => win().thimble.recordCard({ ref: pr.ref, record: pr, key: pr.ref.slice(-1), title: pr.ref })).join('')
  }
  /** Each card's edge as the bridge draws it, by its ref: the bar's slot, or its bands' colours in order ('transparent'
   * for an empty one) as the page's sheet gives them; null for a card with neither. */
  const edges = () => {
    const css = win().document.querySelector('style[data-thimble="labels"]')?.textContent ?? ''
    return Object.fromEntries(
      [...win().document.querySelectorAll('#col .thimble-card')].map((e) => {
        const ref = e.getAttribute('data-anchor')
        const k = e.getAttribute('data-thimble-bands')
        if (k == null) return [ref, e.hasAttribute('data-thimble-bar') ? { edge: e.getAttribute('data-thimble-edge'), bar: true } : null]
        const grad = new RegExp(`\\[data-thimble-bands="${k}"\\]\\{--thimble-bands:linear-gradient\\(to right,(.*?)\\);`).exec(css)?.[1] ?? ''
        const stops = grad.split(/,(?![^(]*\))/)
        return [ref, { edge: e.getAttribute('data-thimble-edge'), bands: stops.filter((_, i) => i % 2 === 0 && i < stops.length - 1).map((x) => x.replace(/ \d+px \d+px$/, '')) }]
      }),
    )
  }
  const room = () => win().document.querySelector('style[data-thimble="bands-room"]')?.textContent ?? null
  const mountWith = async (picks: string[], off: Record<string, string[]> = {}) => {
    await load({ v: 1, by: picks[0], picks, off, seen: [], colours: {} })
    const colour = win().thimble.colourBy({ mount: '#colour', fields: FIELDS, onChange: draw })
    draw()
    await wait(120)
    return colour
  }

  test('one choice: the one bar, its value in data-colour and no track values; no room written', async () => {
    const colour = await mountWith(['f:claimant'])
    expect(colour.picks.map((p: { title: string }) => p.title)).toEqual(['Claimant'])
    const cards = [...win().document.querySelectorAll('#col .thimble-card')]
    expect(cards.map((c) => [c.getAttribute('data-colour'), c.hasAttribute('data-colour-tracks')])).toEqual([['agent-08', false], ['agent-21', false], ['', false]])
    expect(edges()).toEqual({ 'forge.db#prs/1': { edge: 'in', bar: true }, 'forge.db#prs/2': { edge: 'in', bar: true }, 'forge.db#prs/3': null })
    expect(room()).toBeNull()
  })

  test("two and three choices: a band per choice in Color by's order, each in its value's colour of that choice, empty where the card has none", async () => {
    await mountWith(['f:claimant', 'f:state'])
    const first = win().document.querySelector('#col .thimble-card')!
    expect(first.getAttribute('data-colour')).toBe('agent-08')
    expect(JSON.parse(first.getAttribute('data-colour-tracks')!)).toEqual(['open'])
    expect(edges()).toEqual({
      'forge.db#prs/1': { edge: 'bands', bands: [place(1), place(3)] },
      'forge.db#prs/2': { edge: 'bands', bands: [place(2), place(5)] },
      'forge.db#prs/3': { edge: 'bands', bands: ['transparent', place(3)] },
    })
    // the bands' room on the root: two bands of 3 px and a 1 px gap
    expect(room()).toBe(':root{--thimble-bands-w:7px}')

    await mountWith(['f:claimant', 'f:state', 'f:kind'])
    expect(JSON.parse(win().document.querySelector('#col .thimble-card')!.getAttribute('data-colour-tracks')!)).toEqual(['open', 'doc'])
    expect(edges()).toEqual({
      'forge.db#prs/1': { edge: 'bands', bands: [place(1), place(3), place(7)] },
      'forge.db#prs/2': { edge: 'bands', bands: [place(2), place(5), place(8)] },
      'forge.db#prs/3': { edge: 'bands', bands: ['transparent', place(3), 'transparent'] },
    })
    // three bands of 2 px and two gaps
    expect(room()).toBe(':root{--thimble-bands-w:8px}')
    // the order is the choices': State first, then Claimant and Kind
    await mountWith(['f:state', 'f:claimant', 'f:kind'])
    expect(edges()['forge.db#prs/2']).toEqual({ edge: 'bands', bands: [place(5), place(2), place(8)] })
  })

  test("a value's colour turned off leaves its band empty and keeps the card; Off takes every band off and gives the room back", async () => {
    const colour = await mountWith(['f:claimant', 'f:state', 'f:kind'])
    const chip = [...win().document.querySelectorAll<HTMLElement>('.thimble-colour-chip')].find((c) => c.querySelector('.chip-text')!.textContent === 'agent-08')!
    chip.click()
    await wait(120)
    expect(colour.isOn('agent-08')).toBe(false)
    expect(edges()).toEqual({
      'forge.db#prs/1': { edge: 'bands', bands: ['transparent', place(3), place(7)] },
      'forge.db#prs/2': { edge: 'bands', bands: [place(2), place(5), place(8)] },
      'forge.db#prs/3': { edge: 'bands', bands: ['transparent', place(3), 'transparent'] },
    })
    // Color by only colors: the card stays, neither hidden nor dimmed
    const card1 = win().document.querySelector('[data-anchor="forge.db#prs/1"]')!
    expect(card1.hasAttribute('data-thimble-off')).toBe(false)
    expect(card1.hasAttribute('data-thimble-drop')).toBe(false)
    expect(win().document.querySelectorAll('#col .thimble-card')).toHaveLength(3)
    // Off: no bar, no band, no edge, and the room is the one bar's again
    win().document.querySelector<HTMLElement>('.thimble-colour-by')!.click()
    await wait()
    win().document.querySelector<HTMLElement>('.thimble-colour-menu [data-by="off"]')!.click()
    await wait(120)
    expect(win().document.querySelectorAll('#col [data-thimble-bands], #col [data-thimble-bar], #col [data-thimble-edge]')).toHaveLength(0)
    expect(room()).toBe(':root{--thimble-bands-w:3px}')
  })
})
