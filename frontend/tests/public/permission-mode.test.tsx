// @vitest-environment jsdom
// The orientation's permission mode in the Start panel (src/chat/StartGate.tsx): its switcher of Claude Code's three
// modes opens on the analyst's own mode, always sends the mode it shows, and shows Claude Code's warning while Bypass
// is chosen. Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
})
