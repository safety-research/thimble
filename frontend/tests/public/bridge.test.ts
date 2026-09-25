// The frame half of a view's bridge (backend/app/viewer_bridge.js), which a custom view's page loads first and which
// is the only way the view, sandboxed with no network, talks to thimble. Run in a jsdom window of its own: the bridge
// says it is ready and reports each data-anchor once, including ones the view adds later; window.thimble.fetch posts a
// query and resolves with the page's answer to that id; an `open` reaches every opener, and one registered late gets
// the last; a quoted passage an open brings is found in the page, or said missing; navigate and cite post their refs; and a message from anywhere but the parent page is ignored. A click
// with the pointer's key on an anchored element cites it: ⌘ on a Mac, Ctrl (or the Super key) elsewhere; on a part of
// the view no anchor names (its legend, the bare page) it cites the view itself.
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

/** The view loaded in a fresh window whose browser names `platform` (jsdom names none, which is not a Mac). */
async function load(platform?: string, html = VIEW) {
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://view.invalid/',
    beforeParse: (w) => {
      if (platform) Object.defineProperty(w.navigator, 'platform', { value: platform, configurable: true })
    },
  })
  sent = []
  // a top-level window is its own parent, so the frame's parent.postMessage lands here, before the bridge is ready
  dom.window.postMessage = ((msg: Msg) => void sent.push(msg)) as typeof dom.window.postMessage
  await wait()
}

beforeEach(() => load())
afterEach(() => dom.window.close())

describe('the view bridge', () => {
  test('says it is ready and reports every anchor once', async () => {
    expect(of('ready')).toHaveLength(1)
    expect(of('anchors').flatMap((m) => m.refs as string[]).sort()).toEqual(['board.jsonl#L1', 'board.jsonl#L2', 'view:review-threads/pr-12'])
  })

  test('reports an anchor the view adds later, and not the ones it already reported', async () => {
    const before = of('anchors').length
    const el = dom.window.document.createElement('article')
    el.setAttribute('data-anchor', 'board.jsonl#L3')
    dom.window.document.body.appendChild(el)
    const again = dom.window.document.createElement('article')
    again.setAttribute('data-anchor', 'board.jsonl#L1')
    dom.window.document.body.appendChild(again)
    await wait()
    expect(of('anchors').slice(before).flatMap((m) => m.refs as string[])).toEqual(['board.jsonl#L3'])
  })

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

  test('an open reaches every opener, and an opener registered after it gets the last one', () => {
    const seen: unknown[] = []
    win().thimble.onOpen((p: unknown) => seen.push(['first', p]))
    fromPage({ type: 'thimble:open', open: { locator: 'pr-12' } })
    win().thimble.onOpen((p: unknown) => seen.push(['late', p]))
    expect(seen).toEqual([['first', { locator: 'pr-12' }], ['late', { locator: 'pr-12' }]])
  })

  test('a quoted passage in an open is found in its record with its spaces and case loosened, or said missing', async () => {
    fromPage({ type: 'thimble:open', open: { ref: 'board.jsonl#L2' }, quote: { record: 'board.jsonl#L2', text: 'Second\n  POST' } })
    await wait()
    expect(of('quoted')).toEqual([{ type: 'thimble:quoted', found: true }])
    fromPage({ type: 'thimble:open', open: { ref: 'board.jsonl#L1' }, quote: { record: 'board.jsonl#L1', text: 'a passage the view leaves out' } })
    await wait(400)
    expect(of('quoted'), 'not before the page has been quiet a while').toHaveLength(1)
    await wait(700)
    expect(of('quoted').slice(1)).toEqual([{ type: 'thimble:quoted', found: false }])
  })

  test('a quoted passage the view draws after the open is found once it shows', async () => {
    fromPage({ type: 'thimble:open', open: { ref: 'board.jsonl#L3' }, quote: { record: 'board.jsonl#L3', text: 'the third post' } })
    await wait(300)
    const el = dom.window.document.createElement('article')
    el.setAttribute('data-anchor', 'board.jsonl#L3')
    el.textContent = 'the third post'
    dom.window.document.body.appendChild(el)
    await wait(300)
    expect(of('quoted')).toEqual([{ type: 'thimble:quoted', found: true }])
  })

  test('navigate and cite post the refs the view names', () => {
    win().thimble.navigate('view:review-threads/pr-7')
    win().thimble.cite('board.jsonl#L2', 'the second post', 'post')
    expect(of('navigate')).toEqual([{ type: 'thimble:navigate', ref: 'view:review-threads/pr-7' }])
    expect(of('cite')).toEqual([{ type: 'thimble:cite', ref: 'board.jsonl#L2', text: 'the second post', element: 'post', rect: null }])
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

  test('a media URL is built only from the route the page gave the view, with the path encoded', () => {
    expect(() => win().thimble.mediaUrl('a.png')).toThrow(/without a media route/)
  })

  test('a click with the pointer key cites the anchored element: Ctrl or the Super key off a Mac, ⌘ alone on a Mac', async () => {
    const click = (init: MouseEventInit) => dom.window.document.getElementById('two')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...init }))
    click({})
    expect(of('cite')).toEqual([])
    click({ ctrlKey: true })
    expect(of('cite').map((m) => m.ref)).toEqual(['board.jsonl#L2'])
    click({ metaKey: true })
    expect(of('cite')).toHaveLength(2)
    dom.window.close()
    await load('MacIntel')
    click({ ctrlKey: true })
    expect(of('cite')).toEqual([])
    click({ metaKey: true })
    expect(of('cite').map((m) => m.ref)).toEqual(['board.jsonl#L2'])
  })

  test('the pointer key on a part of the view no anchor names points at the view itself, and cites it', async () => {
    dom.window.close()
    // the page as views.frame_document serves it: the view's name set before the bridge runs
    await load(undefined, VIEW.replace('<head>', '<head><script>window.__thimbleView = {slug: "review-threads", name: "Review threads"}</script>').replace('</section>', '</section><div id="legend" aria-label="legend">open closed</div>'))
    const doc = dom.window.document
    const legend = doc.getElementById('legend')!
    legend.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, ctrlKey: true }))
    expect(of('point').at(-1)?.rect).not.toBeNull()
    legend.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(of('cite').map((m) => [m.ref, m.text, m.element])).toEqual([['view:review-threads', 'open closed', 'legend']])
    // the bare page is the whole view, as much of it as the frame shows
    doc.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(of('cite').at(-1)).toMatchObject({ ref: 'view:review-threads', rect: { left: 0, top: 0 } })
    // an anchored element still cites its own ref
    doc.getElementById('one')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(of('cite').at(-1)?.ref).toBe('board.jsonl#L1')
    // a page loaded without its view's name has nothing to name such a part by
    dom.window.close()
    await load(undefined, VIEW.replace('</section>', '</section><div id="legend">open closed</div>'))
    dom.window.document.getElementById('legend')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(of('cite')).toEqual([])
  })
})
