// @vitest-environment jsdom
// The settings popover (src/shell/SettingsPopover.tsx): one flat list, Claude access, Read only, Ask Claude with, View
// proposals and Models, with no Save, every change sent at once: an agent's pick goes to thimble's config, Read only to
// the workspace's settings. After every name a ? says what the setting does and when you would change it.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { Attached, Settings } from '../../src/lib/types.ts'
import { ACCESS_HELP } from '../../src/shell/ClaudeAccess.tsx'
import { ASK_KEY_HELP, MODEL_ROWS, MODELS_HELP, PROPOSE_HELP, READ_ONLY_HELP, SettingsPopover } from '../../src/shell/SettingsPopover.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const conf = (model: string, effort: string, fast = false) => ({ model, effort, fast })
const SETTINGS: Settings = {
  models: {
    writer: conf('claude-opus-5-5', 'xhigh'),
    dev: { ...conf('claude-opus-5-5', 'high'), fast_follows: 'main' }, // no fast mode of its own: main's, which is off
    checks: conf('claude-opus-5-5', 'high'),
    labels: conf('claude-opus-5-5', 'low'),
    verify: conf('claude-opus-5-5', 'high', true),
    suggest: conf('claude-opus-5-5', 'medium'),
    refusal: { ...conf('claude-opus-4-8', 'high'), off: false },
  },
  config_error: '',
  config_ignored: [],
  card_wait: 10,
}
const ATTACHED: Attached = { session: 's1', cwd: '/c', since: '', effort: 'medium' }
/** How the workbench reaches Claude, as GET /api/claude-access gives it (backend claude_access.status) */
const SIGNED_IN = { how: 'claude-code', key_saved: false, env_key: false, wif_file: '', problem: null, describe: '', consent_text: '' }

let puts: [string, unknown][] = []
let toasts: string[] = []
let served: Settings = SETTINGS // what GET /settings answers
let offToast = () => {}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  puts = []
  toasts = []
  served = SETTINGS
  invalidateSettings('mini')
  window.localStorage.clear()
  offToast = bus.on('toast', (t) => void toasts.push(t.text))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'PUT') puts.push([u, JSON.parse(String(init.body))])
    if (u.endsWith('/claude-access')) return json(SIGNED_IN)
    return json(u.includes('/settings') ? served : u.includes('/session/') ? {} : { meta: { id: 'main', attached: ATTACHED } })
  })
})
afterEach(() => {
  offToast()
  unmountAll()
  vi.unstubAllGlobals()
})

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const row = (role: string) => q(`.settings-row[data-role="${role}"]`)!
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click())
  await settle()
}
/** Opens the menu `label` names and picks its item `item`. */
const pick = async (label: string, item: string) => {
  await click(q(`[aria-label="${label}"]`))
  await click(q(`.menu-item[data-item="${item}"]`))
  await settle()
}

test("an agent's pick is saved at once, in thimble's config: its model, its effort and its fast mode", async () => {
  const anchor = document.body.appendChild(document.createElement('button'))
  await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
  await settle()
  await settle()
  expect(row('dev').querySelector('.settings-name')?.textContent).toBe('View builds')
  await pick('Effort for Writer', 'max')
  expect(puts).toEqual([['/api/ws/mini/settings', { models: { writer: { effort: 'max' } } }]])
  await pick('Model for Comments', 'm:claude-sonnet-5-5')
  await click(row('dev').querySelector('.fast-bolt'))
  await click(row('labels').querySelector('.fast-bolt'))
  expect(puts.slice(1)).toEqual([
    ['/api/ws/mini/settings', { models: { checks: { model: 'claude-sonnet-5-5' } } }],
    ['/api/ws/mini/settings', { models: { dev: { fast: true } } }],
    ['/api/ws/mini/settings', { models: { labels: { fast: true } } }],
  ])
  expect(toasts).toEqual([])
})

/** The switch of the line named `name`. */
const switchOf = (name: string) =>
  [...document.body.querySelectorAll('.settings-line')].find((l) => l.querySelector('.settings-name')?.textContent === name)?.querySelector('[role="switch"]') ?? null

test('Read only is on while the workspace keeps Claude from editing the folder, and off by default', async () => {
  const anchor = document.body.appendChild(document.createElement('button'))
  await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
  await settle()
  expect(switchOf('Read only')?.getAttribute('aria-checked')).toBe('false')
  await click(switchOf('Read only'))
  expect(puts).toEqual([['/api/ws/mini/settings', { corpus_edits: false }]])

  // a folder whose editing was turned off before the switch had this name keeps its stored value, so Read only is on
  unmountAll()
  puts = []
  served = { ...SETTINGS, corpus_edits: false }
  await mount(<SettingsPopover ws="mini" anchor={document.body.appendChild(document.createElement('button'))} open onClose={() => {}} />)
  await settle()
  expect(switchOf('Read only')?.getAttribute('aria-checked')).toBe('true')
  await click(switchOf('Read only'))
  expect(puts).toEqual([['/api/ws/mini/settings', { corpus_edits: null }]])
  expect(toasts).toEqual([])
})

test('every row has a ? after its name that says what the setting does and when you would change it, to a screen reader too; a click or a tap keeps the words open until the next press or Escape, and Settings stays open', async () => {
  const onClose = vi.fn()
  await mount(<SettingsPopover ws="mini" anchor={document.body.appendChild(document.createElement('button'))} open onClose={onClose} />)
  await settle()
  await settle()
  const helps = [...document.body.querySelectorAll<HTMLButtonElement>('.help-tip')]
  const said = (b: HTMLButtonElement) => document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent
  expect(helps.map((b) => [b.getAttribute('aria-label'), said(b)])).toEqual([
    ['About Claude access', ACCESS_HELP],
    ['About Read only', READ_ONLY_HELP],
    ['About Ask Claude with', ASK_KEY_HELP],
    ['About View proposals', PROPOSE_HELP],
    ['About Models', MODELS_HELP],
    ...MODEL_ROWS.map((r) => [`About ${r.name}`, r.help]),
  ])
  // one or two sentences each, every one its own
  for (const b of helps) expect(said(b)!.split(/(?<=[.!?]) +/).length).toBeLessThanOrEqual(2)
  expect(new Set(helps.map(said)).size).toBe(helps.length)
  // each stands after its name, which stays the name alone
  expect(row('writer').querySelector('.settings-name + .help-tip')).not.toBeNull()
  expect(switchOf('Read only')).not.toBeNull()

  const readOnly = helps[1]
  const tip = () => document.body.querySelector('[role="tooltip"]')?.textContent ?? null
  expect(tip()).toBeNull()
  // a click or a tap keeps the words open; a second one closes them
  await click(readOnly)
  expect(tip()).toBe(READ_ONLY_HELP)
  await click(readOnly)
  expect(tip()).toBeNull()
  // a press anywhere else closes them
  await click(readOnly)
  await act(async () => void switchOf('Read only')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  expect(tip()).toBeNull()
  // Escape closes the words alone: Settings stays open
  await click(readOnly)
  await act(async () => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(tip()).toBeNull()
  expect(onClose).not.toHaveBeenCalled()
  // the Models ? stands over its fold's button: a click on it opens its words and folds nothing
  const fold = q('.settings-fold-button')!
  await click(helps[4])
  expect(tip()).toBe(MODELS_HELP)
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  await click(fold)
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(puts).toEqual([])
})
