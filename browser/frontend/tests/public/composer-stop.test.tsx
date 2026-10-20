// @vitest-environment jsdom
// Stop in the composer, as in Claude (src/components/Composer.tsx, src/chat/ChatPanel.tsx composerStopOf): while what
// the browser can stop runs (main's turn, a side thread's turn, a view's build), the send square is its stop square
// while the field is empty and the send square again once there is text. The Stop goes out through stopRun and says in
// a toast when it could not stop.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ComposerFrame } from '../../src/components/Composer.tsx'
import { composerStopOf, stopRun, STOP_BUILD, STOP_MAIN, STOP_THREAD } from '../../src/chat/ChatPanel.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const stopSquare = (el: Element) => el.querySelector<HTMLButtonElement>('button.composer-send[aria-label^="Stop"]')

describe('the composer while an agent runs', () => {
  test('an empty field shows the stop square, named for what it stops, which stops it', async () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    const el = await mount(<ComposerFrame value="" onChange={() => undefined} onSubmit={onSubmit} stop={{ label: 'Stop main', onStop }} />)
    const btn = stopSquare(el)!
    expect(btn.getAttribute('aria-label')).toBe('Stop main')
    expect(btn.type).toBe('button')
    expect(btn.disabled).toBe(false)
    btn.click()
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('while the stop request is in flight the square is busy and ignores clicks', async () => {
    const onStop = vi.fn()
    const el = await mount(<ComposerFrame value="" onChange={() => undefined} onSubmit={() => undefined} stop={{ label: 'Stop the thread', onStop, busy: true }} />)
    const btn = stopSquare(el)!
    expect(btn.getAttribute('aria-busy')).toBe('true')
    btn.click()
    expect(onStop).not.toHaveBeenCalled()
  })

  test('text in the field brings the send square back, which sends it', async () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    const el = await mount(<ComposerFrame value="and the runs?" onChange={() => undefined} onSubmit={onSubmit} stop={{ label: 'Stop main', onStop }} />)
    expect(stopSquare(el)).toBeNull()
    const btn = el.querySelector<HTMLButtonElement>('button.composer-send')!
    expect(btn.getAttribute('aria-label')).toBe('Send')
    btn.click()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  test('without a Stop the empty field shows the disabled send square', async () => {
    const el = await mount(<ComposerFrame value="" onChange={() => undefined} onSubmit={() => undefined} />)
    expect(stopSquare(el)).toBeNull()
    expect(el.querySelector<HTMLButtonElement>('button.composer-send')!.disabled).toBe(true)
  })
})

describe('what the composer stops (composerStopOf)', () => {
  test("main's turn and a thread's turn while they run, a view's build while it builds, and nothing else", () => {
    expect(composerStopOf('main', { id: 'main', status: undefined, running: true })).toEqual({ kind: 'chat', chat: 'main', label: STOP_MAIN })
    expect(composerStopOf('main', { id: 'main', status: undefined, running: false })).toBeNull()
    expect(composerStopOf('thread', { id: 't1', status: undefined, running: true })).toEqual({ kind: 'chat', chat: 't1', label: STOP_THREAD })
    expect(composerStopOf('dev', { id: 'd1', status: 'running', view: 'run-trail' })).toEqual({ kind: 'view', slug: 'run-trail', label: STOP_BUILD })
    expect(composerStopOf('dev', { id: 'd1', status: 'done', view: 'run-trail' })).toBeNull()
    expect(composerStopOf(null, null)).toBeNull()
  })

  test('a Stop that fails says why in a toast, and resolves false', async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (e) => void toasts.push(e.text))
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ detail: 'busy' }), { status: 409, headers: { 'content-type': 'application/json' } }))
    await act(async () => expect(await stopRun('w', { kind: 'chat', chat: 'main', label: STOP_MAIN })).toBe(false))
    off()
    expect(toasts[0]).toMatch(/^Could not stop it/)
  })
})
