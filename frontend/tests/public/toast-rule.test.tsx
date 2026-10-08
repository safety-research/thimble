// @vitest-environment jsdom
// One rule for toasts: a toast confirms or fails the analyst's own click, or reports news with a link. A state that
// lasts shows once beside what it concerns and is never also a toast: a refused Start stays beside Start alone, and a
// write that failed stays on its document (src/report/writeFailures.ts), with no toast for either.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { StartGate } from '../../src/chat/StartGate.tsx'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import { useWriteFailures } from '../../src/report/writeFailures.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const toasts: string[] = []
let off: () => void = () => undefined

beforeEach(() => {
  toasts.length = 0
  off = bus.on('toast', (t) => void toasts.push(t.text))
  invalidateSettings('mini')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  off()
  unmountAll()
  vi.unstubAllGlobals()
})

const REFUSAL = "Claude Code's sandbox cannot run here, so the orientation would run unsandboxed."

test('a refused Start says why beside Start, once, and makes no toast', async () => {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/start') && init?.method === 'POST') return new Response(JSON.stringify({ detail: REFUSAL }), { status: 409, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ models: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" />)
  await settle()
  const start = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Start')!
  await act(async () => start.click())
  await settle()
  expect(el.querySelector('.chat-gate-error')?.textContent).toBe(REFUSAL)
  expect(toasts).toEqual([])
})

test('a write that failed stays on its document and makes no toast', async () => {
  let shown: Record<string, unknown> = {}
  function Probe() {
    shown = useWriteFailures('mini').failures
    return null
  }
  await mount(<Probe />)
  await act(async () => bus.emit('wsEvent', { type: 'report', slug: 'report', status: 'failed', note: 'The writer stopped.', seq: 7 } as never))
  expect(Object.keys(shown)).toEqual(['report'])
  expect(toasts).toEqual([])
})
