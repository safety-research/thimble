// @vitest-environment jsdom
// The API error card of a request Claude's safeguards stopped (src/chat/ApiError.tsx): it names the safeguards and the
// fix, rephrasing, and offers no Retry, which would send the same words again; other failures keep their Retry.
import { afterEach, expect, test } from 'vitest'
import { ApiErrorCard } from '../../src/chat/ApiError.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

test('a refusal says what to do and has no Retry; an overloaded API keeps its Retry', async () => {
  const again = async () => undefined
  let el = await mount(<ApiErrorCard line="API Error: Opus 5.5's safeguards flagged this message (cyber). Claude Code can't respond to this message with Opus 5.5." retrying="Not retried. The turn ended here." onRetry={again} />)
  expect(el.querySelector('.chat-apierr')?.getAttribute('data-failure')).toBe('refused')
  expect(el.querySelector('.chat-apierr-what')?.textContent).toBe("Claude's safeguards stopped this request: rephrase or narrow the request and send it again.")
  expect(el.querySelector('.chat-apierr-retry')).toBeNull()
  expect(el.querySelector('.chat-apierr-retrying')?.textContent).toBe('Not retried. The turn ended here.')
  unmountAll()
  el = await mount(<ApiErrorCard line="API Error: Repeated 529 Overloaded errors" onRetry={again} />)
  expect(el.querySelector('.chat-apierr-retry')?.textContent).toBe('Retry')
})
