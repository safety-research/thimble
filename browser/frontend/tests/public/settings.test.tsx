// @vitest-environment jsdom
// The settings popover (src/shell/SettingsPopover.tsx): one flat list, Claude access, "Claude can edit files in this
// folder", Ask Claude with, View proposals and Models, with no Save, every change sent at once: an agent's pick goes to
// thimble's config.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { Attached, Settings } from '../../src/lib/types.ts'
import { SettingsPopover } from '../../src/shell/SettingsPopover.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const conf = (model: string, effort: string, fast = false) => ({ model, effort, fast })
const SETTINGS: Settings = {
  models: {
    writer: conf('claude-opus-5-5', 'xhigh'),
    dev: conf('claude-opus-5-5', 'high', true),
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
let offToast = () => {}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  puts = []
  toasts = []
  invalidateSettings('mini')
  window.localStorage.clear()
  offToast = bus.on('toast', (t) => void toasts.push(t.text))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'PUT') puts.push([u, JSON.parse(String(init.body))])
    if (u.endsWith('/claude-access')) return json(SIGNED_IN)
    return json(u.includes('/settings') ? SETTINGS : u.includes('/session/') ? {} : { meta: { id: 'main', attached: ATTACHED } })
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
  await pick('Effort for Writer', 'max')
  expect(puts).toEqual([['/api/ws/mini/settings', { models: { writer: { effort: 'max' } } }]])
  await pick('Model for Checks', 'm:claude-sonnet-5-5')
  await click(row('dev').querySelector('.fast-bolt'))
  await click(row('labels').querySelector('.fast-bolt'))
  expect(puts.slice(1)).toEqual([
    ['/api/ws/mini/settings', { models: { checks: { model: 'claude-sonnet-5-5' } } }],
    ['/api/ws/mini/settings', { models: { dev: { fast: false } } }],
    ['/api/ws/mini/settings', { models: { labels: { fast: true } } }],
  ])
  expect(toasts).toEqual([])
})
