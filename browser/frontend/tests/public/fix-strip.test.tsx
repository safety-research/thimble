// @vitest-environment jsdom
// thimble fix in the page (src/chat/fix.ts, src/chat/FixStrip.tsx, backend fixes.py): how a fix ended is a row of the
// chat. The newest row of a fix that passed its checks asks, and Use it now (the person's click) puts it on: the row
// says "Reloading thimble…", then, with the server back, what it said, with nothing left to ask. A fix that is on
// offers Undo. Your fixes says why a fix is off when the server says.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FixRow } from '../../src/chat/fix.ts'
import { FixPage, FixResult } from '../../src/chat/FixStrip.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const row = (over: Partial<FixRow> = {}): FixRow => ({ id: 3, title: 'Card says how many rows', state: 'on', phase: null, kind: 'fixed', said: 'Card says how many rows is on', words: "make this card's title say how many rows", summary: "The card's title ends with its row count.", files: 2, tests: 'passed', error: null, at: 1, ...over })
const SAID = 'thimble fixed: Card says how many rows · tests pass'
const ready = (over: Partial<FixRow> = {}) => row({ state: 'ready', kind: 'ready', said: SAID, ...over })

/** What GET /fixes answers, and each request that changes state. */
let fixes: FixRow[] = []
let sent: string[] = []
beforeEach(() => {
  fixes = []
  sent = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const u = String(url)
    if (method !== 'GET') sent.push(`${method} ${u.replace(/^.*\/api/, '')}`)
    const body = /\/fixes(\?every=true)?$/.test(u) && method === 'GET' ? { problem: '', fixes } : { ok: true, restart: true }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)
const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

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
