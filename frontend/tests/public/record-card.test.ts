// The view kit's record card (backend/app/viewer_colour.js thimble.recordCard), in a jsdom window of its own: the html
// it writes for a record, its text escaped and the page's own markup kept where the page says so, its anchor, and its
// colour, which only Color by gives it (data-colour while a field is the colour, nothing with Off), never a colour of
// the card's own. How the card and its bar look is tests/public/browser/view-card.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, expect, test } from 'vitest'

const APP = path.resolve(__dirname, '../../../backend/app')
const BRIDGE = readFileSync(path.join(APP, 'viewer_bridge.js'), 'utf8')
const COLOUR = `window.__thimbleLabelOrder = ${readFileSync(path.join(APP, 'label_order.json'), 'utf8')}\n` + readFileSync(path.join(APP, 'viewer_colour.js'), 'utf8')
const script = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`

let dom: JSDOM
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any }

async function load() {
  const page = `<!doctype html><html><head>${script(BRIDGE)}${script(COLOUR)}</head><body><div class="top"><span id="colour"></span></div><div id="col"></div></body></html>`
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
