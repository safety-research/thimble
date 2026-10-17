// @vitest-environment jsdom
// The stopped page (src/shell/ServerDown.tsx StoppedPage, src/shell/SignIn.tsx): once the page stopped (lib/stale: the
// server's `stopping`, the workspace's session ended, failed reconnects or a failed challenge), the line takes the app's
// place for good, so the app unmounts and nothing polls; a sign-out heard after it changes nothing. It names thimble, run
// in the folder, as the way back, since after /exit there is no session to type /thimble browser in (bug hunt G11). The
// server-down line names /thimble browser as the way back, and a demo page's lines name thimble demo.
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mount, settle, unmountAll } from './mount.tsx'

beforeEach(() => {
  vi.resetModules()
  window.history.replaceState(null, '', '/?ws=logs')
  vi.stubGlobal('fetch', async (url: unknown) =>
    new Response(JSON.stringify(String(url).endsWith('/ui/paired') ? { paired: true, id: 'abc123def456' } : {}), { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test("the stopped line takes the app's place for good", async () => {
  const { SignInGate } = await import('../../src/shell/SignIn.tsx')
  const { STOPPED_LINE } = await import('../../src/shell/ServerDown.tsx')
  const { stopPage } = await import('../../src/lib/stale.ts')
  const { bus } = await import('../../src/lib/bus.ts')
  expect(STOPPED_LINE).toBe("thimble's page stopped with the Claude Code session. To start again, run thimble in a terminal, in the folder with your files.")
  expect(STOPPED_LINE).not.toContain('/thimble browser')
  const el = await mount(createElement(SignInGate, null, createElement('div', { className: 'stand-in-app' }, 'the app')))
  await settle()
  await settle()
  expect(el.querySelector('.stand-in-app')).not.toBeNull()
  await act(async () => stopPage('stopping'))
  expect(el.querySelector('.stand-in-app')).toBeNull()
  expect(el.querySelector('.stopped-line')?.textContent).toBe(STOPPED_LINE)
  expect(el.querySelector('.stopped-line code')?.textContent).toBe('thimble')
  await act(async () => bus.emit('signedOut', {}))
  expect(el.querySelector('.stopped-line')?.textContent).toBe(STOPPED_LINE)
})

test('a demo page that stops says to run thimble demo, which needs no session (bug hunt F7)', async () => {
  const { SignInGate } = await import('../../src/shell/SignIn.tsx')
  const { DEMO_STOPPED_LINE } = await import('../../src/shell/ServerDown.tsx')
  const { stopPage } = await import('../../src/lib/stale.ts')
  const { setDemo } = await import('../../src/lib/demo.ts')
  const el = await mount(createElement(SignInGate, null, createElement('div', { className: 'stand-in-app' }, 'the demo')))
  await settle()
  await settle()
  setDemo(true)
  await act(async () => stopPage('stopping'))
  expect(el.querySelector('.stopped-line')?.textContent).toBe(DEMO_STOPPED_LINE)
  expect(DEMO_STOPPED_LINE).not.toContain('/thimble browser')
  expect(el.querySelector('.stopped-line code')?.textContent).toBe('thimble demo')
  setDemo(false)
})

test('the server-down line names /thimble browser', async () => {
  vi.useFakeTimers()
  try {
    const { ServerDown, DOWN_AFTER_MS } = await import('../../src/shell/ServerDown.tsx')
    const { bus } = await import('../../src/lib/bus.ts')
    const el = await mount(createElement(ServerDown))
    await act(async () => bus.emit('wsStream', { connected: false }))
    await act(async () => void vi.advanceTimersByTime(DOWN_AFTER_MS))
    expect(el.querySelector('.shell-down')?.textContent).toContain('Type /thimble browser in the Claude Code session to start it again')
  } finally {
    vi.useRealTimers()
  }
})
