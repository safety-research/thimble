// ⌘ in a view's frame on a Mac (backend/app/viewer_bridge.js pointing), as on the page (src/pointer/CmdPointer.tsx):
// ⌘ points only once it has been held alone for HOLD_MS, a key pressed with it (⌘C) lets go of the pointer until ⌘ is
// released, a ⌘-click still asks, and the page's own ⌘ pointer, which the `cmd` message brings, points at once. Off a
// Mac, Ctrl points at once as before. With ⌥ picked as the ask key in Settings (the `cmd` message's key "alt"), ⌥
// (Alt off a Mac) does all of that in ⌘'s place, and ⌘ (Ctrl) neither points nor asks. Run in a jsdom window of its
// own, its platform set before the bridge loads. A tester: "the command key for most ppl is for copy pasting".
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const BRIDGE = readFileSync(path.resolve(__dirname, '../../../backend/app/viewer_bridge.js'), 'utf8')
// the kit's formatted text, with what it needs loaded before it as views.frame_document loads them
const KIT = ['viewer_colour.js', 'viewer_controls.js', 'viewer_text.js'].map((f) => readFileSync(path.resolve(__dirname, '../../../backend/app', f), 'utf8'))
const page = (platform: string) => `<!doctype html><html><head><script>Object.defineProperty(navigator, 'platform', { get: () => '${platform}' })</script><script>${BRIDGE.replace(/<\/script/gi, '<\\/script')}</script></head><body>
<section data-anchor="view:board">
  <article id="one" data-anchor="board.jsonl#L1">the first post</article>
</section>
</body></html>`

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)
/** the rects the frame reported last for what ⌘ points at (null: nothing) */
const lastPoint = () => of('point').at(-1)?.rect ?? null

async function load(platform: string) {
  dom = new JSDOM(page(platform), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  sent = []
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  await wait()
}
afterEach(() => dom?.window.close())

const one = () => dom.window.document.getElementById('one')!
const key = (type: 'keydown' | 'keyup', k: string, meta: boolean) => dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { key: k, metaKey: meta, ctrlKey: k === 'Control' && type === 'keydown' }))
const move = (meta: boolean, ctrl = false) => one().dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, metaKey: meta, ctrlKey: ctrl }))
const click = (meta: boolean) => one().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: meta }))

describe('on a Mac', () => {
  test('⌘ points only once it has been held alone for about 300 ms, at what the pointer is over', async () => {
    await load('MacIntel')
    move(false)
    key('keydown', 'Meta', true)
    move(true)
    expect(lastPoint()).toBeNull()
    await wait(350)
    expect(lastPoint()).not.toBeNull()
    key('keyup', 'Meta', false)
    expect(lastPoint()).toBeNull()
  })

  test('a key pressed with ⌘ lets go of the pointer until ⌘ is released', async () => {
    await load('MacIntel')
    key('keydown', 'Meta', true)
    await wait(350)
    move(true)
    expect(lastPoint()).not.toBeNull()
    key('keydown', 'c', true)
    expect(lastPoint()).toBeNull()
    await wait(350)
    move(true)
    expect(lastPoint()).toBeNull()
    key('keyup', 'c', true)
    move(true)
    expect(lastPoint()).toBeNull()
    key('keyup', 'Meta', false)
    key('keydown', 'Meta', true)
    await wait(350)
    move(true)
    expect(lastPoint()).not.toBeNull()
  })

  test('a key pressed before ⌘ has been held long enough keeps the pointer off', async () => {
    await load('MacIntel')
    key('keydown', 'Meta', true)
    key('keydown', 'v', true)
    await wait(350)
    move(true)
    expect(lastPoint()).toBeNull()
  })

  test('a ⌘-click asks at once', async () => {
    await load('MacIntel')
    key('keydown', 'Meta', true)
    click(true)
    expect(of('cite')).toMatchObject([{ ref: 'board.jsonl#L1' }])
  })

  test("the page's ⌘ pointer points at once", async () => {
    await load('MacIntel')
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'thimble:cmd', on: true, cursor: 'default' }, source: dom.window.parent as never }))
    move(true)
    expect(lastPoint()).not.toBeNull()
  })
})

describe('off a Mac', () => {
  test('Ctrl points at once', async () => {
    await load('Linux x86_64')
    key('keydown', 'Control', false)
    move(false, true)
    expect(lastPoint()).not.toBeNull()
  })
})

describe('with ⌥ picked as the ask key', () => {
  type Mods = { metaKey?: boolean; altKey?: boolean; ctrlKey?: boolean }
  const askAlt = () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'thimble:cmd', on: false, cursor: 'default', key: 'alt' }, source: dom.window.parent as never }))
  const press = (type: 'keydown' | 'keyup', k: string, mods: Mods) => dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { key: k, ...mods }))
  const over = (mods: Mods) => one().dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, ...mods }))
  const tap = (mods: Mods) => one().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...mods }))

  test('on a Mac ⌥ held alone points after about 300 ms, a key pressed with it lets go, and ⌥-click asks', async () => {
    await load('MacIntel')
    askAlt()
    over({})
    press('keydown', 'Alt', { altKey: true })
    over({ altKey: true })
    expect(lastPoint()).toBeNull()
    await wait(350)
    expect(lastPoint()).not.toBeNull()
    press('keydown', 'e', { altKey: true })
    expect(lastPoint()).toBeNull()
    press('keyup', 'e', { altKey: true })
    press('keyup', 'Alt', {})
    tap({ altKey: true })
    expect(of('cite')).toMatchObject([{ ref: 'board.jsonl#L1' }])
  })

  test('on a Mac ⌘ neither points nor asks', async () => {
    await load('MacIntel')
    askAlt()
    press('keydown', 'Meta', { metaKey: true })
    await wait(350)
    over({ metaKey: true })
    expect(lastPoint()).toBeNull()
    tap({ metaKey: true })
    expect(of('cite')).toEqual([])
  })

  test('off a Mac Alt points at once and Ctrl does not', async () => {
    await load('Linux x86_64')
    askAlt()
    press('keydown', 'Control', { ctrlKey: true })
    over({ ctrlKey: true })
    expect(lastPoint()).toBeNull()
    press('keyup', 'Control', {})
    press('keydown', 'Alt', { altKey: true })
    over({ altKey: true })
    expect(lastPoint()).not.toBeNull()
  })
})

describe("the kit's formatted text with ⌥ picked as the ask key", () => {
  test('an ⌥-click on a link in the text asks about its record and does not open the link; a plain click opens it', async () => {
    const html = `<!doctype html><html><head><script>${BRIDGE.replace(/<\/script/gi, '<\\/script')}</script>${KIT.map((k) => `<script>${k.replace(/<\/script/gi, '<\\/script')}</script>`).join('')}</head><body>
<article data-anchor="board.jsonl#L1"><div class="thimble-text"><a id="link" class="thimble-text-ref" data-thimble-ref="view:other" role="link" tabindex="0">the other view</a></div></article>
</body></html>`
    dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
    sent = []
    dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
    await wait()
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'thimble:cmd', on: false, cursor: 'default', key: 'alt' }, source: dom.window.parent as never }))
    const link = dom.window.document.getElementById('link')!
    link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }))
    expect(of('cite')).toMatchObject([{ ref: 'board.jsonl#L1' }])
    expect(of('navigate')).toEqual([])
    link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(of('navigate')).toMatchObject([{ ref: 'view:other' }])
  })
})
