// @vitest-environment jsdom
// The stopped page (src/shell/ServerDown.tsx StoppedPage, src/shell/SignIn.tsx): once the page stopped (lib/stale: the
// server's `stopping`, the workspace's session ended, failed reconnects or a failed challenge), the line takes the app's
// place, so the app unmounts and sends nothing under its key; a sign-out heard after it changes nothing. It names
// thimble, run in the folder, and the session continued with claude -c and /thimble browser, as the ways back (bug hunts
// G11, H6), and it asks quietly, with no credentials, whether thimble's server answers again, then reloads (H6), or
// closes when another tab runs the page on its workspace by then (round 9, J8). The server-down line names /thimble
// browser as the way back, and a demo page's lines name thimble demo.
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
  window.sessionStorage.clear()
})

test("the stopped line takes the app's place for good", async () => {
  const { SignInGate } = await import('../../src/shell/SignIn.tsx')
  const { STOPPED_LINE } = await import('../../src/shell/ServerDown.tsx')
  const { stopPage } = await import('../../src/lib/stale.ts')
  const { bus } = await import('../../src/lib/bus.ts')
  const line = STOPPED_LINE.replace(/`/g, '')
  expect(line).toBe(
    "thimble's page stopped with the Claude Code session. To start it again, run thimble in a terminal in the folder with your files, or continue the session there with claude -c and type /thimble browser. This tab reloads by itself once the page runs again.",
  )
  const el = await mount(createElement(SignInGate, null, createElement('div', { className: 'stand-in-app' }, 'the app')))
  await settle()
  await settle()
  expect(el.querySelector('.stand-in-app')).not.toBeNull()
  await act(async () => stopPage('stopping'))
  expect(el.querySelector('.stand-in-app')).toBeNull()
  expect(el.querySelector('.stopped-line')?.textContent).toBe(line)
  expect([...el.querySelectorAll('.stopped-line code')].map((c) => c.textContent)).toEqual(['thimble', 'claude -c', '/thimble browser'])
  await act(async () => bus.emit('signedOut', {}))
  expect(el.querySelector('.stopped-line')?.textContent).toBe(line)
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
  expect(el.querySelector('.stopped-line')?.textContent).toBe(DEMO_STOPPED_LINE.replace(/`/g, ''))
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

test('a stopped page asks quietly whether thimble\'s server answers again, with no credentials, and reloads once it does (bug hunt H6)', async () => {
  // after /exit, `claude -c` and `/thimble browser` started the server again on the same port, and the old tab stayed
  // stopped until a reload, which was all it needed: the browser's sign-in outlives the server
  const KEY = 'Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-'
  window.localStorage.setItem('thimble-browser-key', KEY)
  window.localStorage.setItem('thimble-server-port', '29280')
  const sent: { url: string; credentials?: RequestCredentials }[] = []
  let up = false
  const { expectedAnswer } = await import('../../src/lib/stale.ts')
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    sent.push({ url: u, credentials: init.credentials })
    if (u.startsWith('/api/hello')) {
      if (!up) throw new TypeError('Failed to fetch')
      const nonce = new URL(u, 'http://127.0.0.1:29280').searchParams.get('n')!
      return new Response(JSON.stringify({ mac: await expectedAnswer(KEY, 29280, nonce) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(u.endsWith('/ui/paired') ? { paired: true, id: 'abc123def456' } : {}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const { StoppedPage, BACK_FIRST_MS, BACK_EVERY_MS, BACK_LINE, comeBack } = await import('../../src/shell/ServerDown.tsx')
  const { ASK_MS } = await import('../../src/lib/tabs.ts')
  const reloads: number[] = []
  comeBack.reload = () => void reloads.push(1)
  const realTimeout = globalThis.setTimeout.bind(globalThis)
  const challengeDone = () => new Promise((r) => realTimeout(r, 40))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const el = await mount(createElement(StoppedPage))
    expect(sent).toEqual([])
    // the server is still down: it asks, finds nothing, and asks again later
    await act(async () => void vi.advanceTimersByTime(BACK_FIRST_MS))
    await act(challengeDone)
    expect(sent.filter((r) => r.url.startsWith('/api/hello'))).toHaveLength(1)
    expect(reloads).toEqual([])
    // the server is back on its port: the next ask is answered as the server answers, and the page reloads
    up = true
    await act(async () => void vi.advanceTimersByTime(BACK_EVERY_MS))
    await act(challengeDone)
    // no other tab runs the page: it reloads
    await act(async () => void vi.advanceTimersByTime(ASK_MS))
    expect(reloads).toEqual([1])
    expect(el.querySelector('.stopped-line')?.textContent).toBe(BACK_LINE)
    // only the challenge, never with the browser's credentials or under its key
    expect(sent.every((r) => r.url.startsWith('/api/hello') && r.credentials === 'omit' && !r.url.includes(KEY))).toBe(true)
  } finally {
    vi.useRealTimers()
    window.localStorage.clear()
  }
})

test('a stopped page whose server runs again closes when another tab runs the page on its workspace (round 9, J8)', async () => {
  // after a quit, `claude -c` and `/thimble browser` opened a new tab and the old one reloaded by itself beside it: two
  // live tabs of one page. The old one asks the tabs of its origin first, and closes; where the browser keeps it open,
  // it says it may be closed
  const KEY = 'Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-'
  window.localStorage.setItem('thimble-browser-key', KEY)
  window.localStorage.setItem('thimble-server-port', '29280')
  const { expectedAnswer } = await import('../../src/lib/stale.ts')
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/api/hello')) {
      const nonce = new URL(u, 'http://127.0.0.1:29280').searchParams.get('n')!
      return new Response(JSON.stringify({ mac: await expectedAnswer(KEY, 29280, nonce) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const { StoppedPage, BACK_FIRST_MS, ELSEWHERE_LINE, comeBack } = await import('../../src/shell/ServerDown.tsx')
  const { answerTabs } = await import('../../src/lib/tabs.ts')
  const done: string[] = []
  comeBack.reload = () => void done.push('reload')
  comeBack.close = () => void done.push('close')
  const other = answerTabs('logs') // the tab the press opened, which runs the page on the same workspace
  const elsewhere = answerTabs('other-folder') // a tab of another workspace, which does not count
  const realTimeout = globalThis.setTimeout.bind(globalThis)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const el = await mount(createElement(StoppedPage))
    await act(async () => void vi.advanceTimersByTime(BACK_FIRST_MS))
    await act(() => new Promise((r) => realTimeout(r, 80)))
    expect(done).toEqual(['close'])
    expect(el.querySelector('.stopped-line')?.textContent).toBe(ELSEWHERE_LINE)
  } finally {
    other()
    elsewhere()
    vi.useRealTimers()
    window.localStorage.clear()
  }
})

test('a tab handed the press opens its ref and says it took it (round 9, J8)', async () => {
  const sent: string[] = []
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    sent.push(`${init.method ?? 'GET'} ${String(url)}`)
    return new Response('{"ok": true}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const { takePress } = await import('../../src/lib/tabs.ts')
  const { bus } = await import('../../src/lib/bus.ts')
  const opened: string[] = []
  const off = bus.on('openRef', (e) => void opened.push(e.ref))
  takePress('logs', { ref: 'card:abc', open: 'opn12345abc' })
  await settle()
  off()
  expect(opened).toEqual(['card:abc'])
  expect(sent).toContain('POST /api/ws/logs/press/opn12345abc')
})

test('a stopped tab closes as soon as another tab starts the page on its workspace (round 9, J8)', async () => {
  // the press that started the server again opened a new tab, in front: the stopped one goes at once, before its next
  // ask whether the server answers
  const { StoppedPage, ELSEWHERE_LINE, comeBack } = await import('../../src/shell/ServerDown.tsx')
  const { answerTabs } = await import('../../src/lib/tabs.ts')
  const done: string[] = []
  comeBack.reload = () => void done.push('reload')
  comeBack.close = () => void done.push('close')
  const el = await mount(createElement(StoppedPage))
  const other = answerTabs('other-folder')
  await act(() => new Promise((r) => setTimeout(r, 50)))
  expect(done).toEqual([]) // a tab of another workspace changes nothing
  const started = answerTabs('logs')
  await act(() => new Promise((r) => setTimeout(r, 50)))
  expect(done).toEqual(['close'])
  expect(el.querySelector('.stopped-line')?.textContent).toBe(ELSEWHERE_LINE)
  other()
  started()
})

test('a tab that came back by itself just before the press\'s tab started the page gives way to it (round 9, J8)', async () => {
  // the stopped tab found the server back and reloaded a moment before the press's new tab started: both ran the page
  const { answerTabs, noteCameBack } = await import('../../src/lib/tabs.ts')
  const { pageStopped } = await import('../../src/lib/stale.ts')
  const mine = answerTabs('logs') // this tab, which runs the page, as the shell starts it
  const asOld = answerTabs('logs') // a tab that did not come back by itself starts: nothing changes
  await act(() => new Promise((r) => setTimeout(r, 50)))
  expect(pageStopped()).toBeNull()
  asOld()
  noteCameBack()
  const press = answerTabs('logs') // the press's tab starts the page after this one came back
  await act(() => new Promise((r) => setTimeout(r, 50)))
  expect(pageStopped()).toBe('elsewhere')
  const { StoppedPage, ELSEWHERE_LINE, comeBack } = await import('../../src/shell/ServerDown.tsx')
  const done: string[] = []
  comeBack.close = () => void done.push('close')
  const el = await mount(createElement(StoppedPage))
  expect(done).toEqual(['close'])
  expect(el.querySelector('.stopped-line')?.textContent).toBe(ELSEWHERE_LINE)
  mine()
  press()
})
