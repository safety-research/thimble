// What an API error card says failed (src/chat/model.ts apiFailure, apiFailureText): a refused login or key (401), a
// request the account may not make (403), a model the account or provider does not have (404) and a request Claude's
// safeguards stopped each get their own cause and what to do, since a retry repeats the same request; the transient
// failures keep theirs. A safeguards refusal reads the same whole, after words a reply streamed, and in a thread.
import { describe, expect, test } from 'vitest'
import { apiErrorAt, apiFailure, apiFailureText, apiRetry, API_ERROR_KIND, FIX_WHERE, foldRecords, withApiErrors, type ApiFailure } from '../../src/chat/model.ts'

describe('API errors no retry fixes', () => {
  test('401, 403 and 404 are named by their status or the error type, each with what to do', () => {
    const auth = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
    expect(apiFailure(auth)).toEqual({ failure: 'auth', status: 401 })
    expect(apiFailureText(auth)).toBe("Claude Code's login or API key was refused (401). In your terminal: run /login (or claude auth login in a shell).")
    expect(apiFailure('API Error: 403 {"error":{"type":"permission_error"}}').failure).toBe('forbidden')
    const missing = 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"}}'
    expect(apiFailure(missing)).toEqual({ failure: 'not_found', status: 404 })
    expect(apiFailureText(missing)).toMatch(/\(404\)\. In your terminal: run \/model/)
    expect(apiFailure('the request failed: authentication_error').failure).toBe('auth')
  })

  // Claude Code 2.1.300's own lines (the API error screenshots, 10-14), which before 0.8.0 showed as a plain reply
  const LOGIN = 'Please run /login · API Error: 401 Invalid bearer token'
  const FORBIDDEN = 'Please run /login · API Error: 403 Your API key does not have permission to use the specified resource.'
  const NO_MODEL = "There's an issue with the selected model (claude-opus-9-9). It may not exist or you may not have access to it. Run /model to pick a different model."

  test("Claude Code 2.1.300's lines are API errors, each with its cause, and its fix where it runs", () => {
    for (const line of [LOGIN, FORBIDDEN, NO_MODEL, 'Not logged in · Please run /login', 'Failed to authenticate. API Error: 401 x', 'Invalid API key · Fix external API key']) expect(apiErrorAt(line)).toBe(0)
    expect(apiErrorAt('To sign in, please run /login in your terminal.')).toBe(-1)
    expect(apiFailureText(LOGIN, { retry: true })).toBe("Claude Code's login or API key was refused (401). In your terminal: run /login (or claude auth login in a shell), then Retry.")
    expect(apiFailureText(FORBIDDEN, { retry: true })).toBe("Your account may not make this request (403). In your terminal: check your sign-in (/login) and your account's or organization's settings, then Retry.")
    expect(apiFailureText(NO_MODEL, { retry: true })).toBe("This model isn't available to your account. In your terminal: run /model to pick another model (thimble's own agents take theirs from Settings), then Retry.")
    expect(apiFailureText('Not logged in · Please run /login')).toBe("Claude Code's login or API key was refused. In your terminal: run /login (or claude auth login in a shell).")
  })

  test("a failure of no known class that is not Claude Code's API Error line reads in its own words", () => {
    const credits = "You're out of usage credits. Switch to another model to continue."
    expect(apiFailureText(credits, { failure: 'other' })).toBe(credits)
    expect(apiFailureText('API Error: 400 {"error":{"type":"invalid_request_error"}}', { failure: 'other' })).toBe("Anthropic's API returned an error (400)")
  })

  test('each failure says where its fix runs: the terminal for /login and /model, which the browser cannot run', () => {
    expect(FIX_WHERE).toEqual({ overloaded: 'browser', rate_limited: 'browser', server_error: 'browser', connection: 'browser', auth: 'terminal', forbidden: 'terminal', not_found: 'terminal', refused: 'browser', other: 'browser' })
    for (const [failure, where] of Object.entries(FIX_WHERE)) {
      const text = apiFailureText('API Error: something', { failure: failure as ApiFailure, retry: true })
      expect(text.includes('In your terminal:'), failure).toBe(where === 'terminal')
    }
  })

  test("the class the server read from Claude Code's record decides, whatever the line's words", () => {
    const rows = withApiErrors(foldRecords([
      { type: 'user', text: 'Who replies most?', by: 'browser' },
      { type: 'text', delta: 'Done reading.' },
      { type: 'text', delta: 'The request could not be completed.', api_error: 'not_found' },
    ]))
    expect(rows.map((r) => r.kind)).toEqual(['user', 'text', 'error'])
    expect(rows[2]).toMatchObject({ errorKind: API_ERROR_KIND, failure: 'not_found', message: 'The request could not be completed.' })
    expect(apiFailureText('The request could not be completed.', { failure: 'not_found' })).toMatch(/^This model isn't available to your account\. In your terminal: run \/model/)
    expect(apiRetry([{ type: 'user', text: 'Who replies most?', by: 'browser' }, { type: 'text', delta: 'The request could not be completed.', api_error: 'auth' }])).toEqual({ index: 1, text: 'Who replies most?' })
  })

  test('the transient failures and any other error read as before, with no fix line', () => {
    expect(apiFailureText('API Error: Repeated 529 Overloaded errors')).toBe("Anthropic's API is overloaded (529)")
    expect(apiFailure('API Error: 500 {"error":{"type":"api_error"}}').failure).toBe('server_error')
    expect(apiFailureText('API Error: 400 {"error":{"type":"invalid_request_error"}}')).toBe("Anthropic's API returned an error (400)")
  })
})

describe("a request Claude's safeguards stopped", () => {
  const REFUSED = "Claude's safeguards stopped this request: rephrase or narrow the request and send it again."

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
    expect(apiFailureText(text)).toBe("Claude's safeguards stopped this request. In your terminal: run /clear to start a new session, then send a rephrased or narrower request here.")
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
