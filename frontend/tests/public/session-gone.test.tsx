// @vitest-environment jsdom
// The page with no Claude Code session attached to main (src/shell/SessionGone.tsx): the shell and every other layer in
// the body greyed out and inert under one card that says the session disconnected and gives the command that
// reconnects from the session's folder with a copy button, and nothing else. The card waits out a takeover's two writes, is not shown while the stream is down,
// and goes by itself when a session attaches; a session that took main from the one the tab followed is followed at
// once, with a toast. The harness wires the hook as the shell does; fetch and the stream are stand-ins.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { GONE_AFTER_MS, isGone, reconnectCommand, SessionGone, shellFolder, TAKEOVER_TEXT, tookOver, useSessionGone } from '../../src/shell/SessionGone.tsx'
import { mount, unmountAll } from './mount.tsx'

const WS = 'harbor'
const FOLDER = '/home/ana/data/harbor'
const A = 'aaaaaaaa-1111-4111-8111-000000000001'
const B = 'bbbbbbbb-2222-4222-8222-000000000002'

let main: Partial<ChatMeta>
let toasts: string[]
let offToast: () => void

beforeEach(() => {
  main = { attached: { session: A, cwd: FOLDER, since: '2026-09-25T10:00:00Z' } }
  toasts = []
  offToast = bus.on('toast', (t) => void toasts.push(t.text))
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.endsWith('/chats') ? [{ id: 'main', kind: 'main', ...main }] : url.endsWith('/corpora') ? [{ name: WS, path: FOLDER }] : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  offToast()
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Harness() {
  const gone = useSessionGone(WS)
  return (
    <div className="shell" data-session={gone ? 'gone' : undefined} inert={!!gone}>
      {gone && <SessionGone gone={gone} />}
    </div>
  )
}

/** Let fetch's answers land; setTimeout is faked, so this waits on the event loop's other queue. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
  })
}

async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await settle()
}

/** main's meta changes on the server and the stream says so */
async function change(next: Partial<ChatMeta>) {
  main = next
  await act(async () => bus.emit('chat', { chat: 'main' }))
  await wait(200)
}

const card = () => document.querySelector('.shell-gone[role="alertdialog"]')
const shell = () => document.querySelector('.shell')!

describe('the command that reconnects', () => {
  test('is thimble --continue in the folder the session ran in, the home folder as ~ and odd paths quoted', () => {
    expect(reconnectCommand(FOLDER, true)).toBe('cd ~/data/harbor && thimble --continue')
    expect(reconnectCommand('/srv/logs/run-7', true)).toBe('cd /srv/logs/run-7 && thimble --continue')
    expect(reconnectCommand('/home/ana/my logs', true)).toBe("cd ~/'my logs' && thimble --continue")
    expect(shellFolder("/srv/ana's $data")).toBe(`'/srv/ana'\\''s $data'`)
    expect(shellFolder('/home/ana')).toBe('~')
    expect(reconnectCommand(FOLDER, false)).toBe('cd ~/data/harbor && thimble')
    expect(reconnectCommand(null, true)).toBe('thimble --continue')
  })

  test('main with no session attached is gone only once loaded and while the stream is up', () => {
    expect(isGone({ attached: null } as ChatMeta, true)).toBe(true)
    expect(isGone({ attached: null } as ChatMeta, false)).toBe(false)
    expect(isGone(null, true)).toBe(false)
    expect(isGone({ attached: { session: A, cwd: FOLDER, since: '' } } as ChatMeta, true)).toBe(false)
    expect(tookOver(A, B, A)).toBe(true)
    expect(tookOver(A, B, null)).toBe(false)
    expect(tookOver(null, B, A)).toBe(false)
    expect(tookOver(A, A, null)).toBe(false)
  })
})

describe('a session that ended', () => {
  test('greys out the inert shell under the card, which goes by itself when a session attaches again', async () => {
    await mount(<Harness />)
    await settle()
    expect(card()).toBeNull()
    const menu = document.body.appendChild(document.createElement('div'))
    await change({ attached: null, ended: { session: A, cwd: FOLDER, at: '2026-09-25T11:00:00Z' } })
    expect(card()).toBeNull()
    await wait(GONE_AFTER_MS)
    expect(card()?.querySelector('h2')?.textContent).toBe('Claude Code session disconnected')
    expect(card()?.querySelector('.shell-gone-command code')?.textContent).toBe('cd ~/data/harbor && thimble --continue')
    expect(card()?.textContent).toBe('Claude Code session disconnectedTo reconnect, run this in a terminal:cd ~/data/harbor && thimble --continueCopy')
    expect(shell().hasAttribute('inert')).toBe(true)
    expect(shell().getAttribute('data-session')).toBe('gone')
    expect(shell().contains(card())).toBe(false)
    expect(menu.hasAttribute('inert')).toBe(true)
    expect(card()?.hasAttribute('inert')).toBe(false)
    await change({ attached: { session: A, cwd: FOLDER, since: '2026-09-25T11:01:00Z' }, ended: null })
    expect(card()).toBeNull()
    expect(shell().hasAttribute('inert')).toBe(false)
    expect(menu.hasAttribute('inert')).toBe(false)
    menu.remove()
    expect(toasts).toEqual([])
  })

  test('copies the command', async () => {
    const copied: string[] = []
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } })
    await mount(<SessionGone gone={{ ended: { session: A, cwd: '/srv/logs', at: '' }, folder: '/srv/logs' }} />)
    const button = [...document.querySelectorAll('.shell-gone button')].find((b) => b.textContent === 'Copy') as HTMLButtonElement
    await act(async () => button.click())
    await settle()
    expect(copied).toEqual(['cd /srv/logs && thimble --continue'])
    expect(button.textContent).toBe('Copied')
  })

  test('with no session ever attached, says none is connected and offers a new thimble in the workspace folder', async () => {
    main = { attached: null }
    await mount(<Harness />)
    await settle()
    await wait(GONE_AFTER_MS)
    expect(card()?.textContent).toBe('No Claude Code session connectedTo connect, run this in a terminal:cd ~/data/harbor && thimbleCopy')
  })

  test('is not shown while the stream is down, since the server is away or restarting', async () => {
    main = { attached: null, ended: { session: A, cwd: FOLDER, at: '' } }
    await mount(<Harness />)
    await settle()
    await act(async () => bus.emit('wsStream', { connected: false }))
    await wait(GONE_AFTER_MS)
    expect(card()).toBeNull()
    await act(async () => bus.emit('wsStream', { connected: true }))
    await settle()
    await wait(GONE_AFTER_MS)
    expect(card()).not.toBeNull()
  })
})

describe('a session taken over in another terminal', () => {
  test('is followed at once with a toast that says so, and no card even between the two writes', async () => {
    await mount(<Harness />)
    await settle()
    await change({ attached: null, ended: { session: A, cwd: FOLDER, at: '' } }) // the old session's end
    await change({ attached: { session: B, cwd: FOLDER, since: '', after: A }, ended: null }) // the new one's attach
    await wait(GONE_AFTER_MS)
    expect(card()).toBeNull()
    expect(shell().hasAttribute('inert')).toBe(false)
    expect(toasts).toEqual([TAKEOVER_TEXT])
  })

  test('a new session after /clear in the same terminal says nothing', async () => {
    await mount(<Harness />)
    await settle()
    await change({ attached: { session: B, cwd: FOLDER, since: '' } })
    expect(toasts).toEqual([])
  })
})
