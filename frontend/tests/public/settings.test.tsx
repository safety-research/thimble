// @vitest-environment jsdom
// The settings popover (src/shell/SettingsPopover.tsx): one model table with a row per role and exactly the model and
// effort that runs, Claude Code's levels in every agent's effort menu and none for a model that runs with none, fast
// mode only for the classifiers, main and `thimble fix` (on the dev row), the view proposals' and the refusal's
// rows, the orientation subagents' row with its effort, a web switch per agent; the View proposals switch, sent only
// when it changed; thimble's rules for main and its agents, code tickets' among them (web and data follow the session's
// mode, and the shell runs in Claude Code's sandbox where /thimble saw one); one permission row, the dev agent's
// program's, only where an extension runs one, with Manual and Auto and no Bypass (0.9.0: a session or a row in Bypass
// counts as Manual); cardWait; no installs row; the Ask key choice, ⌘-click or ⌥-click (Ctrl-click or Alt-click off a
// Mac), sent only when it changed and taken by the page at once; thimble's feature switches, the same rows as /config →
// thimble, in its order, each sent only when it changed (false off, null back on).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MODE_OPTIONS, SettingsPopover, agentMode, changedRoles, changedWeb, webRows } from '../../src/shell/SettingsPopover.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { Attached, Settings } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const row = (extra: Record<string, unknown> = {}) => ({ way: 'thimble', extension: '', additions: [], conflict: [], web: 'ask', config: 'agents.x', ...extra })
const SETTINGS: Settings = {
  models: {
    orient: { model: 'claude-opus-5-5[1m]', effort: 'xhigh', fast: false },
    subagents: { model: 'claude-opus-5-5', effort: 'high', fast: false, follows: 'orient' },
    critic: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false },
    writer: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false },
    checks: { model: 'claude-haiku-4-5-20251001', effort: '', fast: false },
    verify: { model: 'claude-opus-5-5', effort: 'high', fast: true },
    labels: { model: 'claude-opus-5-5', effort: 'low', fast: false },
    dev: { model: 'claude-opus-5-5', effort: 'high', fast: false },
    suggest: { model: 'claude-opus-5-5', effort: 'low', fast: false },
    refusal: { model: 'claude-opus-4-8', effort: 'high', fast: false, off: false },
  },
  permission_modes: {},
  disabled_modes: [],
  config_error: '',
  config_ignored: ['agents.writer.fast'],
  card_wait: 10,
  agents: {
    main: { additions: [], web: 'ask', data: 'ask', config: 'agents.orientation' },
    orient: row({ config: 'agents.orientation' }),
    critic: row({ web: 'off', config: 'agents.critic' }),
    writer: row({ config: 'agents.writer', memory: 'off' }),
    checks: row({ config: 'agents.checks' }),
    dev: row({ sandbox: 'on', sandbox_runs: true, network: 'on', web: 'off', data: 'ask', config: 'agents.dev' }),
  } as Settings['agents'],
}
let puts: unknown[] = []
/** main's session, as main's chat gives it */
let attached: Attached | null = null
/** what GET /settings answers */
let settings: Settings = SETTINGS
beforeEach(() => {
  puts = []
  attached = null
  settings = SETTINGS
  invalidateSettings('mini')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') puts.push([String(url), JSON.parse(String(init.body))])
    const body = String(url).includes('/settings') ? settings : String(url).includes('/extensions') ? { extensions: [], conflicts: [] } : { meta: { id: 'main', attached } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('the rules', () => {

  test('a save sends only what changed: models, the refusal row\'s off, and the web switches', () => {
    const now = { ...SETTINGS.models, refusal: { ...SETTINGS.models.refusal, off: true }, writer: { ...SETTINGS.models.writer, effort: 'max' } }
    expect(changedRoles(SETTINGS.models, now)).toEqual({ refusal: { off: true }, writer: { effort: 'max' } })
    const loaded = webRows(SETTINGS)
    expect(loaded).toEqual({ critic: false, writer: true, checks: true })
    expect(changedWeb(loaded, { ...loaded, critic: true, writer: false })).toEqual({ critic: null, writer: 'off' })
  })
})

describe('the popover', () => {

  test("no Bypass: the dev agent's program offers Manual and Auto, and a session or a row in Bypass shows as Manual, with no warning", async () => {
    // 0.9.0 (SPEC D47): Settings has no Bypass rows; backend modes.choose refuses bypass
    expect(MODE_OPTIONS.map((o) => o.label)).toEqual(['Manual', 'Auto'])
    expect(agentMode({}, 'dev', 'bypassPermissions')).toBe('manual')
    expect(agentMode({}, 'dev', 'auto')).toBe('auto')
    expect(agentMode({ dev: 'bypass' }, 'dev', 'default')).toBe('manual')
    expect(agentMode({}, 'dev', 'auto', ['auto'])).toBe('manual')
    const program = { ...SETTINGS, agents: { ...SETTINGS.agents, dev: { ...SETTINGS.agents!.dev!, way: 'sdk' as const, extension: 'ext' } } }
    attached = { session: 's1', cwd: '/c', since: '', permission_mode: 'bypassPermissions' }
    settings = program
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    const chip = () => document.body.querySelector<HTMLButtonElement>('[data-mode-agent="dev"] .settings-mode')!
    expect(chip().textContent).toBe("Manual (your session's)")
    expect(document.body.querySelector('.settings-modes-warn')).toBeNull()
    await act(async () => chip().click())
    expect(document.querySelector('.menu-item[data-item="session"] .menu-item-note')?.textContent).toBe('Manual')
    expect([...document.querySelectorAll('.menu-item')].map((m) => m.textContent)).not.toContain('Bypass')
    unmountAll()
    // a row an earlier version wrote as Bypass
    settings = { ...program, permission_modes: { dev: 'bypass' } }
    invalidateSettings('mini')
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    expect(chip().textContent).toBe("Manual (your session's)")
    expect(document.body.textContent).not.toMatch(/Bypass/)
  })
})

describe('the feature switches', () => {

  test('the switches round trip: they show what GET /settings answers, and Save PUTs the change', async () => {
    settings = { ...SETTINGS, features: { labels: true, checks: false, citationMarks: true, coverage: true, cardCheck: true } }
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    const rows = [...document.body.querySelectorAll('.settings-features .settings-row:not(.settings-headrow)')]
    expect(rows.map((r) => r.querySelector('.settings-role')?.textContent)).toEqual([
      'View proposals', 'Labels', 'Checks', 'Citation marks', 'Coverage', 'Card check'])
    const sw = (key: string) => document.body.querySelector<HTMLButtonElement>(`[data-feature="${key}"] [role="switch"]`)!
    expect(sw('checks').getAttribute('aria-checked')).toBe('false')
    expect(sw('labels').getAttribute('aria-checked')).toBe('true')
    await act(async () => sw('labels').click())
    await act(async () => sw('checks').click())
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!.click())
    await settle()
    expect(puts).toEqual([['/api/ws/mini/settings', { features: { labels: false, checks: null } }]])
  })
})
