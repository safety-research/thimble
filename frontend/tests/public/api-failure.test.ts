// What an API error card says failed (src/chat/model.ts apiFailure, apiFailureText): a refused login or key (401), a
// request the account may not make (403) and a model the account or provider does not have (404) each get their own
// cause and what to do, since a retry repeats the same request; the transient failures keep theirs.
import { describe, expect, test } from 'vitest'
import { apiFailure, apiFailureText } from '../../src/chat/model.ts'

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
