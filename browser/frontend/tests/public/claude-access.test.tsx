// @vitest-environment jsdom
// How thimble reaches Claude (src/shell/ClaudeAccess.tsx): a chat's card that says Claude cannot be reached opens the
// setup step, and the step asks for consent before it saves Claude Code sign-in.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ErrorRow } from '../../src/chat/Rows.tsx'
import { ClaudeAccessDialog } from '../../src/shell/ClaudeAccess.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, unmountAll } from './mount.tsx'

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

test('Claude Code sign-in is saved only after the consent text is confirmed', async () => {
  const sent: unknown[] = []
  const status = { how: '', describe: 'not chosen yet', problem: null, key_saved: false, wif_file: '', consent_text: 'This uses your Claude subscription through Claude Code and will launch headless Claude Code sessions in the background.' }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') sent.push(JSON.parse(String(init.body)))
    const body = init?.method === 'PUT' ? { ...status, how: 'claude-code', check: { ok: true, how: 'claude-code', describe: 'your Claude Code sign-in' } } : status
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const closed = vi.fn()
  const el = await mount(<ClaudeAccessDialog first onClose={closed} />)
  await act(async () => (el.querySelector('[data-how="claude-code"] input') as HTMLInputElement).click())
  expect(el.textContent).toContain('launch headless Claude Code sessions in the background')
  const save = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Confirm'))!
  expect(save.disabled).toBe(true)
  await act(async () => (el.querySelector('.access-consent input') as HTMLInputElement).click())
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(sent).toEqual([{ how: 'claude-code', consent: true }])
  expect(closed).toHaveBeenCalled()
})
