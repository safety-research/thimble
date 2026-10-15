// ⌘ in a view's frame on a Mac (backend/app/viewer_bridge.js pointing), as on the page (src/pointer/CmdPointer.tsx):
// ⌘ points only once it has been held alone for HOLD_MS, a key pressed with it (⌘C) lets go of the pointer until ⌘ is
// released, a ⌘-click still asks, and the page's own ⌘ pointer, which the `cmd` message brings, points at once. Off a
// Mac, Ctrl points at once as before. Run in a jsdom window of its own, its platform set before the bridge loads. A
// tester: "the command key for most ppl is for copy pasting".
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const BRIDGE = readFileSync(path.resolve(__dirname, '../../../backend/app/viewer_bridge.js'), 'utf8')
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
