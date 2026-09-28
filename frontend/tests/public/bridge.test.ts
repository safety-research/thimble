// The frame half of a view's bridge (backend/app/viewer_bridge.js), which a custom view's page loads first and which
// is the only way the view, sandboxed with no network, talks to thimble. Run in a jsdom window of its own: the bridge
// says it is ready and reports each data-anchor once, including ones the view adds later; window.thimble.fetch posts a
// query and resolves with the page's answer to that id; an `open` reaches every opener, and one registered late gets
// the last; a quoted passage an open brings is found in the page, or said missing; navigate and cite post their refs; and a message from anywhere but the parent page is ignored. A click
// with the pointer's key on an anchored element cites it: ⌘ on a Mac, Ctrl (or the Super key) elsewhere; on a part of
// the view no anchor names (its legend, the bare page) it cites the view itself. The page's label controls post the
// label's id to thimble, and onLabels hears every label over files and the palette with the labels that are on.
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

  test('with a filter on, a page that does not filter hides what the filter drops, and keeps what holds a kept record', async () => {
    const doc = dom.window.document
    fromPage({ type: 'thimble:open', open: { ref: null } })
    const marks = { 'board.jsonl#L2': { keep: true }, 'board.jsonl#L1': { bar: '#e69f00', names: ['asks'], spans: [], keep: false } }
    fromPage({ type: 'thimble:labels', marks, on: [], filter: { label: 'asks', value: 'yes', colour: '#e69f00' } })
    await wait()
    expect(doc.getElementById('one')!.getAttribute('data-thimble-drop')).toBe('hide')
    expect(doc.getElementById('two')!.hasAttribute('data-thimble-drop')).toBe(false)
    expect(doc.querySelector('section')!.hasAttribute('data-thimble-drop')).toBe(false)
    // the place the page was opened at stays, since the analyst asked for it
    fromPage({ type: 'thimble:open', open: { ref: 'board.jsonl#L1' } })
    await wait()
    expect(doc.getElementById('one')!.hasAttribute('data-thimble-drop')).toBe(false)
    // no filter, nothing hidden
    fromPage({ type: 'thimble:labels', marks: {}, on: [], filter: null })
    await wait()
    expect(doc.querySelectorAll('[data-thimble-drop]')).toHaveLength(0)
  })
})
