// @vitest-environment jsdom
// thimble fix in the page (src/chat/fix.ts, src/chat/FixStrip.tsx, backend fixes.py): how a fix ended is a row of the
// chat. The newest row of a fix that passed its checks asks, and Use it now (the person's click) puts it on: the row
// says "Reloading thimble…", then, with the server back, what it said, with nothing left to ask. While the restart
// waits for a running turn, the row says whose. The page asks the server whether it started again, so it does not wait
// for its stream to open again: it then loads the new build, once, or, where that would lose typed text, the row offers
// Reload. A fix that is on offers Undo. Your fixes says why a fix is off when the server says.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FixRow } from '../../src/chat/fix.ts'
import { FixPage, FixResult } from '../../src/chat/FixStrip.tsx'
import { bus } from '../../src/lib/bus.ts'
import { thisBuild } from '../../src/lib/chunkRecovery.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const row = (over: Partial<FixRow> = {}): FixRow => ({ id: 3, title: 'Card says how many rows', state: 'on', phase: null, kind: 'fixed', said: 'Card says how many rows is on', words: "make this card's title say how many rows", summary: "The card's title ends with its row count.", files: 2, tests: 'passed', error: null, at: 1, ...over })
const SAID = 'thimble fixed: Card says how many rows · tests pass'
const ready = (over: Partial<FixRow> = {}) => row({ state: 'ready', kind: 'ready', said: SAID, ...over })

/** What GET /fixes answers and how often the page read it, what GET /health says of the server (null while it is down)
 * and how often the page asked it, and each request that changes state. */
let fixes: FixRow[] = []
let reads = 0
let server: { boot: string; ui: string } | null = null
let asked = 0
let sent: string[] = []
beforeEach(() => {
  fixes = []
  reads = 0
  server = { boot: 'b1', ui: 'u1' }
  asked = 0
  sent = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const u = String(url)
    const list = /\/fixes(\?every=true)?$/.test(u) && method === 'GET'
    if (list) reads++
    if (/\/health$/.test(u)) asked++
    if (!server) throw new TypeError('Failed to fetch')
    if (method !== 'GET') sent.push(`${method} ${u.replace(/^.*\/api/, '')}`)
    const body = list ? { problem: '', fixes } : /\/health$/.test(u) ? { ok: true, ...server } : { ok: true, restart: true }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

/** A tab that loaded the build the server serves now, on the test's clock: what counts its reloads. */
async function tab() {
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  await thisBuild()
  vi.useFakeTimers()
  return reload
}
/** The page `ms` later. */
const later = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

test('a fix that passed asks, and Use it now puts it on; a fix that is on offers Undo', async () => {
  fixes = [ready()]
  const el = await mount(<FixResult ws="mini" fid={3} text={SAID} kind="ready" latest />)
  await settle()
  expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Use it now', 'What changed', 'Later'])
  fixes = [ready({ phase: 'applying', kind: null, said: null })]
  await click(button(el, 'Use it now'))
  await settle()
  expect(sent).toEqual(['POST /fixes/3/apply'])
  expect(el.querySelector('.chat-fix-text')?.textContent).toBe('Reloading thimble…')
  // the server is back with the fix on: the row says what it said, and asks nothing more
  fixes = []
  await act(async () => bus.emit('wsStream', { connected: true } as never))
  await settle()
  expect(el.querySelector('.chat-fix-said')?.textContent).toBe(SAID)
  expect(el.querySelector('button')).toBeNull()
  unmountAll()

  fixes = [row()]
  const on = await mount(<FixResult ws="mini" fid={3} text="Card says how many rows is on" kind="fixed" latest />)
  await settle()
  await click(button(on, 'Undo'))
  expect(sent).toEqual(['POST /fixes/3/apply', 'POST /fixes/3/undo'])
})

test('a fix that went on in the terminal asks the same while it is off here: Use it now starts the server again with it, and Later asks no more', async () => {
  const away = (over: Partial<FixRow> = {}) => ready({ state: 'off', why: 'the workbench started before it went on', ...over })
  fixes = [away()]
  const el = await mount(<FixResult ws="mini" fid={3} text={SAID} kind="ready" latest />)
  await settle()
  expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Use it now', 'What changed', 'Later'])
  await click(button(el, 'What changed'))
  expect(el.querySelector('.chat-fix-what')?.textContent).toContain("You asked:make this card's title say how many rows")
  fixes = [away({ phase: 'applying', kind: null, said: null })]
  await click(button(el, 'Use it now'))
  await settle()
  expect(sent).toEqual(['POST /fixes/3/apply'])
  expect(el.querySelector('.chat-fix-text')?.textContent).toBe('Reloading thimble…')
  unmountAll()

  fixes = [away()]
  const later = await mount(<FixResult ws="mini" fid={3} text={SAID} kind="ready" latest />)
  await settle()
  fixes = []
  await click(button(later, 'Later'))
  await settle()
  expect(sent).toEqual(['POST /fixes/3/apply', 'POST /fixes/3/dismiss'])
  expect(later.querySelector('.chat-fix-said')?.textContent).toBe(SAID)
  expect(later.querySelector('button')).toBeNull()
})

test('while the restart waits for a running turn, the row says whose turn, and where in another workspace', async () => {
  const waiting = (waits: FixRow['waits']) => [ready({ phase: 'restarting', kind: null, said: null, waits })]
  const moved = () => act(async () => bus.emit('fix', { id: 3, state: 'restarting' }))
  fixes = waiting({ workspace: 'mini', name: 'main' })
  const el = await mount(<FixResult ws="mini" fid={3} text={SAID} kind="ready" latest />)
  await settle()
  const said = () => el.querySelector('[data-kind="reloading"] .chat-fix-text')?.textContent
  expect(said()).toBe('Reloading thimble when main finishes…')
  fixes = waiting({ workspace: 'other', name: 'main/why-the-spike' })
  await moved()
  await settle()
  expect(said()).toBe('Reloading thimble when main/why-the-spike in other finishes…')
  // nothing runs any more: the server starts again
  fixes = waiting(null)
  await moved()
  await settle()
  expect(said()).toBe('Reloading thimble…')
  expect(el.querySelector('button')).toBeNull()
})

test('the rows of a page read the fixes together: one read when they show, and one for each event', async () => {
  fixes = [ready()]
  const el = await mount(
    <>
      <FixPage />
      <FixResult ws="mini" fid={3} text="Claude works on it" latest={false} />
      <FixResult ws="mini" fid={3} text={SAID} kind="ready" latest />
    </>,
  )
  await settle()
  expect(reads).toBe(1)
  expect(button(el, 'Use it now')).toBeTruthy()
  // each event is read once, after it: the row shows what the server says then
  fixes = [ready({ phase: 'restarting', kind: null, said: null, waits: { workspace: 'mini', name: 'main' } })]
  await act(async () => bus.emit('fix', { id: 3, state: 'restarting' }))
  await settle()
  fixes = [ready({ phase: 'restarting', kind: null, said: null })]
  await act(async () => bus.emit('fix', { id: 3, state: 'restarting' }))
  await settle()
  expect(reads).toBe(3)
  expect(el.querySelector('[data-kind="reloading"] .chat-fix-text')?.textContent).toBe('Reloading thimble…')
})

test('the page asks the server whether it started again, and loads its new build once when it has', async () => {
  const reload = await tab()
  fixes = [ready({ phase: 'restarting', kind: null, said: null })]
  const el = await mount(
    <>
      <FixPage />
      <FixResult ws="mini" fid={3} text={SAID} kind="ready" latest />
    </>,
  )
  await later(1000)
  // the server goes down, and no answer is not yet the new server
  server = null
  await later(1000)
  expect(reload).not.toHaveBeenCalled()
  // it is back, with the fix on and another build of the page
  server = { boot: 'b2', ui: 'u2' }
  fixes = []
  await later(1000)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(el.querySelector('[data-kind="reloading"] .chat-fix-text')?.textContent).toBe('Reloading thimble…')
  // the stream opens again only later: the page asked for its reload already, and asks the server no more
  const before = asked
  await act(async () => bus.emit('wsStream', { connected: true } as never))
  await later(5000)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(asked).toBe(before)
})

test('the page that found the new server keeps what is typed: the row says how the fix ended, or offers Reload for a new build', async () => {
  const reload = await tab()
  fixes = [ready({ phase: 'restarting', kind: null, said: null })]
  const el = await mount(
    <>
      <FixPage />
      <FixResult ws="mini" fid={3} text={SAID} kind="ready" latest />
      <textarea defaultValue="why did the run fail" />
    </>,
  )
  await later(1000)
  // the server is back with the fix on, and serves the page this tab has: the row says what it said
  server = { boot: 'b2', ui: 'u1' }
  fixes = []
  await later(1000)
  expect(el.querySelector('.chat-fix-said')?.textContent).toBe(SAID)
  // Undo: the server starts again, and now it serves another build of the page
  fixes = [row({ phase: 'restarting', kind: null, said: null })]
  await act(async () => bus.emit('fix', { id: 3, state: 'restarting' }))
  await later(1000)
  server = { boot: 'b3', ui: 'u2' }
  fixes = []
  await later(1000)
  expect(el.querySelector('[data-kind="reload"] .chat-fix-text')?.textContent).toBe('thimble started again with your fix. Reload the page to see it; what you typed stays until you do.')
  expect(button(el, 'Reload')).toBeTruthy()
  expect(reload).not.toHaveBeenCalled()
})

test('Your fixes says why a fix that is on is off where the server runs, and Use it puts it on', async () => {
  const why = 'the workbench runs from your clone, which does not have it'
  fixes = [row({ state: 'off', why, kind: null, said: null })]
  const el = await mount(<FixPage />)
  await act(async () => bus.emit('fixList', { open: true }))
  await settle()
  const item = el.querySelector('.chat-fixes-list li')!
  expect(item.querySelector('.chat-fixes-state')?.textContent).toBe('off')
  expect(item.querySelector('.chat-fixes-why')?.textContent).toBe(why)
  await click(button(item, 'Use it'))
  expect(sent).toEqual(['POST /fixes/3/apply'])
})
