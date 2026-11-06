// The frame half of a view's bridge (backend/app/viewer_bridge.js), which a custom view's page loads first and which is
// the only way the view, sandboxed with no network, talks to thimble. Run in a jsdom window of its own:
// window.thimble.fetch posts a query and resolves with the page's answer to that id; a message from anywhere but the
// parent page is ignored; and a label call with no gesture of the analyst's in the frame is refused there, the key for
// label calls reaching the bridge alone.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const BRIDGE = readFileSync(path.resolve(__dirname, '../../../backend/app/viewer_bridge.js'), 'utf8')
const VIEW = `<!doctype html><html><head><script>${BRIDGE.replace(/<\/script/gi, '<\\/script')}</script></head><body>
<section data-anchor="view:review-threads/pr-12">
  <article id="one" data-anchor="board.jsonl#L1">the first post</article>
  <article id="two" data-anchor="board.jsonl#L2">the second post</article>
</section>
</body></html>`

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
let sent: Msg[]

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any }
/** A message from the page to the frame, as the page's postMessage delivers it (its source is the parent). */
const fromPage = (data: object, source: unknown = win().parent) => win().dispatchEvent(new dom.window.MessageEvent('message', { data, source: source as any }))
const of = (type: string) => sent.filter((m) => m.type === `thimble:${type}`)

/** The view loaded in a fresh window. */
async function load() {
  dom = new JSDOM(VIEW, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  sent = []
  // a top-level window is its own parent, so the frame's parent.postMessage lands here, before the bridge is ready
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  await wait()
}

beforeEach(() => load())
afterEach(() => dom.window.close())

describe('the view bridge', () => {
  test('fetch posts its query and resolves with the answer to its id; an error answer rejects', async () => {
    const got = win().thimble.fetch({ page: 2 })
    const bad = win().thimble.fetch('boom')
    const [q1, q2] = of('fetch')
    expect(q1).toMatchObject({ query: { page: 2 } })
    expect(q2).toMatchObject({ query: 'boom' })
    expect(q1.id).not.toBe(q2.id)
    fromPage({ type: 'thimble:result', id: q2.id, error: 'no such page' })
    fromPage({ type: 'thimble:result', id: q1.id, data: [{ n: 1 }] })
    await expect(got).resolves.toEqual([{ n: 1 }])
    await expect(bad).rejects.toThrow('no such page')
  })

  test('a message from anything but the parent page is ignored', async () => {
    const got = win().thimble.fetch({ page: 1 })
    const [q] = of('fetch')
    const seen: unknown[] = []
    win().thimble.onOpen((p: unknown) => seen.push(p))
    fromPage({ type: 'thimble:open', open: { locator: 'forged' } }, null)
    fromPage({ type: 'thimble:result', id: q.id, data: 'forged' }, null)
    fromPage({ type: 'thimble:result', id: q.id, data: 'real' })
    expect(seen).toEqual([])
    await expect(got).resolves.toBe('real')
  })

  test('a label call with no gesture of the analyst in the frame is refused there, and the key for it reaches the bridge alone', async () => {
    const heard: string[] = []
    win().addEventListener('message', (e: MessageEvent) => heard.push(e.data?.type), true)
    win().addEventListener('message', (e: MessageEvent) => heard.push(e.data?.type))
    fromPage({ type: 'thimble:key', key: 'k-1' })
    fromPage({ type: 'thimble:open', open: { ref: null } })
    // the view's own listeners, capturing or not, hear the open and never the key
    expect(heard).toEqual(['thimble:open', 'thimble:open'])
    const got = win().thimble.setLabel('asks', true)
    const marked = win().thimble.mark('board.jsonl#L1', 'asks', 'yes')
    await expect(got).rejects.toMatchObject({ thimbleRefused: true, message: 'thimble changes labels only while the analyst clicks or types in the view' })
    await expect(marked).rejects.toMatchObject({ thimbleRefused: true })
    expect(of('labelCall')).toEqual([])
    expect(of('labelRefused').map((m) => m.op)).toEqual(['on', 'mark'])
  })
})
