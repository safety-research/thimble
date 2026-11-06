// @vitest-environment jsdom
// How the workbench reaches Claude (src/shell/ClaudeAccess.tsx): the way chosen is saved and checked, the Claude Code
// sign-in with the consent its choice gives, and the API key with nothing pasted while ANTHROPIC_API_KEY is set where
// the workbench runs.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ClaudeAccessDialog } from '../../src/shell/ClaudeAccess.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('each way to reach Claude is saved as chosen: the Claude Code sign-in with consent, the API key from ANTHROPIC_API_KEY with nothing pasted', async () => {
  const sent: unknown[] = []
  const status = { how: '', describe: 'not chosen yet', problem: null, key_saved: false, env_key: true, wif_file: '', consent_text: '' }
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const put = init?.method === 'PUT' ? JSON.parse(String(init.body)) : null
    if (put) sent.push(put)
    const body = put ? { ...status, how: put.how, check: { ok: true, how: put.how, describe: put.how } } : status
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const choose = async (how: string) => {
    const closed = vi.fn()
    const el = await mount(<ClaudeAccessDialog first onClose={closed} />)
    await settle()
    await act(async () => (el.querySelector(`[data-how="${how}"] input`) as HTMLInputElement).click())
    expect(el.querySelector('input[type="password"]')).toBeNull()
    await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save and check')!.click())
    await settle()
    expect(closed).toHaveBeenCalled()
    unmountAll()
  }
  await choose('claude-code')
  await choose('api-key')
  expect(sent).toEqual([
    { how: 'claude-code', consent: true },
    { how: 'api-key', consent: false },
  ])
})
