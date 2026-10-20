// @vitest-environment jsdom
// The settings popover (src/shell/SettingsPopover.tsx) of thimble browser: sign in with Workload Identity Federation
// and an org, or a pasted API key that is never shown again; the one model (a known id or one typed in), its effort,
// and explainers. A save sends only what changed, the key first by its own route.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { blockedWhy, changedSettings, formOf, KEY_SAVED, SettingsPopover } from '../../src/shell/SettingsPopover.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { BrowserSettings } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const BASE: BrowserSettings = {
  models: { main: { model: 'claude-opus-5-5', effort: 'high', fast: false } },
  credentials: { source: 'wif', org: 'org-a' },
  signed_in: 'Workload Identity Federation (org-a)',
  has_api_key: false,
  model: 'claude-opus-5-5',
  effort: 'high',
  explain: true,
  choices: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], orgs: ['org-a', 'org-b', 'batch'] },
}

let calls: [string, string, unknown][] = []
let answer: BrowserSettings = BASE
beforeEach(() => {
  calls = []
  answer = BASE
  invalidateSettings('mini')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push([method, String(url).replace(/^.*?\/api(?=\/ws\/)/, ''), init?.body ? JSON.parse(String(init.body)) : null])
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('the rules', () => {
  test('a save sends only what changed; credentials whole when the source or the org changed', () => {
    const form = formOf(BASE)
    expect(changedSettings(BASE, form)).toEqual({})
    expect(changedSettings(BASE, { ...form, org: 'batch' })).toEqual({ credentials: { source: 'wif', org: 'batch' } })
    expect(changedSettings(BASE, { ...form, source: 'key' })).toEqual({ credentials: { source: 'key' } })
    expect(changedSettings(BASE, { ...form, model: ' claude-sonnet-5-5 ', effort: 'max', explain: false })).toEqual({ model: 'claude-sonnet-5-5', effort: 'max', explain: false })
    // settings with no credentials yet: the choice shown is sent, so it is saved
    expect(changedSettings({ ...BASE, credentials: {} }, formOf({ ...BASE, credentials: {} }))).toEqual({ credentials: { source: 'wif', org: 'org-a' } })
  })

  test('an API key is needed before a save that signs in with one; a model is a Claude id', () => {
    const form = { ...formOf(BASE), source: 'key' as const }
    expect(blockedWhy(BASE, form, '')).toMatch(/Paste an API key/)
    expect(blockedWhy(BASE, form, 'sk-test')).toBeNull()
    expect(blockedWhy({ ...BASE, has_api_key: true }, form, '')).toBeNull()
    expect(blockedWhy(BASE, { ...formOf(BASE), model: 'gpt' }, '')).toMatch(/Claude model id/)
  })
})

async function open() {
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={() => {}} />)
  await settle()
  await settle()
  return document.body
}

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
  await settle()
}

describe('the popover', () => {
  test('shows the sign-in, the org, the model, the effort and explainers', async () => {
    const doc = await open()
    expect(doc.querySelector('[data-setting="source"] [aria-checked="true"]')?.textContent).toBe('Workload Identity')
    expect(doc.querySelector('[data-setting="org"] .settings-org')?.textContent).toBe('org-a')
    expect(doc.querySelector('[data-setting="model"] .settings-model')?.textContent).toBe('Opus 5.5')
    expect(doc.querySelector('[data-setting="effort"] .settings-effort')?.textContent).toBe('high')
    expect(doc.querySelector('[data-setting="explain"] [role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    expect(doc.querySelector('.settings-signed-in')?.textContent).toMatch(/Workload Identity Federation \(org-a\)/)
  })

  test('a pasted key goes to its own route first, then the settings; the key is in no other request', async () => {
    const doc = await open()
    await click([...doc.querySelectorAll('[data-setting="source"] [role="radio"]')].find((b) => b.textContent === 'API key'))
    const field = doc.querySelector<HTMLInputElement>('[data-setting="key"] input')!
    expect(field.type).toBe('password')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(field, 'sk-made-up-key')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click([...doc.querySelectorAll('.settings-foot button')].find((b) => b.textContent === 'Save'))
    const writes = calls.filter(([m]) => m !== 'GET')
    expect(writes.map(([m, u]) => `${m} ${u}`)).toEqual(['PUT /ws/mini/settings/api-key', 'PUT /ws/mini/settings'])
    expect(writes[0][2]).toEqual({ key: 'sk-made-up-key' })
    expect(writes[1][2]).toEqual({ credentials: { source: 'key' } })
    expect(JSON.stringify(writes[1][2])).not.toContain('sk-made-up-key')
  })

  test('a saved key shows only that it is saved', async () => {
    answer = { ...BASE, credentials: { source: 'key' }, has_api_key: true, signed_in: 'an API key' }
    const doc = await open()
    expect(doc.querySelector('[data-setting="key"] [data-key="saved"]')?.textContent).toBe(KEY_SAVED)
    expect(doc.querySelector('[data-setting="key"] input')).toBeNull()
  })
})
