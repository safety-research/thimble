// What an API error card says failed (src/chat/model.ts apiFailure, apiFailureText): a refused login or key (401), a
// request the account may not make (403), a model the account or provider does not have (404) and a request Claude's
// safeguards stopped each get their own cause and what to do, since a retry repeats the same request; the transient
// failures keep theirs. A safeguards refusal reads the same whole, after words a reply streamed, and in a thread.
import { describe, expect, test } from 'vitest'
import { apiErrorAt, apiFailure, apiFailureText, API_ERROR_KIND, foldRecords, withApiErrors } from '../../src/chat/model.ts'

describe('API errors no retry fixes', () => {
  test('401, 403 and 404 are named by their status or the error type, each with what to do', () => {
    const auth = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
    expect(apiFailure(auth)).toEqual({ failure: 'auth', status: 401 })
    expect(apiFailureText(auth)).toMatch(/\(401\): .*\/login/)
    expect(apiFailure('API Error: 403 {"error":{"type":"permission_error"}}').failure).toBe('forbidden')
    const missing = 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"}}'
    expect(apiFailure(missing)).toEqual({ failure: 'not_found', status: 404 })
    expect(apiFailureText(missing)).toMatch(/\(404\): .*Settings/)
    expect(apiFailure('the request failed: authentication_error').failure).toBe('auth')
  })

  test('the transient failures and any other error read as before, with no fix line', () => {
    expect(apiFailureText('API Error: Repeated 529 Overloaded errors')).toBe("Anthropic's API is overloaded (529)")
    expect(apiFailure('API Error: 500 {"error":{"type":"api_error"}}').failure).toBe('server_error')
    expect(apiFailureText('API Error: 400 {"error":{"type":"invalid_request_error"}}')).toBe("Anthropic's API returned an error (400)")
  })
})

describe("a request Claude's safeguards stopped", () => {
  const REFUSED = "Claude's safeguards stopped this request: rephrase or narrow the request and send it again"

  test('named whole, by Claude Code\'s words, the API\'s usage policy or thimble\'s own detail, with no status', () => {
    const blocked = "API Error: 400 This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback."
    expect(apiFailure(blocked).failure).toBe('refused')
    expect(apiFailureText(blocked)).toBe(REFUSED)
    expect(apiFailureText('API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy')).toBe(REFUSED)
    expect(apiFailureText("Claude's safeguards refused the request (stop_reason refusal)")).toBe(REFUSED)
    // Claude Code 2.1.300's own wordings of a block
    expect(apiFailureText("API Error: Opus 5.5's safeguards flagged this message (cyber). Claude Code can't respond to this message with Opus 5.5.")).toBe(REFUSED)
  })

  test("Claude Code's refusal that ends the session says to start a new one", () => {
    const text = "API Error: Claude can't help with this. Start a new session to continue."
    expect(apiFailure(text).failure).toBe('refused')
    expect(apiFailureText(text)).toBe("Claude's safeguards stopped this request: start a new session (/clear in your terminal), then send a rephrased or narrower request")
    expect(apiErrorAt(`Reading the logs. ${text}`)).toBeGreaterThan(0)
  })

  test('after words a reply streamed, and in a thread\'s reply row, it folds into a refused error row', () => {
    const text = 'Looking at the merges now. API Error: Claude\'s safeguards flagged this request and stopped the reply.'
    expect(apiErrorAt(text)).toBeGreaterThan(0)
    const rows = withApiErrors(foldRecords([{ type: 'user', text: 'Explain the merges.', by: 'browser' }, { type: 'text', delta: text, reply: true }]))
    const err = rows.find((r) => r.kind === 'error')
    expect(err).toMatchObject({ kind: 'error', errorKind: API_ERROR_KIND })
    expect(apiFailureText((err as { message: string }).message)).toBe(REFUSED)
    expect(rows.find((r) => r.kind === 'text')).toMatchObject({ text: 'Looking at the merges now.' })
  })
})
