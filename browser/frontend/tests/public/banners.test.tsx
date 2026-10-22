// @vitest-environment jsdom
// Every notice the analyst can hit has ×: the server-down line (src/shell/ServerDown.tsx) until the stream comes back
// and drops again, the new-version line (src/shell/NewVersion.tsx) until the server serves another build, a session's
// alert (src/chat/Holds.tsx) until its text changes, the restarted line for the page, and a view's Updated
// (src/files/viewVersion.tsx) until a newer version than the one dismissed.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Holds, RESTARTED_LINE } from '../../src/chat/Holds.tsx'
import { usePinnedView, ViewUpdated } from '../../src/files/viewVersion.tsx'
import { bus } from '../../src/lib/bus.ts'
import { NewVersion } from '../../src/shell/NewVersion.tsx'
import { DOWN_AFTER_MS, ServerDown } from '../../src/shell/ServerDown.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

let served = 'b1'
beforeEach(() => {
  served = 'b1'
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url) === '/api/health') return new Response(JSON.stringify({ ui: served }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const x = (el: Element) => act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
const stream = (connected: boolean) => act(async () => bus.emit('wsStream', { connected }))

describe("thimble's server is not answering", () => {
  test('× hides the line until the stream comes back and drops again', async () => {
    vi.useFakeTimers()
    const el = await mount(<ServerDown />)
    await stream(false)
    await act(async () => void vi.advanceTimersByTime(DOWN_AFTER_MS))
    expect(el.querySelector('.shell-down')).not.toBeNull()
    await x(el)
    expect(el.querySelector('.shell-down')).toBeNull()
    // still down: it stays hidden
    await stream(false)
    await act(async () => void vi.advanceTimersByTime(DOWN_AFTER_MS))
    expect(el.querySelector('.shell-down')).toBeNull()
    // back, then down again: it shows
    await stream(true)
    await stream(false)
    await act(async () => void vi.advanceTimersByTime(DOWN_AFTER_MS))
    expect(el.querySelector('.shell-down')).not.toBeNull()
  })
})

describe('thimble was updated', () => {
  test('× hides the line until the server serves a build other than the one it was dismissed for', async () => {
    const el = await mount(<NewVersion />)
    await settle()
    served = 'b2'
    await stream(true)
    await settle()
    expect(el.querySelector('.shell-newer')?.textContent).toMatch(/thimble was updated while this tab was open/)
    await x(el)
    await settle()
    expect(el.querySelector('.shell-newer')).toBeNull()
    // the same build again: still hidden, by the stream and by an update event alike
    await stream(true)
    await act(async () => bus.emit('uiStale', {}))
    await settle()
    expect(el.querySelector('.shell-newer')).toBeNull()
    // a newer build: it shows again
    served = 'b3'
    await stream(true)
    await settle()
    expect(el.querySelector('.shell-newer')).not.toBeNull()
  })
})

describe('what holds a session', () => {
  test('× hides an alert until its text changes', async () => {
    const alert = (text: string) => ({ kind: 'dialog', text })
    const el = await mount(<Holds alert={alert('Claude Code waits on a dialog in your terminal.')} />)
    expect(el.querySelector('.chat-hold[data-kind="alert"]')?.textContent).toBe('Claude Code waits on a dialog in your terminal.')
    await x(el)
    expect(el.querySelector('.chat-hold[data-kind="alert"]')).toBeNull()
    unmountAll()
    // the same alert in another place on the page stays hidden; another text shows
    let again = await mount(<Holds alert={alert('Claude Code waits on a dialog in your terminal.')} />)
    expect(again.querySelector('.chat-hold[data-kind="alert"]')).toBeNull()
    unmountAll()
    again = await mount(<Holds alert={alert('Claude Code waits for you to trust this folder.')} />)
    expect(again.querySelector('.chat-hold[data-kind="alert"]')?.textContent).toBe('Claude Code waits for you to trust this folder.')
  })

  test('× hides the restarted line for the page', async () => {
    const el = await mount(<Holds restarted />)
    expect(el.querySelector('.chat-hold-restarted')?.textContent).toBe(RESTARTED_LINE)
    await x(el)
    expect(el.querySelector('.chat-hold-restarted')).toBeNull()
    unmountAll()
    const again = await mount(<Holds restarted />)
    expect(again.querySelector('.chat-hold-restarted')).toBeNull()
  })
})

describe("a view's newer version", () => {
  function Pane({ version }: { version: string }) {
    const pin = usePinnedView('ws-banners', 'agent-network', version)
    return <div>{pin.stale && <ViewUpdated onReload={() => void pin.reload()} onDismiss={pin.dismiss} />}</div>
  }

  test('× hides Updated until a newer version than the one it was dismissed for', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(el)
    const draw = (version: string) => act(async () => root.render(<Pane version={version} />))
    try {
      await draw('v1')
      expect(el.querySelector('.view-updated')).toBeNull()
      await draw('v2')
      expect(el.querySelector('.view-updated-text')?.textContent).toBe('Updated')
      await x(el)
      expect(el.querySelector('.view-updated')).toBeNull()
      await draw('v3')
      expect(el.querySelector('.view-updated')).not.toBeNull()
    } finally {
      act(() => root.unmount())
    }
  })
})
