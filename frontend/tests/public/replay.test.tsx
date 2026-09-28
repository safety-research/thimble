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
})
