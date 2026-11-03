// @vitest-environment jsdom
// How the workbench reaches Claude (src/shell/ClaudeAccess.tsx): a chat's card that says Claude cannot be reached opens
// the setup step, each way says what it does in the install question's few words (choosing the Claude Code sign-in is
// the consent to it), the API key needs nothing pasted while ANTHROPIC_API_KEY is set, and on the first run the step can
// be put off.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ErrorRow } from '../../src/chat/Rows.tsx'
import { ClaudeAccessDialog } from '../../src/shell/ClaudeAccess.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test("the card that says Claude cannot be reached names what is missing and opens the setup step", async () => {
  const heard = vi.fn()
  const off = bus.on('claudeAccess', heard)
  const el = await mount(<ErrorRow item={{ kind: 'error', index: 0, message: 'No Anthropic API key is saved.', errorKind: 'claude-access', detail: 'Paste one.' }} />)
  expect(el.textContent).toContain('No Anthropic API key is saved.')
  expect(el.textContent).not.toContain('NoCredentials')
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Set up Claude access')!
  await act(async () => button.click())
  expect(heard).toHaveBeenCalledTimes(1)
  off()
})

test('choosing the Claude Code sign-in, whose words say what it does, saves it with consent', async () => {
  const sent: unknown[] = []
  const status = { how: '', describe: 'not chosen yet', problem: null, key_saved: false, wif_file: '', consent_text: '' }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') sent.push(JSON.parse(String(init.body)))
    const body = init?.method === 'PUT' ? { ...status, how: 'claude-code', check: { ok: true, how: 'claude-code', describe: 'your Claude Code sign-in' } } : status
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const closed = vi.fn()
  const el = await mount(<ClaudeAccessDialog first onClose={closed} />)
  await act(async () => (el.querySelector('[data-how="claude-code"] input') as HTMLInputElement).click())
  expect(el.textContent).toContain('It runs Claude Code in the background, on your Claude plan.')
  const save = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save and check')!
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(sent).toEqual([{ how: 'claude-code', consent: true }])
  expect(closed).toHaveBeenCalled()
})

test('with ANTHROPIC_API_KEY set where the workbench runs, the API key needs nothing pasted', async () => {
  const sent: unknown[] = []
  const status = { how: '', describe: 'not chosen yet', problem: null, key_saved: false, env_key: true, wif_file: '', consent_text: '' }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') sent.push(JSON.parse(String(init.body)))
    const body = init?.method === 'PUT' ? { ...status, how: 'api-key', check: { ok: true, how: 'api-key', describe: 'an API key, from ANTHROPIC_API_KEY' } } : status
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const el = await mount(<ClaudeAccessDialog first onClose={() => undefined} />)
  await act(async () => (el.querySelector('[data-how="api-key"] input') as HTMLInputElement).click())
  expect(el.textContent).toContain('ANTHROPIC_API_KEY is set where the workbench runs, so it uses that key.')
  expect(el.querySelector('input[type="password"]')).toBeNull()
  const save = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save and check')!
  await act(async () => save.click())
  expect(sent).toEqual([{ how: 'api-key', consent: false }])
})

test('on the first run Not now and Escape close the step, so the person can look around without access', async () => {
  const status = { how: '', describe: 'not chosen yet', problem: null, key_saved: false, wif_file: '', consent_text: '' }
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } }))
  const closed = vi.fn()
  const el = await mount(<ClaudeAccessDialog first onClose={closed} />)
  const notNow = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Not now')!
  await act(async () => notNow.click())
  expect(closed).toHaveBeenCalledTimes(1)
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(closed).toHaveBeenCalledTimes(2)
})

test("the choices are the install question's, in its order and words: the Claude Code sign-in first, recommended and chosen, unless another way is saved", async () => {
  let saved = ''
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ how: saved, describe: '', problem: null, key_saved: !!saved, wif_file: '', consent_text: '' }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const chosen = (el: HTMLElement) => el.querySelector('.access-choice input:checked')?.closest('.access-choice')?.getAttribute('data-how')
  const el = await mount(<ClaudeAccessDialog first onClose={() => undefined} />)
  await settle()
  const words = (c: Element) => [c.getAttribute('data-how'), c.querySelector('.access-choice-label')?.textContent, c.querySelector('.access-choice-hint')?.textContent]
  expect([...el.querySelectorAll('.access-choice')].map(words)).toEqual([
    ['claude-code', 'Your Claude Code sign-in (recommended)', 'It runs Claude Code in the background, on your Claude plan.'],
    ['api-key', 'An Anthropic API key', 'ANTHROPIC_API_KEY when it is set, or a key you paste here.'],
    ['wif', 'Workload Identity Federation', 'The path of your WIF config file.'],
  ])
  expect(chosen(el)).toBe('claude-code')
  unmountAll()
  saved = 'api-key'
  const again = await mount(<ClaudeAccessDialog first={false} onClose={() => undefined} />)
  await settle()
  expect(chosen(again)).toBe('api-key')
})
