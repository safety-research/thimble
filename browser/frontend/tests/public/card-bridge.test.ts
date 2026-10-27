// @vitest-environment jsdom
// A custom card's bridge (src/canvas/cardBridge.ts): the card's page runs in a sandboxed frame, and the bridge's script
// first in its head says what the ⌘ pointer does there, as a view's bridge does. On a Mac ⌘ points at the part under the
// pointer once it has been held alone for about 300 ms, or at once while the page's own pointer is on; a ⌘-click asks
// about the part at once and selects no text, the page's bare background asks about the whole card, and a key pressed
// with ⌘ lets go of it. On the page, what the frame says is about the card around the frame, at the frame's box as the
// zoomed canvas draws it. The frame half runs in a jsdom window of its own.
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'
import { bridgeScript, cardBridge, fromCardPage } from '../../src/canvas/cardBridge.ts'
import { toPage } from '../../src/files/ViewerFrame.tsx'
import { bus } from '../../src/lib/bus.ts'
import { HOLD_MS } from '../../src/pointer/CmdPointer.tsx'

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)

/** A card's page with the bridge first in its head, on a Mac or not. */
async function load(body: string, mac = true) {
  const html = `<!doctype html><html><head><script>(${cardBridge.toString()})(${HOLD_MS}, ${mac})</script></head><body>${body}</body></html>`
  dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://card.invalid/' })
  sent = []
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  await wait()
}
afterEach(() => dom?.window.close())

const STATIONS = `<div class="map"><div class="box" id="box"><b id="name">Harbor</b> <small>812 mm</small></div><svg><g id="node" data-part="" data-part-text="North: the wettest station"><rect id="shape" width="40" height="20"></rect><text>North</text></g></svg></div>`
const el = (id: string) => dom.window.document.getElementById(id)!
const key = (type: 'keydown' | 'keyup', k: string, meta: boolean) => dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { key: k, metaKey: meta }))
const mouse = (type: string, at: Element, meta: boolean) => {
  const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, metaKey: meta })
  at.dispatchEvent(e)
  return e
}
const fromPage = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: dom.window.parent as never }))

describe('⌘ in a custom card on a Mac', () => {
  test('points at the part under the pointer once held alone for about 300 ms, and lets go when released', async () => {
    await load(STATIONS)
    mouse('mousemove', el('name'), false)
    key('keydown', 'Meta', true)
    mouse('mousemove', el('name'), true)
    expect(of('point')).toEqual([])
    await wait(HOLD_MS + 50)
    expect(of('point').at(-1)?.rect).toBeTruthy()
    key('keyup', 'Meta', false)
    expect(of('point').at(-1)).toEqual({ type: 'thimble:point', rect: null })
  })

  test('points at once while the page says its own pointer is on', async () => {
    await load(STATIONS)
    fromPage({ type: 'thimble:cmd', on: true, cursor: 'crosshair', key: 'meta' })
    mouse('mousemove', el('shape'), true)
    expect(of('point').at(-1)?.rect).toBeTruthy()
    expect(dom.window.document.documentElement.hasAttribute('data-thimble-cmd')).toBe(true)
  })

  test('a ⌘-click asks at once about the innermost element with text, and does what the page would not', async () => {
    await load(STATIONS)
    let clicked = 0
    el('box').addEventListener('click', () => clicked++)
    const down = mouse('mousedown', el('name'), true)
    const click = mouse('click', el('name'), true)
    expect(of('cite')).toMatchObject([{ text: 'Harbor' }])
    expect([down.defaultPrevented, click.defaultPrevented, clicked]).toEqual([true, true, 0])
  })

  test('a part marked data-part is asked about whole with its own text, and the bare page is the whole card', async () => {
    await load(STATIONS)
    mouse('click', el('shape'), true)
    mouse('click', dom.window.document.body, true)
    expect(of('cite')).toMatchObject([{ text: 'North: the wettest station' }, { card: true }])
  })

  test('a key pressed with ⌘ lets go of the pointer until ⌘ is released', async () => {
    await load(STATIONS)
    key('keydown', 'Meta', true)
    await wait(HOLD_MS + 50)
    mouse('mousemove', el('name'), true)
    expect(of('point').at(-1)?.rect).toBeTruthy()
    key('keydown', 'c', true)
    mouse('mousemove', el('box'), true)
    await wait(HOLD_MS + 50)
    expect(of('point').at(-1)).toEqual({ type: 'thimble:point', rect: null })
  })

  test('a plain click is the page\'s own', async () => {
    await load(STATIONS)
    const click = mouse('click', el('name'), false)
    expect(of('cite')).toEqual([])
    expect(click.defaultPrevented).toBe(false)
  })
})

describe('on the page', () => {
  /** A card on a zoomed board holding a custom card's frame: the frame is 400 px wide and drawn at half that. */
  function card() {
    document.body.innerHTML = '<article data-anchor="card:c1" data-anchor-text="Which station is wettest?"><div class="canvas-card-frame"><iframe class="canvas-card-html"></iframe></div></article>'
    const frame = document.querySelector('iframe')!
    Object.defineProperty(frame, 'offsetWidth', { value: 400 })
    frame.getBoundingClientRect = () => new DOMRect(100, 50, 200, 150)
    return { frame, host: document.querySelector('article')! }
  }

  test("the frame's boxes are the page's, scaled as the canvas draws the frame", () => {
    const { frame } = card()
    expect(toPage(frame, { left: 10, top: 20, width: 40, height: 30 }).toJSON()).toMatchObject({ x: 105, y: 60, width: 20, height: 15 })
  })

  test('a ⌘-click in the frame opens the box about the card with the part, and the bare page about the card itself', () => {
    const { frame, host } = card()
    const at: { anchor: string; text: string; rect: DOMRect }[] = []
    const asked: HTMLElement[] = []
    const offAt = bus.on('pointAt', (e) => void at.push(e))
    const offAsk = bus.on('askAbout', (e) => void asked.push(e.el))
    fromCardPage(frame, { type: 'thimble:cite', text: 'Harbor', element: '', rect: { left: 10, top: 20, width: 40, height: 30 } })
    fromCardPage(frame, { type: 'thimble:cite', card: true })
    offAt()
    offAsk()
    expect(at.map((e) => [e.anchor, e.text, e.rect.x, e.rect.width])).toEqual([['card:c1', 'Harbor', 105, 20]])
    expect(asked).toEqual([host])
  })

  test("the card's page gets the bridge with the page's own hold", () => {
    expect(bridgeScript()).toContain(`(${HOLD_MS},`)
  })
})

// Off a Mac the ask key is Ctrl (lib/platform), and it points at once
describe('Ctrl in a custom card off a Mac', () => {
  const ctrl = (type: 'keydown' | 'keyup', k: string, on: boolean) => dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { key: k, ctrlKey: on }))
  const withCtrl = (type: string, at: Element, on: boolean) => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey: on })
    at.dispatchEvent(e)
    return e
  }

  test('points at the part under the pointer as Ctrl goes down, and lets go when it is released', async () => {
    await load(STATIONS, false)
    withCtrl('mousemove', el('name'), false)
    ctrl('keydown', 'Control', true)
    expect(of('point').at(-1)?.rect).toBeTruthy()
    ctrl('keyup', 'Control', false)
    expect(of('point').at(-1)).toEqual({ type: 'thimble:point', rect: null })
  })

  test("points while the page says its own pointer is on, the page holding the focus", async () => {
    await load(STATIONS, false)
    fromPage({ type: 'thimble:cmd', on: true, cursor: 'crosshair', key: 'meta' })
    withCtrl('mousemove', el('shape'), true)
    expect(of('point').at(-1)?.rect).toBeTruthy()
  })

  test("a Ctrl-click asks about the part at once and selects no text; a plain click is the page's own", async () => {
    await load(STATIONS, false)
    const down = withCtrl('mousedown', el('name'), true)
    const click = withCtrl('click', el('name'), true)
    expect(of('cite')).toMatchObject([{ text: 'Harbor' }])
    expect([down.defaultPrevented, click.defaultPrevented]).toEqual([true, true])
    expect(withCtrl('click', el('name'), false).defaultPrevented).toBe(false)
    expect(of('cite')).toHaveLength(1)
  })

  test('a key pressed with Ctrl lets go of the pointer until Ctrl is pressed again, though the mouse moves with it held', async () => {
    await load(STATIONS, false)
    ctrl('keydown', 'Control', true)
    withCtrl('mousemove', el('name'), true)
    expect(of('point').at(-1)?.rect).toBeTruthy()
    ctrl('keydown', 'c', true)
    withCtrl('mousemove', el('box'), true)
    expect(of('point').at(-1)).toEqual({ type: 'thimble:point', rect: null })
    ctrl('keyup', 'Control', false)
    ctrl('keydown', 'Control', true)
    expect(of('point').at(-1)?.rect).toBeTruthy()
  })
})
