// @vitest-environment jsdom
// Each agent's permission mode: its row in the settings, else the mode of the analyst's Claude Code session, leaving
// out a mode their Claude Code settings turn off (src/chat/StartGate.tsx agentMode). Start's switcher shows and saves the
// orientation's row, sends no mode with Start, and shows Claude Code's warning while Bypass is chosen. A running
// session's card (src/chat/ModeSwitch.tsx) shows the three modes less those the settings turn off, and a click on one
// switches the session. Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ModeSwitch, modeOptions } from '../../src/chat/ModeSwitch.tsx'
import { BYPASS_WARNING, agentMode, StartGate } from '../../src/chat/StartGate.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const sent: [string, string, unknown][] = []

beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PUT') sent.push([init.method, String(url), JSON.parse(String(init.body ?? '{}'))])
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

/** The Start card with its options shown, where the switches and the permission mode are. */
const mountOpen = async (node: Parameters<typeof mount>[0]) => {
  const el = await mount(node)
  await click(el.querySelector<HTMLButtonElement>('.chat-gate-options-toggle')!)
  return el
}

describe('the permission modes', () => {
  test("an agent runs in its row, else in the mode of the analyst's session, never in one their settings turn off", () => {
    expect(agentMode({}, 'writer', 'auto')).toBe('auto')
    expect(agentMode({}, 'writer', 'bypassPermissions')).toBe('bypass')
    for (const other of ['default', 'acceptEdits', 'plan', 'dontAsk', null, undefined]) expect(agentMode({}, 'dev', other)).toBe('manual')
    expect(agentMode({ checks: 'bypass' }, 'checks', 'auto')).toBe('bypass')
    expect(agentMode({ checks: 'bypass' }, 'orient', 'auto')).toBe('auto')
    expect(agentMode({ checks: 'bypass' }, 'checks', 'auto', ['bypass'])).toBe('auto')
    expect(agentMode({}, 'orient', 'auto', ['auto'])).toBe('manual')
  })

  test("Start shows and saves the orientation's row, sends no mode itself, and warns while Bypass is chosen", async () => {
    const saved: string[] = []
    const el = await mountOpen(<StartGate ws="mini" model="claude-opus-5-5" mode="auto" offModes={[]} onMode={(m) => saved.push(m)} />)
    const perms = el.querySelector('.chat-gate-perms')!
    expect(options(perms)).toEqual(['Manual', 'Auto', 'Bypass'])
    expect(active(perms)).toBe('Auto')
    expect(el.querySelector('.chat-gate-warn')).toBeNull()
    await click(option(perms, 'Bypass'))
    expect(saved).toEqual(['bypass'])
    expect(el.querySelector('.chat-gate-warn')?.textContent).toBe(BYPASS_WARNING)
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-go')!)
    const [, , body] = sent.find(([, u]) => u.endsWith('/api/ws/mini/events'))!
    expect((body as { payload: object }).payload).not.toHaveProperty('permissions')
    unmountAll()
    const off = await mountOpen(<StartGate ws="mini" model="claude-opus-5-5" mode="manual" offModes={['bypass']} />)
    expect(options(off.querySelector('.chat-gate-perms')!)).toEqual(['Manual', 'Auto'])
  })
})

describe("a running session's switcher", () => {
  const unavailable = (el: Element) => [...el.querySelectorAll('.seg-opt[aria-disabled="true"]')].map((b) => b.textContent)

  test('a session thimble follows offers all three modes, each switching it', async () => {
    const el = await mount(<ModeSwitch ws="mini" chat="c1" meta={{ permission_mode: 'bypass', mode_agent: 'orient' }} />)
    await settle()
    expect(options(el)).toEqual(['Manual', 'Auto', 'Bypass'])
    expect(unavailable(el)).toEqual([])
    await click(option(el, 'Auto'))
    expect(sent.map(([m, u, b]) => [m, u.replace(/^.*\/api/, ''), b])).toEqual([['POST', '/ws/mini/chats/c1/permission-mode', { mode: 'auto' }]])
  })

  test('modes the settings turn off stay hidden', () => {
    expect(modeOptions(['bypass']).map((o) => [o.value, o.unavailable])).toEqual([['manual', undefined], ['auto', undefined]])
  })
})
