// @vitest-environment jsdom
// Terminal-first mode in the page: the Start card of a workspace whose orientation runs as a subagent of the analyst's
// session (src/chat/StartGate.tsx `subagent`) offers no critique and no permission mode, says what the mode gives up in
// their place, names the session's model, and starts with the critique off; the settings popover's switch saves the
// workspace's setting (src/shell/SettingsPopover.tsx). Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { StartGate, SUBAGENT_MODEL_TIP, TERMINAL_FIRST_NOTE } from '../../src/chat/StartGate.tsx'
import { changedSwitches, SWITCHES } from '../../src/shell/SettingsPopover.tsx'
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
    expect(el.querySelector('.chat-gate-note')?.textContent).toBe(TERMINAL_FIRST_NOTE)
    expect(TERMINAL_FIRST_NOTE).toMatch(/permission mode/)
    expect(TERMINAL_FIRST_NOTE).toMatch(/write fence/)
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
