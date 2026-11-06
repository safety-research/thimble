// @vitest-environment jsdom
// The card of a request Anthropic's API failed (src/chat/ApiError.tsx, model.apiFailureText): it says what failed and
// what fixes it, and where: a refused login in the terminal, with /login; a request Claude's safeguards stopped, by
// rephrasing it, with no Retry, which would send the same words again; an overloaded API keeps its Retry.
import { afterEach, expect, test } from 'vitest'
import { ApiErrorCard } from '../../src/chat/ApiError.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

test('an API failure says what failed and what to do, with Retry only where sending again can help', async () => {
  const again = async () => undefined
  const card = async (line: string) => {
    unmountAll()
    const el = await mount(<ApiErrorCard line={line} onRetry={again} />)
    return { what: el.querySelector('.chat-apierr-what')?.textContent, retry: el.querySelector('.chat-apierr-retry')?.textContent ?? null }
  }
  const login = await card('Please run /login · API Error: 401 Invalid bearer token')
  expect(login.what).toMatch(/\(401\)\. In your terminal: run \/login/)
  expect(login.retry).toBe('Retry')
  const refused = await card("API Error: Opus 5.5's safeguards flagged this message (cyber). Claude Code can't respond to this message with Opus 5.5.")
  expect(refused.what).toMatch(/safeguards stopped this request: rephrase/)
  expect(refused.retry).toBeNull()
  const overloaded = await card('API Error: Repeated 529 Overloaded errors')
  expect(overloaded.what).toMatch(/overloaded \(529\)/)
  expect(overloaded.retry).toBe('Retry')
})
