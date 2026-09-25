// @vitest-environment jsdom
// What a record of the workspace stream does once, when it is new, and what stays on its item. The first open of the
// stream replays the workspace's whole history, then the server sends `live` (src/lib/events.ts): a record of that
// history raises no toast, no tab dot and opens nothing. A writer's failure shows its toast once and afterwards stays on
// its document until dismissed or written (src/report/writeFailures.ts); a view the analyst asked for opens by itself
// once built, or waits with Open and a dot while they type (src/files/viewReady.ts). Records are invented; the socket
// is a fake EventSource.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { dispatch, isReplay, subscribeWorkspace } from '../../src/lib/events.ts'
import { markOpened, markReady, onBuilt, typingIn, useOpenAskedViews, useReadyViews } from '../../src/files/viewReady.ts'
import { failedDetail, failedText, nextFailures, useWriteFailures, type WriteFailure } from '../../src/report/writeFailures.ts'
import { useTabDots } from '../../src/shell/dots.ts'
import { mount, settle, unmountAll } from './mount.tsx'

class FakeSource {
  static all: FakeSource[] = []
  static CLOSED = 2
  readyState = 0
  listeners: Record<string, (ev: MessageEvent) => void> = {}
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(public url: string) {
    FakeSource.all.push(this)
  }
  addEventListener(name: string, fn: (ev: MessageEvent) => void) {
    this.listeners[name] = fn
  }
  close() {
    this.readyState = FakeSource.CLOSED
  }
  send(name: string, data: object, id = '') {
    this.listeners[name]?.(new MessageEvent(name, { data: JSON.stringify(data), lastEventId: id }))
  }
}

const toasts: { text: string; ref?: string }[] = []
let offToast: () => void

beforeEach(() => {
  FakeSource.all = []
  vi.stubGlobal('EventSource', FakeSource)
  vi.stubGlobal('fetch', async () => {
    throw new Error('no network in tests')
  })
  window.localStorage.clear()
  toasts.length = 0
  offToast = bus.on('toast', (t) => toasts.push(t))
})
afterEach(() => {
  offToast()
  unmountAll()
  vi.unstubAllGlobals()
})

describe('the stream', () => {
  test('a record of the replayed history is a replay until the server says live', () => {
    const seen: [string, boolean][] = []
    const off = bus.on('wsEvent', (ev) => seen.push([String((ev as { status?: string }).status), isReplay()]))
    const release = subscribeWorkspace('ws-replay')
    const src = FakeSource.all[0]
    expect(Object.keys(src.listeners)).toEqual(expect.arrayContaining(['message', 'live']))
    src.send('message', { type: 'report', slug: 'report', status: 'failed', seq: 0 }, '0')
    src.send('live', {})
    src.send('message', { type: 'report', slug: 'report', status: 'generating', seq: 1 }, '1')
    expect(seen).toEqual([
      ['failed', true],
      ['generating', false],
    ])
    expect(isReplay()).toBe(false)
    release()
    off()
  })

  test('a reopen names the log the stream served, and a reset starts the history over and tells the bus', () => {
    vi.useFakeTimers()
    try {
      const resets: string[] = []
      const seen: [string, boolean][] = []
      const offReset = bus.on('wsReset', (e) => resets.push(e.workspace))
      const offEvent = bus.on('wsEvent', (ev) => seen.push([String((ev as { status?: string }).status), isReplay()]))
      const release = subscribeWorkspace('ws-reset')
      const first = FakeSource.all[0]
      expect(Object.keys(first.listeners)).toEqual(expect.arrayContaining(['live', 'reset']))
      first.send('message', { type: 'report', slug: 'report', status: 'generated', seq: 4 }, '4')
      first.send('live', { log: 'log-a' })
      // the server went away: the stream reopens from the last record seen, naming the log it came from
      first.readyState = FakeSource.CLOSED
      first.onerror?.()
      vi.advanceTimersByTime(30_000)
      const second = FakeSource.all[1]
      expect(second.url).toMatch(/\/events\?after=4&log=log-a$/)
      // `/thimble fresh` replaced the log meanwhile: the server says reset and replays the new log as history
      second.send('reset', {})
      second.send('message', { type: 'report', slug: 'report', status: 'generating', seq: 0 }, '0')
      second.send('live', { log: 'log-b' })
      expect(resets).toEqual(['ws-reset'])
      expect(seen).toEqual([
        ['generated', true],
        ['generating', true],
      ])
      release()
      offReset()
      offEvent()
    } finally {
      vi.useRealTimers()
    }
  })

  test('dispatch marks the records it hands out as a replay only while it hands them out', () => {
    const during: boolean[] = []
    const off = bus.on('wsEvent', () => during.push(isReplay()))
    dispatch({ type: 'cell', cell: 'c1' } as never, true)
    dispatch({ type: 'cell', cell: 'c2' } as never)
    off()
    expect(during).toEqual([true, false])
    expect(isReplay()).toBe(false)
  })

  test('the replayed history puts no dot on a tab; a live record does', async () => {
    let dots: Record<string, boolean> = {}
    function Probe() {
      dots = useTabDots(['canvas'])
      return null
    }
    await mount(<Probe />)
    dispatch({ type: 'report', slug: 'report', status: 'generated' } as never, true)
    await settle()
    expect(dots.report).toBe(false)
    dispatch({ type: 'report', slug: 'report', status: 'generated' } as never)
    await settle()
    expect(dots.report).toBe(true)
  })
})

describe("a writer's failure", () => {
  const failed = (seq: number, note = 'The writer stopped at the second section.') => ({ type: 'report', slug: 'story', status: 'failed', note, chat: 'w1', seq })

  test('stands per document until a later write of it starts or is saved', () => {
    let cur = nextFailures({}, failed(4) as never)
    expect(cur.story).toEqual({ slug: 'story', note: 'The writer stopped at the second section.', chat: 'w1', seq: 4 })
    expect(nextFailures(cur, { type: 'report', slug: 'report', status: 'generated' } as never)).toBe(cur)
    expect(nextFailures(cur, { type: 'report', slug: 'story', status: 'edited' } as never)).toBe(cur)
    cur = nextFailures(cur, { type: 'report', slug: 'story', status: 'generating' } as never)
    expect(cur).toEqual({})
    expect(nextFailures(nextFailures({}, failed(5) as never), { type: 'report', slug: 'story', status: 'generated' } as never)).toEqual({})
  })

  test("names an API error as the API error card does, and any other ending in the writer's own words", () => {
    expect(failedText({ slug: 'report', note: 'API Error: Repeated 529 Overloaded errors. The API is at capacity.' })).toBe("The report was not written. Anthropic's API is overloaded (529).")
    expect(failedText({ slug: 'report', note: 'No section was saved.' })).toBe('The report was not written. No section was saved.')
    expect(failedText({ slug: 'report', note: '' })).toBe('The report was not written.')
    // the card's chevron holds the API error line its head names in short; a note the head already holds has none
    expect(failedDetail({ note: 'Stopped. API Error: 529 overloaded_error ' })).toBe('Stopped. API Error: 529 overloaded_error')
    expect(failedDetail({ note: 'No section was saved.' })).toBe('')
  })

  test('shows its toast once, when it happens, never for the history; stays on its document until dismissed', async () => {
    let shown: Record<string, WriteFailure> = {}
    let dismiss: (f: WriteFailure) => void = () => {}
    function Probe() {
      ;({ failures: shown, dismiss } = useWriteFailures('ws-fail'))
      return null
    }
    await mount(<Probe />)
    dispatch(failed(7) as never, true)
    await settle()
    expect(toasts).toEqual([])
    expect(shown.story?.seq).toBe(7)
    dispatch(failed(9, 'No section was saved.') as never)
    await settle()
    expect(toasts.map((t) => t.text)).toEqual(['The story was not written. No section was saved.'])
    expect(shown.story?.seq).toBe(9)
    await settle()
    dismiss(shown.story!)
    await settle()
    expect(shown.story).toBeUndefined()
    // the dismissal names that failure: the same record replayed on the next load stays dismissed, a new one shows
    dispatch(failed(9, 'No section was saved.') as never, true)
    await settle()
    expect(shown.story).toBeUndefined()
    dispatch(failed(12) as never)
    await settle()
    expect(shown.story?.seq).toBe(12)
    dispatch({ type: 'report', slug: 'story', status: 'generating' } as never)
    await settle()
    expect(shown).toEqual({})
  })
})

describe('a view the analyst asked for', () => {
  test('opens once built, as a new record, unless they are typing; the history and unasked views open nothing', () => {
    expect(onBuilt({ status: 'built', asked: true }, false, false)).toBe('open')
    expect(onBuilt({ status: 'built', asked: true }, false, true)).toBe('ready')
    expect(onBuilt({ status: 'built', asked: true }, true, false)).toBeNull()
    expect(onBuilt({ status: 'built' }, false, false)).toBeNull()
    expect(onBuilt({ status: 'building', asked: true }, false, false)).toBeNull()
    const input = document.createElement('textarea')
    // the report's editor: a block inside the contenteditable root has the focus
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const block = editor.appendChild(document.createElement('p'))
    expect([typingIn(input), typingIn(block), typingIn(document.createElement('button')), typingIn(null)]).toEqual([true, true, false, false])
  })

  test('the built record teleports to the view; while a field has the focus it waits as ready with a toast', async () => {
    const opened: string[] = []
    const off = bus.on('openRef', (e) => opened.push(e.ref))
    let ready: readonly string[] = []
    function Probe() {
      useOpenAskedViews('ws-views', new Map([['boards', 'Message boards']]))
      ready = useReadyViews('ws-views')
      return null
    }
    await mount(<Probe />)
    dispatch({ type: 'view', slug: 'boards', status: 'built', asked: true } as never, true)
    dispatch({ type: 'view', slug: 'timeline', status: 'built' } as never)
    expect(opened).toEqual([])
    dispatch({ type: 'view', slug: 'boards', status: 'built', asked: true } as never)
    expect(opened).toEqual(['view:boards'])
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    dispatch({ type: 'view', slug: 'boards', status: 'built', asked: true } as never)
    await settle()
    expect(opened).toEqual(['view:boards'])
    expect(ready).toEqual(['boards'])
    expect(toasts).toEqual([{ text: 'The view Message boards is ready.', ref: 'view:boards' }])
    expect(JSON.parse(window.localStorage.getItem('thimble:ws-views:viewsReady') ?? '[]')).toEqual(['boards'])
    markOpened('ws-views', 'boards')
    await settle()
    expect(ready).toEqual([])
    markReady('ws-views', 'boards')
    dispatch({ type: 'view', slug: 'boards', status: 'deleted' } as never)
    await settle()
    expect(ready).toEqual([])
    off()
  })
})
