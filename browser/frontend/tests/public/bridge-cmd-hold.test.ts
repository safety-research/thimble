// ⌘ in a view's frame on a Mac (backend/app/viewer_bridge.js pointing), as on the page (src/pointer/CmdPointer.tsx):
// ⌘ points only once it has been held alone for HOLD_MS, and a ⌘-click still asks; with ⌥ picked as the ask key in
// Settings (the `cmd` message's key "alt"), an ⌥-click on a link in the text asks about its record and does not open
// the link. Run in a jsdom window of its own, its platform set before the bridge loads.
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

  test('a ⌘-click asks at once', async () => {
    await load('MacIntel')
    key('keydown', 'Meta', true)
    click(true)
    expect(of('cite')).toMatchObject([{ ref: 'board.jsonl#L1' }])
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
