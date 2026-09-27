// @vitest-environment jsdom
// Terminal-first mode in the page: the Start card of a workspace whose orientation runs as a subagent of the analyst's
// session (src/chat/StartGate.tsx `subagent`) offers no critique and no permission mode, says what the mode gives up in
// their place, names the session's model, and starts with the critique off; the settings popover's switch saves the
// workspace's setting (src/shell/SettingsPopover.tsx). Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { StartGate, SUBAGENT_MODEL_TIP, SUBAGENT_NOTE, TERMINAL_FIRST_NOTE } from '../../src/chat/StartGate.tsx'
import { changedSwitches, CONSENT_LINE, ORIENT_ROUTES, SettingsPopover, SWITCHES } from '../../src/shell/SettingsPopover.tsx'
import { StoppedHold } from '../../src/chat/AgentCard.tsx'
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

const click = async (b: HTMLElement) => {
  await act(async () => b.click())
  await settle()
}

describe('the Start card in terminal-first mode', () => {
  test('offers the outputs only, says what the mode gives up, names the session model, and starts with no critique', async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" sessionModel="claude-fable-5-1" permissionMode="auto" subagent />)
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-options-toggle')!)
    expect([...el.querySelectorAll('.chat-gate-row')].map((r) => r.getAttribute('data-pass'))).toEqual(['final', 'views', 'report'])
    expect(el.querySelector('.chat-gate-perms')).toBeNull()
    expect(el.querySelector('.chat-gate-note')?.textContent).toBe(SUBAGENT_NOTE)
    expect(SUBAGENT_NOTE).toMatch(/permission mode/)
    expect(SUBAGENT_NOTE).toMatch(/write fence/)
    expect(TERMINAL_FIRST_NOTE).toMatch(/background sessions/)
    const line = el.querySelector('.chat-gate-line')!
    expect(line.getAttribute('data-model')).toBe('claude-fable-5-1')
    expect(line.querySelector('.model-line-effort')).toBeNull()
    expect(SUBAGENT_MODEL_TIP).toMatch(/Claude Code session/)
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-go')!)
    const body = (posted.find(([u]) => u.endsWith('/api/ws/mini/events'))?.[1] as { payload: Record<string, unknown> }).payload
    expect(body.critique).toBe(false)
    expect(body.permissions).toBeUndefined()
  })

  test('the default card keeps its critique and permission mode', async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" permissionMode="auto" />)
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-options-toggle')!)
    expect(el.querySelectorAll('.chat-gate-row')).toHaveLength(4)
    expect(el.querySelector('.chat-gate-perms')).not.toBeNull()
    expect(el.querySelector('.chat-gate-note')).toBeNull()
  })
})

describe('the settings switch', () => {
  test('is the workspace setting, sent only when it changes', () => {
    expect(SWITCHES.map((s) => s.key)).toContain('terminal_first')
    expect(changedSwitches({ models: {}, terminal_first: false }, { terminal_first: false })).toEqual({})
    expect(changedSwitches({ models: {} }, { terminal_first: true })).toEqual({ terminal_first: true })
    expect(changedSwitches({ models: {}, terminal_first: true }, { terminal_first: false })).toEqual({ terminal_first: false })
  })
})

describe("terminal-first's changes to Claude Code's files", () => {
  const popover = async (settings: Record<string, unknown>) => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const put: unknown[] = []
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'PUT' && u.endsWith('/settings')) put.push(JSON.parse(String(init.body ?? '{}')))
      const body = u.endsWith('/settings') ? settings : u.endsWith('/chats/main') ? { meta: { id: 'main', kind: 'main' }, events: [] } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => undefined} />)
    await settle()
    await settle()
    return put
  }
  const save = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!
  const turnOn = () => click(document.querySelector<HTMLElement>('[data-setting="terminal_first"] [role="switch"]')!)

  test('the first time, it says what changes and saves only once the analyst allows it', async () => {
    const put = await popover({ models: {}, terminal_first: false, terminal_first_consented: false })
    expect(document.querySelector('.settings-consent')).toBeNull()
    await turnOn()
    expect(document.querySelector('.settings-consent-text')?.textContent).toBe(CONSENT_LINE)
    expect(CONSENT_LINE).toMatch(/trusted in Claude Code's config/)
    expect(CONSENT_LINE).toMatch(/statusline/)
    expect(save().disabled).toBe(true)
    await click(document.querySelector<HTMLButtonElement>('.settings-consent-allow')!)
    expect(save().disabled).toBe(false)
    await click(save())
    expect(put).toEqual([{ terminal_first: true, terminal_first_consent: true }])
  })

  test('once allowed on this install, turning it on asks nothing more', async () => {
    const put = await popover({ models: {}, terminal_first: false, terminal_first_consented: true })
    await turnOn()
    expect(document.querySelector('.settings-consent')).toBeNull()
    await click(save())
    expect(put).toEqual([{ terminal_first: true }])
  })
})

describe("the orientation's route", () => {
  test('shows under the switch while it is on, as subagent / background session, and saves orient_route', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    let settings: Record<string, unknown> = { models: {}, terminal_first: true, orient_route: 'subagent' }
    const put: unknown[] = []
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'PUT' && u.endsWith('/settings')) {
        put.push(JSON.parse(String(init.body ?? '{}')))
        settings = { ...settings, ...(put.at(-1) as object) }
      }
      const body = u.endsWith('/settings') ? settings : u.endsWith('/chats/main') ? { meta: { id: 'main', kind: 'main' }, events: [] } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => undefined} />)
    await settle()
    await settle()
    const group = document.querySelector('[role="radiogroup"][aria-label="Orientation runs as"]')!
    expect(group.textContent).toBe('Orientation runs as:subagent/background session')
    expect(ORIENT_ROUTES.map((r) => r.value)).toEqual(['subagent', 'session'])
    await click(group.querySelector<HTMLButtonElement>('[data-route="session"]')!)
    expect(group.querySelector('[data-route="session"]')?.getAttribute('aria-checked')).toBe('true')
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!
    await click(save)
    expect(put).toContainEqual({ orient_route: 'session' })
  })
})

describe("a stopped background session's card", () => {
  test('says it stopped and Resume asks the server to start it again', async () => {
    const el = await mount(<StoppedHold ws="mini" chat="w1" text="The background session stopped. Resume starts it again with its conversation." />)
    expect(el.querySelector('.chat-hold-stopped')?.textContent).toContain('The background session stopped.')
    const btn = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Resume')!
    await click(btn)
    expect(posted.map(([u]) => u)).toContain('/api/ws/mini/chats/w1/resume')
  })
})
