// @vitest-environment jsdom
// The settings popover (src/shell/SettingsPopover.tsx): one model table with a row per role and exactly the model and
// effort that runs, Claude Code's levels in every agent's effort menu and none for a model that runs with none, fast
// mode only for the classifiers, main and `thimble fix` (on the dev row), the view proposals' and the refusal's
// rows, the orientation subagents' row with its effort, a web switch per agent; the View proposals switch, sent only
// when it changed; thimble's rules for main and its agents, code tickets' among them (web and data follow the session's
// mode, and the shell runs in Claude Code's sandbox where /thimble saw one); one permission row, the dev agent's
// program's, only where an extension runs one, where a session in Bypass counts as Manual; cardWait; no installs row;
// the Ask key choice, ⌘-click or ⌥-click (Ctrl-click or Alt-click off a Mac), sent only when it changed and taken by
// the page at once.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ASK_KEY_LABEL, BYPASS_LINE, MAIN_MODE_LINE, PROPOSE_LABEL, askKeyNote, askKeyOptions, changedAskKey, SESSION_BYPASS_NOTE, SettingsPopover, TICKET_FAST, agentMode, cardWaitLine, changedPropose, changedRoles, changedWeb, fenceLine, lockedWhy, memoryWords, modeRowShown, rolesOf, roleEfforts, webRows } from '../../src/shell/SettingsPopover.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import { getAskKey, setAskKey } from '../../src/lib/platform.ts'
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
  test("every agent's effort menu is Claude Code's levels; main's alone adds ultracode", () => {
    expect(roleEfforts('orient')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(roleEfforts('subagents')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(roleEfforts('main')).toContain('ultracode')
  })

  test('fast mode is the classifiers\' and main\'s; a model with no effort has none to pick', () => {
    const conf = (model: string) => ({ model, effort: 'high', fast: false })
    expect(lockedWhy('orient', 'fast', conf('claude-opus-5-5'), { attached: true })).toMatch(/no fast mode/)
    expect(lockedWhy('labels', 'fast', conf('claude-opus-5-5'), { attached: true })).toBeNull()
    expect(lockedWhy('dev', 'fast', conf('claude-opus-5-5'), { attached: true })).toBeNull()
    expect(lockedWhy('dev', 'fast', conf('claude-haiku-4-5-20251001'), { attached: true })).toMatch(/fast/i)
    expect(lockedWhy('checks', 'effort', conf('claude-haiku-4-5-20251001'), { attached: true })).toBe('Haiku 4.5 runs with no effort')
  })

  test('the roles in order, the refusal row last of thimble\'s', () => {
    expect(rolesOf(SETTINGS)).toEqual(['main', 'orient', 'subagents', 'critic', 'writer', 'dev', 'checks', 'labels', 'verify', 'suggest', 'refusal'])
  })

  test('a save sends only what changed: models, the refusal row\'s off, and the web switches', () => {
    const now = { ...SETTINGS.models, refusal: { ...SETTINGS.models.refusal, off: true }, writer: { ...SETTINGS.models.writer, effort: 'max' } }
    expect(changedRoles(SETTINGS.models, now)).toEqual({ refusal: { off: true }, writer: { effort: 'max' } })
    const loaded = webRows(SETTINGS)
    expect(loaded).toEqual({ critic: false, writer: true, checks: true })
    expect(changedWeb(loaded, { ...loaded, critic: true, writer: false })).toEqual({ critic: null, writer: 'off' })
  })

  test('View proposals: false to turn them off, null to put the default (on) back, nothing when unchanged', () => {
    expect(changedPropose(SETTINGS, true)).toEqual({})
    expect(changedPropose(SETTINGS, false)).toEqual({ propose_views: false })
    expect(changedPropose({ ...SETTINGS, propose_views: false }, false)).toEqual({})
    expect(changedPropose({ ...SETTINGS, propose_views: false }, true)).toEqual({ propose_views: null })
  })

  test('the ask key: ⌘-click or ⌥-click, Ctrl-click or Alt-click off a Mac; a save sends "alt", null for ⌘, nothing when unchanged', () => {
    expect(askKeyOptions(true)).toEqual([
      { value: 'meta', label: '⌘-click' },
      { value: 'alt', label: '⌥-click' },
    ])
    expect(askKeyOptions(false).map((o) => o.label)).toEqual(['Ctrl-click', 'Alt-click'])
    expect(askKeyNote(true, 'meta')).toBe('⌘-click asks about anything in thimble; ⌥-drag places a card freely on the canvas.')
    expect(askKeyNote(true, 'alt')).toBe('⌥-click asks about anything in thimble; ⌘-drag places a card freely on the canvas.')
    expect(askKeyNote(false, 'alt')).toBe('Alt-click asks about anything in thimble; Ctrl-drag places a card freely on the canvas.')
    expect(changedAskKey(SETTINGS, 'meta')).toEqual({})
    expect(changedAskKey(SETTINGS, 'alt')).toEqual({ ask_key: 'alt' })
    expect(changedAskKey({ ...SETTINGS, ask_key: 'alt' }, 'alt')).toEqual({})
    expect(changedAskKey({ ...SETTINGS, ask_key: 'alt' }, 'meta')).toEqual({ ask_key: null })
  })

  test("thimble's rules for main and its agents in words, and the CLAUDE.md files each agent reads", () => {
    const main = SETTINGS.agents!.main!
    expect(fenceLine(main)).toBe('web follows your mode · data edits follow your mode · shell follows your mode')
    expect(fenceLine(main, true)).toBe("web follows your mode · data edits follow your mode · shell in Claude Code's sandbox")
    expect(fenceLine({ ...main, web: 'off', data: 'off' }, false)).toBe('no web · never edits data · shell follows your mode')
    expect(fenceLine({ ...main, web: 'allow', data: 'allow' })).toBe('web follows your mode · data edits follow your mode · shell follows your mode')
    expect(memoryWords('off')).toBe('CLAUDE.md files: off')
    expect(memoryWords(undefined)).toBe('CLAUDE.md files: on')
  })
})

describe('the popover', () => {
  test('one model table, the fence, cardWait, and no installs or per-agent mode rows: code tickets run in your mode', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    const doc = document.body
    const roles = [...doc.querySelectorAll('.settings-models .settings-row[data-role]')].map((r) => r.getAttribute('data-role'))
    expect(roles).toEqual(['main', 'orient', 'subagents', 'critic', 'writer', 'dev', 'checks', 'labels', 'verify', 'suggest', 'refusal'])
    expect(doc.querySelector('.settings-row[data-role="checks"] [aria-label="checks effort"]')?.textContent).toBe('none')
    expect(doc.querySelector('.settings-row[data-role="subagents"] .settings-role-note')?.textContent).toMatch(/thimble:orient-helper/)
    expect(doc.querySelectorAll('.settings-row[data-role="orient"] .fast-bolt')).toHaveLength(0)
    expect(doc.querySelectorAll('.settings-row[data-role="labels"] .fast-bolt')).toHaveLength(1)
    expect(doc.querySelector('.settings-row[data-role="critic"] [role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    expect(doc.querySelector('.settings-next-start')?.textContent).toMatch(/applies to its next start/)
    expect(doc.querySelector('.settings-fence-line')?.textContent).toBe('web follows your mode · data edits follow your mode · shell follows your mode')
    expect(doc.querySelector('.settings-fence .settings-headrow')?.textContent).toMatch(/^thimble's rules/)
    expect(doc.querySelector('.settings-fence-note')?.textContent).toBe("Your Claude Code session and thimble's agents, its subagents.")
    expect(doc.textContent).not.toMatch(/fence/i)
    expect(doc.querySelectorAll('[data-mode-agent]')).toHaveLength(0)
    expect(doc.querySelector('.settings-main-mode')?.textContent).toBe(MAIN_MODE_LINE)
    expect(doc.querySelector('.settings-card-wait')?.textContent).toBe(cardWaitLine(10))
    expect(doc.querySelector('[data-memory-agent="writer"]')?.textContent).toContain('CLAUDE.md files: off')
    expect(doc.textContent).not.toMatch(/installs/i)
    expect(doc.querySelector('.settings-ignored')?.textContent).toContain('agents.writer.fast')
    // switching the writer's web off and saving sends it
    await act(async () => doc.querySelector<HTMLButtonElement>('.settings-row[data-role="writer"] [role="switch"]')!.click())
    await act(async () => [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!.click())
    await settle()
    expect(puts).toEqual([['/api/ws/mini/settings', { web: { writer: 'off' } }]])
  })

  test('the View proposals switch, on by default, and a save sends it only once it changed', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    const doc = document.body
    const row = doc.querySelector('.settings-row[data-auto="propose-views"]')!
    expect(row.querySelector('.settings-role')?.textContent).toBe(PROPOSE_LABEL)
    expect(row.textContent).not.toMatch(/offer/i)
    const sw = row.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await act(async () => sw.click())
    await act(async () => [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!.click())
    await settle()
    expect(puts).toEqual([['/api/ws/mini/settings', { propose_views: false }]])
  })

  test('the Ask key choice, ⌘ by default: picking the other key and saving sends it, and the page takes it at once', async () => {
    setAskKey('meta')
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    try {
      await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
      await settle()
      await settle()
      const doc = document.body
      const row = doc.querySelector('.settings-row[data-auto="ask-key"]')!
      expect(row.querySelector('.settings-role')?.textContent).toBe(ASK_KEY_LABEL)
      expect(ASK_KEY_LABEL).toBe('Ask key')
      const options = [...row.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      // jsdom reports no Mac
      expect(options.map((o) => [o.textContent, o.getAttribute('aria-checked')])).toEqual([
        ['Ctrl-click', 'true'],
        ['Alt-click', 'false'],
      ])
      expect(row.querySelector('.settings-agent-line')?.textContent).toBe(askKeyNote(false, 'meta'))
      await act(async () => options[1].click())
      expect(row.querySelector('.settings-agent-line')?.textContent).toBe(askKeyNote(false, 'alt'))
      expect(getAskKey()).toBe('meta')
      await act(async () => [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!.click())
      await settle()
      expect(puts).toEqual([['/api/ws/mini/settings', { ask_key: 'alt' }]])
      expect(getAskKey()).toBe('alt')
    } finally {
      setAskKey('meta')
    }
  })

  test('the Ask key choice shows the key the settings hold, and a save without a change sends none', async () => {
    settings = { ...SETTINGS, ask_key: 'alt' }
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    const doc = document.body
    expect(doc.querySelector('.settings-row[data-auto="ask-key"] [role="radio"][aria-checked="true"]')?.textContent).toBe('Alt-click')
    await act(async () => [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!.click())
    await settle()
    expect(puts).toEqual([])
  })

  test("the dev row's fast switch is thimble fix's, and a save sends it", async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    const doc = document.body
    const note = doc.querySelector('.settings-row[data-role="dev"] .settings-role-note')!
    expect(note.textContent).toBe("view builds, view reviews and code tickets · thimble fix's fast mode")
    const bolt = note.querySelector<HTMLButtonElement>(`.fast-bolt[aria-label="${TICKET_FAST}"]`)!
    expect(bolt.getAttribute('aria-disabled')).toBeNull()
    await act(async () => bolt.click())
    await act(async () => [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!.click())
    await settle()
    expect(puts).toEqual([['/api/ws/mini/settings', { models: { dev: { fast: true } } }]])
  })

  test("the dev agent's permission mode shows only where an extension runs it with a program of its own", async () => {
    expect(modeRowShown(undefined)).toBe(false)
    expect(modeRowShown({ way: 'thimble' })).toBe(false)
    expect(modeRowShown({ way: 'prompt' })).toBe(false)
    expect(modeRowShown({ way: 'sdk' })).toBe(true)
    expect(modeRowShown({ way: 'command' })).toBe(true)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const dev = SETTINGS.agents!.dev!
    SETTINGS.agents!.dev = { ...dev, way: 'sdk', extension: 'ext' }
    try {
      await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
      await settle()
      await settle()
      expect(document.body.querySelector('[data-mode-agent="dev"] .settings-role')?.textContent).toBe("Dev agent's program")
    } finally {
      SETTINGS.agents!.dev = dev
    }
  })

  test("main's row says the shell runs in Claude Code's sandbox where /thimble saw one", async () => {
    attached = { session: 's1', cwd: '/c', since: '', sandbox: true }
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    expect(document.body.querySelector('.settings-fence-line')?.textContent).toBe("web follows your mode · data edits follow your mode · shell in Claude Code's sandbox")
  })

  test("a session in Bypass reaches the dev agent's program as Manual; only a row the server answers Bypass is Bypass, with Claude Code's warning", async () => {
    expect(agentMode({}, 'dev', 'bypassPermissions')).toBe('manual')
    expect(agentMode({}, 'dev', 'auto')).toBe('auto')
    expect(agentMode({ dev: 'bypass' }, 'dev', 'default')).toBe('bypass')
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
    expect(document.querySelector('.menu-item[data-item="session"] .menu-item-note')?.textContent).toBe(SESSION_BYPASS_NOTE)
    unmountAll()
    // a row the server answers as Bypass: the analyst chose it in Settings
    settings = { ...program, permission_modes: { dev: 'bypass' } }
    invalidateSettings('mini')
    await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
    await settle()
    await settle()
    expect(chip().textContent).toBe('Bypass')
    expect(document.body.querySelector('.settings-modes-warn')?.textContent).toBe(BYPASS_LINE)
  })
})
