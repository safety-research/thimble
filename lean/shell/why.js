// why.js: why a call to the model gave no answer, in the person's words. No `$`, no Node, no DOM: the hooks module, the
// verbs' Node children and the tests import it.
//
// A failed `$.model.complete` or `$.model.fork` says only a reason (`api-error` with an HTTP status and Claude Code's
// kind of error, `empty-reply`, `aborted`, `nothing-to-fork`). A notice says what failed in plain words and the easy
// fix, so the reason is said as what happened, never as the code alone.

/** The API's failure as words, from its HTTP status (null: no reply came) and Claude Code's kind of error. */
export function apiWhy(status, kind) {
  const k = String(kind || '')
  const s = Number.isInteger(status) ? status : null
  if (k === 'authentication_failed' || s === 401) return 'the sign-in failed or expired'
  if (k === 'oauth_org_not_allowed' || k === 'account_on_hold' || k === 'verification_required' || s === 403) return 'the account may not make this call'
  if (k === 'billing_error' || s === 402) return 'a billing problem stopped the call'
  if (k === 'rate_limit' || s === 429) return 'the rate limit was reached'
  if (k === 'overloaded' || s === 529) return 'the API is overloaded'
  if (k === 'model_not_found' || s === 404) return 'the model was not found'
  if (k === 'cloud_credential_error') return 'the cloud sign-in failed'
  if (k === 'invalid_request' || s === 400 || s === 413) return 'the API turned the request down as invalid'
  if (k === 'server_error' || (s !== null && s >= 500)) return 'the API had an error of its own'
  if (s === null) return 'no reply came from the API (the connection or the sign-in failed)'
  return `the API answered with an error (HTTP ${s})`
}

/** Why a model call gave no answer, as words; '' when it answered. Takes the call's result as it came (or null). */
export function modelWhy(r) {
  if (!r) return 'no answer came back'
  if (r.isAnswered) return ''
  switch (r.reason) {
    case 'api-error': return apiWhy(r.status, r.error)
    case 'empty-reply': return 'the model answered with no text'
    case 'aborted': return 'the call was stopped before an answer came (it took too long, or the turn was stopped)'
    case 'nothing-to-fork': return 'there is no finished turn yet to ask from'
    case 'refused': return r.error ? `Claude Code did not send the call: ${String(r.error)}` : 'Claude Code did not send the call'
    default: return r.reason ? `no answer came back (${String(r.reason)})` : 'no answer came back'
  }
}
