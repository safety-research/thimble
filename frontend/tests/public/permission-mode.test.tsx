// @vitest-environment jsdom
// The orientation's permission mode in the page: Start's options are collapsed behind Show options, and its switcher of Claude Code's three modes (src/chat/StartGate.tsx) opens on the analyst's own mode, always sends the
// mode it shows, and shows Claude Code's warning while Bypass is chosen; the running orientation's card (src/chat/ModeSwitch.tsx) shows the mode it runs in, sends a switch to the
// server, keeps the first sentence of the warning while it runs in Bypass, and says when a switch into or out of Auto
// waits for a pause. Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BYPASS_LINE, ModeSwitch, shownMode } from '../../src/chat/ModeSwitch.tsx'
import { BYPASS_WARNING, permissionChoice, startBody, StartGate, ALL_ON } from '../../src/chat/StartGate.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: [string, unknown][] = []

beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push([String(url), JSON.parse(String(init.body ?? '{}'))])
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const options = (el: Element) => [...el.querySelectorAll('.seg-opt')].map((b) => b.textContent)
const active = (el: Element) => el.querySelector('.seg-opt.active')?.textContent
const option = (el: Element, name: string) => [...el.querySelectorAll<HTMLButtonElement>('.seg-opt')].find((b) => b.textContent === name)!
const click = async (b: HTMLElement) => {
  await act(async () => b.click())
  await settle()
}
const startPayload = () => (posted.find(([u]) => u.endsWith('/api/ws/mini/events'))?.[1] as { kind: string; payload: { permissions?: string } }).payload

/** The Start card with its options shown, where the switches and the permission mode are. */
const mountOpen = async (node: Parameters<typeof mount>[0]) => {
  const el = await mount(node)
  await click(el.querySelector<HTMLButtonElement>('.chat-gate-options-toggle')!)
  return el
}

describe('the Start panel', () => {
  test('opens with its options collapsed behind Show options, the chevron after the words and no summary, and opens them on a click', async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" permissionMode="auto" />)
    const toggle = el.querySelector<HTMLButtonElement>('.chat-gate-options-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector('.chat-gate-perms')).toBeNull()
    expect(el.querySelectorAll('.chat-gate-row')).toHaveLength(0)
    expect(toggle.textContent).toBe('Show options')
    expect(toggle.lastElementChild?.classList.contains('chat-gate-caret')).toBe(true)
    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('Hide options')
    expect(el.querySelectorAll('.chat-gate-row')).toHaveLength(4)
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-go')!)
    expect(startPayload().permissions).toBe('auto')
  })

  test("the switcher opens on the analyst's own mode: Auto for auto, Bypass for bypassPermissions, else Manual", () => {
    expect(permissionChoice('auto')).toBe('auto')
    expect(permissionChoice('bypassPermissions')).toBe('bypass')
    for (const other of ['default', 'acceptEdits', 'plan', 'dontAsk', null, undefined]) expect(permissionChoice(other)).toBe('manual')
    expect(startBody(ALL_ON, '', 'high', 'bypass').permissions).toBe('bypass')
    expect(startBody(ALL_ON, '  ', 'high', 'manual')).not.toHaveProperty('text')
  })

  test('always sends the mode it shows, and warns while Bypass is chosen', async () => {
    const el = await mountOpen(<StartGate ws="mini" model="claude-opus-5-5" permissionMode="auto" />)
    const perms = el.querySelector('.chat-gate-perms')!
    expect(options(perms)).toEqual(['Manual', 'Auto', 'Bypass'])
    expect(active(perms)).toBe('Auto')
    expect(el.querySelector('.chat-gate-warn')).toBeNull()
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-go')!)
    expect(startPayload().permissions).toBe('auto')
    await click(option(perms, 'Bypass'))
    expect(el.querySelector('.chat-gate-warn')?.textContent).toBe(BYPASS_WARNING)
    posted.length = 0
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-go')!)
    expect(startPayload().permissions).toBe('bypass')
    await click(option(perms, 'Manual'))
    expect(el.querySelector('.chat-gate-warn')).toBeNull()
  })

  test('with no mode known it opens on Manual, and an analyst whose own mode is bypass sees the warning, options open or not', async () => {
    const none = await mountOpen(<StartGate ws="mini" permissionMode={null} />)
    expect(active(none.querySelector('.chat-gate-perms')!)).toBe('Manual')
    unmountAll()
    const closed = await mount(<StartGate ws="mini" permissionMode="bypassPermissions" />)
    expect(closed.querySelector('.chat-gate-perms')).toBeNull()
    expect(closed.querySelectorAll('.chat-gate-warn')).toHaveLength(1)
    unmountAll()
    const bypass = await mountOpen(<StartGate ws="mini" permissionMode="bypassPermissions" />)
    expect(active(bypass.querySelector('.chat-gate-perms')!)).toBe('Bypass')
    expect(bypass.querySelectorAll('.chat-gate-warn')).toHaveLength(1)
  })
})

describe("the running orientation's card", () => {
  test('shows its mode, sends a switch at once, and keeps the warning while it runs in Bypass', async () => {
    const el = await mount(<ModeSwitch ws="mini" chat="or1" meta={{ permission_mode: 'manual', mode_switch: null }} />)
    const perms = el.querySelector('.chat-perms')!
    expect(options(perms)).toEqual(['Manual', 'Auto', 'Bypass'])
    expect(active(perms)).toBe('Manual')
    expect(el.querySelector('.chat-perms-warn')).toBeNull()
    await click(option(perms, 'Bypass'))
    expect(posted.at(-1)).toEqual(['/api/ws/mini/chats/or1/permission-mode', { mode: 'bypass' }])
    expect(active(perms)).toBe('Bypass')
    unmountAll()
    const bypass = await mount(<ModeSwitch ws="mini" chat="or1" meta={{ permission_mode: 'bypass', mode_switch: null }} />)
    expect(bypass.querySelector('.chat-perms-warn')?.textContent).toBe(BYPASS_LINE)
    expect(BYPASS_LINE).toBe('In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.')
  })

  test('a switch into Auto shows the mode it goes to and says it waits for the next pause', async () => {
    expect(shownMode({ permission_mode: 'manual', mode_switch: 'auto' })).toBe('auto')
    expect(shownMode({ permission_mode: 'bypass', mode_switch: null })).toBe('bypass')
    expect(shownMode(null)).toBeNull()
    const el = await mount(<ModeSwitch ws="mini" chat="or1" meta={{ permission_mode: 'manual', mode_switch: 'auto' }} />)
    expect(active(el.querySelector('.chat-perms')!)).toBe('Auto')
    expect(el.querySelector('.chat-perms-note')?.textContent).toBe('Switching to Auto at the next pause, keeping the work so far.')
    expect(el.querySelector('.chat-perms-warn')).toBeNull()
  })
})
