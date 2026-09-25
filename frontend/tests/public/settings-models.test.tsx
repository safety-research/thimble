// @vitest-environment jsdom
// The settings popover's models (src/shell/SettingsPopover.tsx): every row names its model exactly, never `default`
// or a bare family, and a menu names each model once, whatever `[1m]` tag an id carries; main's row shows the model
// main runs, with the tip saying /model in the terminal changes it; the orientation's subagents are Same as
// orientation until one is picked for them; fast mode is a lightning bolt that is on or off, dimmed with its reason for
// a model without fast mode; the card check's effort is its own. The server is a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MODEL_TIP } from '../../src/chat/ModelLine.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { ModelConf } from '../../src/lib/types.ts'
import { changedRoles, lockedWhy, ROLE_LABEL, roleEfforts, SAME_AS_ORIENT, SettingsPopover, shownModel } from '../../src/shell/SettingsPopover.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

// what GET /settings answers with thimble's defaults (backend config.models_for: the orientation's model with its 1M
// window), for an invented workspace
const MODELS: Record<string, ModelConf> = {
  orient: { model: 'claude-opus-5-5[1m]', effort: 'ultracode', fast: true },
  subagents: { model: 'claude-opus-5-5', effort: '', fast: false, follows: 'orient' },
  critic: { model: 'claude-opus-5-5', effort: 'xhigh', fast: true },
  writer: { model: 'claude-opus-5-5', effort: 'xhigh', fast: true },
  checks: { model: 'claude-opus-5-5', effort: 'high', fast: true },
  verify: { model: 'claude-opus-5-5', effort: 'high', fast: true },
  labels: { model: 'claude-opus-5-5', effort: 'low', fast: false },
  dev: { model: 'claude-opus-5-5', effort: 'high', fast: true },
}
/** A model without fast mode. */
const HAIKU: ModelConf = { model: 'claude-haiku-4-5-20251001', effort: 'low', fast: false }
const puts: unknown[] = []
let served: Record<string, ModelConf> = MODELS

beforeEach(() => {
  puts.length = 0
  served = MODELS
  invalidateSettings('mini')
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body ?? '{}')))
    if (u.endsWith('/api/ws/mini/settings')) return json({ models: served })
    if (u.endsWith('/api/ws/mini/chats/main')) return json({ meta: { id: 'main', attached: { session: 's1', cwd: '/c', since: 't', model: 'claude-opus-5-5', effort: 'high', fast: true } }, records: [] })
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const row = (role: string) => document.querySelector<HTMLElement>(`.settings-row[data-role="${role}"]`)!
const modelOf = (role: string) => row(role).querySelector('.settings-cell')!.textContent
const bolt = (role: string) => row(role).querySelector<HTMLButtonElement>('.settings-fast')!

async function open(): Promise<void> {
  await mount(<SettingsPopover ws="mini" anchor={document.body} open onClose={() => undefined} />)
  await settle()
  await settle()
}

describe('the settings popover', () => {
  test('every role names its exact model, main its running one, and the subagents are named for what they are', async () => {
    await open()
    const shown = Object.fromEntries(['main', 'orient', 'subagents', 'critic', 'writer', 'checks', 'verify', 'labels', 'dev'].map((r) => [r, modelOf(r)]))
    expect(shown).toEqual({ main: 'Opus 5.5', orient: 'Opus 5.5', subagents: SAME_AS_ORIENT, critic: 'Opus 5.5', writer: 'Opus 5.5', checks: 'Opus 5.5', verify: 'Opus 5.5', labels: 'Opus 5.5', dev: 'Opus 5.5' })
    expect(document.body.textContent).not.toMatch(/default/)
    expect(row('subagents').querySelector('.settings-role')!.textContent).toBe(ROLE_LABEL.subagents)
    expect(row('subagents').querySelectorAll('.settings-cell')[1].textContent).toBe('ultracode')
    expect(MODEL_TIP).toMatch(/\/model in the Claude Code terminal/)
  })

  test('fast mode is a bolt that toggles, dimmed with its reason where the model has none', async () => {
    served = { ...MODELS, labels: HAIKU }
    await open()
    expect(bolt('dev').getAttribute('aria-pressed')).toBe('true')
    await act(async () => bolt('dev').click())
    expect(bolt('dev').getAttribute('aria-pressed')).toBe('false')
    const labels = bolt('labels')
    expect(labels.getAttribute('aria-disabled')).toBe('true')
    expect(labels.getAttribute('aria-pressed')).toBe('false')
    await act(async () => labels.click())
    expect(labels.getAttribute('aria-pressed'), 'a click on a model without fast mode changes nothing').toBe('false')
    expect(bolt('subagents').getAttribute('aria-pressed'), "the orientation's speed").toBe('true')
  })

  test("the card check's effort is its own: shown, not dimmed, and never the session's", async () => {
    await open()
    const effort = row('verify').querySelectorAll('.settings-cell')[1]
    expect(effort.textContent).toBe('high')
    expect(effort.classList.contains('settings-locked')).toBe(false)
    expect(lockedWhy('verify', 'effort', MODELS.verify, { attached: true, fastSwitch: true })).toBeNull()
    expect(roleEfforts('verify')).not.toContain('')
    expect(roleEfforts('subagents')).toContain('')
  })

  test("a model menu names each model once, the orientation's without its 1M tag, and the subagents' starts with Same as orientation", async () => {
    await open()
    await act(async () => row('orient').querySelector<HTMLButtonElement>('.settings-model')!.click())
    const labels = () => Array.from(document.querySelectorAll('.popover .menu-item .menu-item-label')).map((e) => e.textContent)
    const shown = labels()
    expect(shown.filter((l) => l === 'Opus 5.5')).toHaveLength(1)
    expect(shown.some((l) => /1m/i.test(l ?? ''))).toBe(false)
    expect(document.querySelector('.popover .menu-item.checked .menu-item-label')!.textContent).toBe('Opus 5.5')
    await act(async () => document.querySelector<HTMLButtonElement>('.popover .menu-item.checked')!.click())
    await act(async () => row('subagents').querySelector<HTMLButtonElement>('.settings-model')!.click())
    expect(labels()[0]).toBe(SAME_AS_ORIENT)
    expect(document.querySelector('.popover .menu-item.checked .menu-item-note')!.textContent, "the orientation's model beside it").toBe('Opus 5.5')
    await act(async () => document.querySelector<HTMLButtonElement>('.settings-foot .btn-primary')!.click())
    await settle()
    expect(puts, 'picking the model a role runs changes nothing').toEqual([])
  })

  test('only what changed is saved, each role with only its fields that changed', async () => {
    await open()
    await act(async () => bolt('dev').click())
    await act(async () => document.querySelector<HTMLButtonElement>('.settings-foot .btn-primary')!.click())
    await settle()
    expect(puts).toEqual([{ models: { dev: { fast: false } } }])
  })
})

describe("the popover's rules", () => {
  const models = { ...MODELS }
  test("the subagents show the orientation's model while they follow it, and their own once picked", () => {
    expect(shownModel('subagents', { ...models, orient: { ...models.orient, model: 'claude-sonnet-5' } })).toBe('claude-sonnet-5')
    expect(shownModel('subagents', { ...models, subagents: { model: 'claude-haiku-4-5', effort: '', fast: false } })).toBe('claude-haiku-4-5')
  })

  test("a cell that cannot take effect says why", () => {
    const main = { attached: true, fastSwitch: true }
    expect(lockedWhy('labels', 'fast', HAIKU, main)).toBe('Haiku 4.5 has no fast mode')
    expect(lockedWhy('labels', 'fast', models.labels, main)).toBeNull()
    expect(lockedWhy('dev', 'fast', models.dev, main)).toBeNull()
    expect(lockedWhy('subagents', 'effort', models.subagents, main)).toBe("Orientation subagents run at the orientation's effort")
    expect(lockedWhy('subagents', 'fast', models.subagents, main)).toBe("Orientation subagents run at the orientation's speed")
    expect(lockedWhy('main', 'model', { model: 'claude-opus-5-5', effort: 'high', fast: true }, main)).toBe(MODEL_TIP)
  })

  test("a save sends no `follows`, and a subagents' model of '' follows the orientation again", () => {
    const now = { ...models, subagents: { model: '', effort: '', fast: false, follows: 'orient' } }
    expect(changedRoles(models, now)).toEqual({ subagents: { model: '' } })
    expect(changedRoles(models, { ...models })).toEqual({})
  })
})
