// @vitest-environment jsdom
// A tab whose browser was signed out (src/lib/stale.ts, src/shell/SignIn.tsx, src/shell/SettingsPopover.tsx): the
// server proves the sign-out in its answer to the stale-tab challenge (backend hook_auth.hello_out_mac), so the page
// does not stop but forgets the spent key and shows the sign-in line, and comes back once another tab signs the browser
// in again (a new key); Settings' Sign out this browser signs it out from the browser itself (bug hunt G4: every tab
// showed that thimble stopped with the session, and stayed so after the browser signed in again).
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mount, settle, unmountAll } from './mount.tsx'

const OLD = 'Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-'
const NEW = 'Zq9_-Zq9_-Zq9_-Zq9_-Zq9_-Zq9_-'
const LINE = "This browser isn't signed in. Type /thimble browser in your Claude Code terminal, or press o in thimble's panel."

const SETTINGS = {
  models: { orient: { model: 'claude-opus-5-5', effort: 'high', fast: false } },
  permission_modes: {},
  disabled_modes: [],
  config_error: '',
  config_ignored: [],
  card_wait: 10,
  agents: { main: { additions: [], web: 'ask', data: 'ask', config: 'agents.orientation' } },
}

let sent: string[] = []
/** the key the server still signs with; any other it signed out */
let live = OLD
// the real clock: WebCrypto answers on its own
const realTimeout = globalThis.setTimeout.bind(globalThis)
const challengeDone = () => new Promise((r) => realTimeout(r, 40))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  sent = []
  live = OLD
  vi.resetModules()
  window.history.replaceState(null, '', '/?ws=mini')
  window.localStorage.clear()
  window.localStorage.setItem('thimble-browser-key', OLD)
  window.localStorage.setItem('thimble-server-port', '29280')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    sent.push(`${init.method ?? 'GET'} ${u.split('?')[0]}${init.body ? ` ${String(init.body)}` : ''}`)
    if (u.startsWith('/api/hello')) {
      const stale = await import('../../src/lib/stale.ts')
      const q = new URL(u, 'http://127.0.0.1:29280').searchParams
      const nonce = q.get('n')!
      for (const key of [OLD, NEW]) {
        if ((await stale.keyId(key)) !== q.get('k')) continue
        return json(key === live ? { mac: await stale.expectedAnswer(key, 29280, nonce) } : { out: await stale.expectedOutAnswer(key, 29280, nonce) })
      }
      return json({ mac: null }, 404)
    }
    const signed = u.startsWith(`/b/${live}/api/`)
    if (u.endsWith('/ui/paired')) return json({ paired: signed, id: signed ? 'abc123def456' : '' })
    if (u.endsWith('/ui/signout')) return json({ signed_out: true })
    if (!signed) return json({ detail: 'sign in', signin: true }, 401)
    if (u.includes('/settings')) return json(SETTINGS)
    if (u.includes('/extensions')) return json({ extensions: [], conflicts: [] })
    return json({ meta: { id: 'main', attached: null } })
  })
})
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('a tab the server signed out shows the sign-in line, sends nothing more under the spent key, and comes back once the browser signs in again', async () => {
  const stale = await import('../../src/lib/stale.ts')
  const { bus } = await import('../../src/lib/bus.ts')
  const { SignInGate } = await import('../../src/shell/SignIn.tsx')
  stale.guardFetch()
  const el = await mount(createElement(SignInGate, null, createElement('div', { className: 'stand-in-app' }, 'the app')))
  await settle()
  expect(el.querySelector('.stand-in-app')).not.toBeNull()

  // `thimble unpair`: the server closes the tab's stream, and its next request under the key waits for the challenge
  live = ''
  const stops: string[] = []
  bus.on('pageStopped', (e) => stops.push(e.reason))
  stale.markSuspect()
  sent = []
  await act(async () => {
    await expect(fetch(`/b/${OLD}/api/corpora`)).rejects.toThrow()
    await challengeDone()
  })
  await settle()
  expect(stops).toEqual([])
  expect(el.textContent).toBe(LINE)
  expect(sent.filter((s) => s.includes(`/b/${OLD}/`))).toEqual([])
  expect(window.localStorage.getItem('thimble-browser-key')).toBeNull()

  // another tab signs the browser in again: a new key, which this tab takes
  live = NEW
  window.localStorage.setItem('thimble-browser-key', NEW)
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'thimble-browser-key', newValue: NEW }))
    await challengeDone()
  })
  await settle()
  expect(el.querySelector('.stand-in-app')).not.toBeNull()
  expect(stale.pageStopped()).toBeNull()
})

test("Settings' Sign out this browser signs this browser out, and the page shows the sign-in line", async () => {
  const notices = await import('../../src/lib/notices.ts')
  const { bus } = await import('../../src/lib/bus.ts')
  const { SettingsPopover } = await import('../../src/shell/SettingsPopover.tsx')
  notices.setBrowserId('abc123def456')
  let out = 0
  bus.on('signedOut', () => out++)
  const anchor = document.body.appendChild(document.createElement('button'))
  const closed = vi.fn()
  await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={closed} />)
  await settle()
  const button = [...document.querySelectorAll<HTMLButtonElement>('.settings-foot button')].find((b) => b.textContent === 'Sign out this browser')
  expect(button).toBeTruthy()
  await act(async () => button!.click())
  await settle()
  expect(sent).toContain(`POST /b/${OLD}/api/ui/signout {"id":"abc123def456","ws":"mini"}`)
  expect(out).toBe(1)
  expect(closed).toHaveBeenCalled()
  expect(window.localStorage.getItem('thimble-browser-key')).toBeNull()
})
