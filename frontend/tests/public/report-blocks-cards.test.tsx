// @vitest-environment jsdom
// A report block's kind (src/report/model.ts kindOf, blockOfKind): what the type menu and the slash menu's Turn into
// read and write, and a subheading's level through the save and back. Requests to main: the stream's `card-request`
// record on the bus, and ⌘ while typing (src/lib/agentKey.ts): the tint after ⌘ alone and none for a shortcut or once
// the mouse points, ⌘↵ sending what the focused zone holds instead of the field's own Enter, the `card` event with the
// request's place and a group naming it, and the wait for main's turn to end.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import type { Writeup } from '../../src/lib/types.ts'
import { addAgentZone, askMain, newRequest, TINT_DELAY_MS, tintElement, whenMainIdle } from '../../src/lib/agentKey.ts'
import { BLOCK_KINDS, blockOfKind, blocksFromDoc, editorBlocksFromWire, kindOf, TITLE_ID, wireFromEditor, type EditorBlockLike } from '../../src/report/model.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe("a block's kind", () => {
  test('each kind is the block it makes, and the title, a figure and a prompt have none', () => {
    for (const kind of BLOCK_KINDS) expect(kindOf({ id: 'b1', ...blockOfKind(kind) })).toBe(kind)
    expect(kindOf({ id: 'b1', type: 'heading', props: { level: 4 } })).toBe('subheading')
    expect(kindOf({ id: TITLE_ID, type: 'heading', props: { level: 1 } })).toBeNull()
    expect(kindOf({ id: 'f1', type: 'figure', props: { cell: 'card:x' } })).toBeNull()
    expect(kindOf({ id: 'q1', type: 'prompt', props: { mode: 'card' } })).toBeNull()
  })

  test("a subheading's level goes to the server and comes back", () => {
    const doc = {
      title: 'The gardens',
      sections: [
        { id: 'h1', heading: 'Roses lead', paragraphs: [{ id: 'p1', sentences: [{ id: 's1', text: 'Roses drew four visits.' }] }] },
        { id: 'h2', heading: 'Mornings', level: 3, paragraphs: [{ id: 'p2', sentences: [{ id: 's2', text: 'Most came early.' }] }] },
      ],
    } as unknown as Writeup
    const wire = blocksFromDoc(doc)
    expect(wire.blocks.filter((b) => b.type === 'heading').map((b) => [b.id, b.level])).toEqual([['h1', 2], ['h2', 3]])
    const editor = editorBlocksFromWire(wire)
    expect(editor.find((b) => b.id === 'h2')?.props).toEqual({ level: 3 })
    expect(kindOf(editor.find((b) => b.id === 'h2') as EditorBlockLike)).toBe('subheading')
    // a paragraph the analyst turned into a subheading keeps its id and its text in the save
    const turned = editor.map((b) => (b.id === 'p1' ? { ...b, ...blockOfKind('subheading') } : b)) as EditorBlockLike[]
    const saved = wireFromEditor(turned, new Map())
    expect(saved.blocks.find((b) => b.id === 'p1')).toEqual({ id: 'p1', type: 'heading', text: 'Roses drew four visits.', level: 3 })
  })
})

describe('requests to main', () => {
  test("the stream's card-request record reaches the bus", () => {
    const seen: unknown[] = []
    const off = bus.on('cardRequest', (e) => seen.push(e))
    dispatch({ type: 'card-request', request: 'ab12', card: 'c0ffee12' })
    dispatch({ type: 'card-request', request: 'ab12' })
    off()
    expect(seen).toEqual([{ request: 'ab12', card: 'c0ffee12' }])
    expect(newRequest()).toMatch(/^[a-z0-9]{8,}$/)
  })

  // a zone over a field: ⌘ is Ctrl here, since jsdom's platform is no Mac
  function zone(text = 'a chart of saves per day by kind') {
    const field = document.createElement('textarea')
    field.value = text
    document.body.appendChild(field)
    field.focus()
    const sent: string[] = []
    const off = addAgentZone(field, () => (field.value.trim() ? { tint: tintElement(() => field), send: () => sent.push(field.value) } : null))
    return { field, sent, off }
  }
  const key = (type: 'keydown' | 'keyup', key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init })
    document.activeElement!.dispatchEvent(e)
    return e
  }

  test('⌘ held alone tints the focused text, a shortcut or a pointing mouse does not, and letting go clears it', () => {
    vi.useFakeTimers()
    const { field, off } = zone()
    key('keydown', 'Control', { ctrlKey: true })
    expect(field.hasAttribute('data-agent')).toBe(false)
    vi.advanceTimersByTime(TINT_DELAY_MS + 1)
    expect(field.hasAttribute('data-agent')).toBe(true)
    key('keyup', 'Control')
    expect(field.hasAttribute('data-agent')).toBe(false)
    // Ctrl+C: the tint never shows
    key('keydown', 'Control', { ctrlKey: true })
    key('keydown', 'c', { ctrlKey: true })
    vi.advanceTimersByTime(TINT_DELAY_MS + 1)
    expect(field.hasAttribute('data-agent')).toBe(false)
    key('keyup', 'Control')
    // ⌘ held while the mouse moves is the pointer's
    key('keydown', 'Control', { ctrlKey: true })
    vi.advanceTimersByTime(TINT_DELAY_MS + 1)
    expect(field.hasAttribute('data-agent')).toBe(true)
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 40, ctrlKey: true, bubbles: true }))
    expect(field.hasAttribute('data-agent')).toBe(false)
    key('keyup', 'Control')
    off()
  })

  test("⌘↵ sends what the zone holds, and the field's own Enter never sees it", () => {
    const { field, sent, off } = zone()
    const own = vi.fn()
    field.addEventListener('keydown', own)
    const e = key('keydown', 'Enter', { ctrlKey: true })
    expect(sent).toEqual(['a chart of saves per day by kind'])
    expect(e.defaultPrevented).toBe(true)
    expect(own).not.toHaveBeenCalled()
    // plain Enter is the field's; an empty field sends nothing
    key('keydown', 'Enter')
    expect(own).toHaveBeenCalledTimes(1)
    field.value = ''
    key('keydown', 'Enter', { ctrlKey: true })
    expect(sent).toHaveLength(1)
    off()
    field.value = 'again'
    key('keydown', 'Enter', { ctrlKey: true })
    expect(sent).toHaveLength(1)
  })

  test('a request goes to main as a card event with its place, under a group naming it; its wait ends with main\'s turn', async () => {
    const posts: { url: string; body: any }[] = []
    let running = true
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
        return new Response(JSON.stringify({ id: 'e1', kind: 'card', delivered: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify([{ id: 'main', running }]), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const request = await askMain('gardens', 'Visits per garden, as bars', { doc: 'report', after: 'report:report#pab12' })
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toMatch(/\/ws\/gardens\/events$/)
    expect(posts[0].body).toEqual({ kind: 'card', payload: { text: 'Visits per garden, as bars', group: `request:${request}`, doc: 'report', after: 'report:report#pab12' } })
    await askMain('gardens', 'Sort it by visits', { card: 'c0ffee12' })
    expect(posts[1].body.payload).toMatchObject({ text: 'Sort it by visits', card: 'c0ffee12' })
    vi.useFakeTimers()
    const idle = vi.fn()
    const cancel = whenMainIdle('gardens', idle)
    bus.emit('chat', { chat: 'main' })
    await vi.advanceTimersByTimeAsync(400)
    expect(idle).not.toHaveBeenCalled()
    running = false
    bus.emit('chat', { chat: 'a-thread' })
    await vi.advanceTimersByTimeAsync(400)
    expect(idle).not.toHaveBeenCalled()
    bus.emit('chat', { chat: 'main' })
    await vi.advanceTimersByTimeAsync(400)
    expect(idle).toHaveBeenCalledTimes(1)
    cancel()
  })
})
