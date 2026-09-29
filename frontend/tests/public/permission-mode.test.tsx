// @vitest-environment jsdom
// Each agent's permission mode: its row in the settings, else the mode of the analyst's Claude Code session, leaving
// out a mode their Claude Code settings turn off (src/chat/StartGate.tsx agentMode). Start's switcher shows and saves the
// orientation's row, sends no mode with Start, and shows Claude Code's warning while Bypass is chosen. A running
// session's card (src/chat/ModeSwitch.tsx) shows all three modes; on a background session's the ones across Auto are
// unavailable, their reason in the shared tooltip, and a click on one saves it to the agent's row (named by the chat's
// role when its meta names none) rather than switching, or with no row says why. Every request is recorded and answered
// by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ModeSwitch, modeOptions } from '../../src/chat/ModeSwitch.tsx'
import { BYPASS_WARNING, agentMode, StartGate } from '../../src/chat/StartGate.tsx'
import { bus } from '../../src/lib/bus.ts'
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
    expect(agentMode({ views: 'bypass' }, 'views', 'auto')).toBe('bypass')
    expect(agentMode({ views: 'bypass' }, 'orient', 'auto')).toBe('auto')
    expect(agentMode({ views: 'bypass' }, 'views', 'auto', ['bypass'])).toBe('auto')
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

  test("a background session keeps every mode on show, Auto unavailable, and a click on it saves the agent's row", async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (t) => toasts.push(t.text))
    const el = await mount(<ModeSwitch ws="mini" chat="c1" meta={{ permission_mode: 'bypass', background: true, mode_agent: 'orient' }} />)
    await settle()
    expect(options(el)).toEqual(['Manual', 'Auto', 'Bypass'])
    expect(unavailable(el)).toEqual(['Auto'])
    await click(option(el, 'Auto'))
    expect(sent.map(([m, u, b]) => [m, u.replace(/^.*\/api/, ''), b])).toEqual([['PUT', '/ws/mini/settings', { permission_modes: { orient: 'auto' } }]])
    expect(toasts).toEqual(["Auto saved for the orientation's next new session. This one keeps Bypass while it runs."])
    expect(active(el)).toBe('Bypass')
    sent.length = 0
    await click(option(el, 'Manual'))
    expect(sent.map(([m, u]) => [m, u.replace(/^.*\/api/, '')])).toEqual([['POST', '/ws/mini/chats/c1/permission-mode']])
    off()
  })

  test("a chat recorded before its meta named the agent saves to its role's row", async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (t) => toasts.push(t.text))
    const el = await mount(<ModeSwitch ws="mini" chat="c1" meta={{ permission_mode: 'bypass', background: true, role: 'orient' }} />)
    await settle()
    expect(option(el, 'Auto').getAttribute('aria-disabled')).toBe('true')
    await click(option(el, 'Auto'))
    expect(sent.map(([m, u, b]) => [m, u.replace(/^.*\/api/, ''), b])).toEqual([['PUT', '/ws/mini/settings', { permission_modes: { orient: 'auto' } }]])
    expect(toasts).toEqual(["Auto saved for the orientation's next new session. This one keeps Bypass while it runs."])
    off()
  })

  test('with no agent row a click sends nothing and says why in a toast; a failed save says so', async () => {
    const toasts: { text: string; kind?: string }[] = []
    const off = bus.on('toast', (t) => toasts.push(t))
    const el = await mount(<ModeSwitch ws="mini" chat="c1" meta={{ permission_mode: 'manual', background: true, role: 'thread' }} />)
    await settle()
    await click(option(el, 'Auto'))
    expect(sent).toEqual([])
    expect(toasts.map((t) => t.text)).toEqual(["A background session can't switch into Auto while it runs. It keeps Manual until it ends."])
    unmountAll()
    toasts.length = 0
    vi.stubGlobal('fetch', async () => new Response('{"detail":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } }))
    const failing = await mount(<ModeSwitch ws="mini" chat="c1" meta={{ permission_mode: 'manual', background: true, mode_agent: 'writer' }} />)
    await settle()
    await click(option(failing, 'Auto'))
    expect(toasts.map((t) => [t.kind, t.text.startsWith('Could not save Auto')])).toEqual([['error', true]])
    off()
  })

  test("an unavailable mode's reason is the shared tooltip on keyboard focus, not a native title", async () => {
    const el = await mount(<ModeSwitch ws="mini" chat="c1" meta={{ permission_mode: 'bypass', background: true, mode_agent: 'orient' }} />)
    await settle()
    const auto = option(el, 'Auto')
    expect(auto.getAttribute('title')).toBeNull()
    auto.matches = ((sel: string) => sel === ':focus-visible' || Element.prototype.matches.call(auto, sel)) as typeof auto.matches
    await act(async () => auto.focus())
    const tip = document.getElementById(auto.getAttribute('aria-describedby') ?? '')
    expect(tip?.textContent).toBe("A background session can't switch into Auto while it runs. Click to start the orientation's next new session in Auto instead.")
  })

  test('the tooltip says why and what a click does; modes the settings turn off stay hidden', () => {
    const [manual, auto] = modeOptions({ permission_mode: 'auto', background: true, mode_agent: 'writer' }, 'auto', ['bypass'])
    expect([manual.value, auto.value, auto.unavailable]).toEqual(['manual', 'auto', undefined])
    expect(manual.title).toBe("A background session can't switch out of Auto while it runs. Click to start the writers' next new session in Manual instead.")
    expect(modeOptions({ permission_mode: 'manual', background: true }, 'manual', [])[1].title).toBe("A background session can't switch into Auto while it runs. It keeps Manual until it ends.")
  })
})
