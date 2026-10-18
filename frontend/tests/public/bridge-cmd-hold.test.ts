// ⌘ in a view's frame on a Mac (backend/app/viewer_bridge.js pointing), as on the page (src/pointer/CmdPointer.tsx):
// ⌘ points only once it has been held alone for HOLD_MS, a key pressed with it (⌘C) lets go of the pointer until ⌘ is
// released, a ⌘-click still asks, and the page's own ⌘ pointer, which the `cmd` message brings, points at once. Off a
// Mac, Ctrl points at once as before. With ⌥ picked as the ask key in Settings (the `cmd` message's key "alt"), ⌥
// (Alt off a Mac) does all of that in ⌘'s place, and ⌘ (Ctrl) neither points nor asks. Run in a jsdom window of its
// own, its platform set before the bridge loads.
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
})
