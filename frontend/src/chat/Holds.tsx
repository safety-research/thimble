// What holds a Claude Code session besides its permission requests (those wait on PermissionCard): an alert when a
// terminal dialog holds it that the browser cannot answer, the rules the analyst's "don't ask again" answers added
// (backend agent_session), a retry countdown after an API capacity error (ApiErrorCard), and a note when a run resumed
// after a server restart (RESTARTED_LINE). The request fields the permission card shows (askFields, askWhat) are read
// here too.
import { useEffect, useState } from 'react'
import { ApiErrorCard } from './ApiError'
import type { PermissionRequest, SessionAlert } from '../lib/types'

/** A retry alert's words at `now` (ms): its reason and the time left, `45 s` under two minutes, else whole minutes, as
 * the backend's wait_text writes them; its own text when it names no time. Pure. */
export function retryText(alert: SessionAlert, now: number): string {
  const until = alert.until ? Date.parse(alert.until) : NaN
  if (!alert.reason || Number.isNaN(until)) return alert.text
  const s = Math.max(0, Math.round((until - now) / 1000))
  if (s === 0) return `${alert.reason}. Retrying now.`
  return `${alert.reason}. Retrying in ${s < 120 ? `${s} s` : `${Math.round(s / 60)} min`}.`
}

/** The line of a retry alert's card at `now` (ms): when thimble starts the session again, and that its work is kept
 * (it resumes the session); the alert's own text when it names no time. Pure. */
export function retryLine(alert: SessionAlert, now: number): string {
  const until = alert.until ? Date.parse(alert.until) : NaN
  if (Number.isNaN(until)) return alert.text
  const s = Math.max(0, Math.round((until - now) / 1000))
  if (s === 0) return 'thimble retries now, keeping the work so far.'
  return `thimble retries in ${s < 120 ? `${s} s` : `${Math.round(s / 60)} min`}, keeping the work so far.`
}

/** A retry alert's words, counted down each second while it shows; '' for no alert. The time left is read at each
 * render, so a late-arriving alert starts from the right count. */
export function useRetryText(alert: SessionAlert | null | undefined, words: (a: SessionAlert, now: number) => string = retryText): string {
  const [, setTick] = useState(0)
  const on = !!alert
  useEffect(() => {
    if (!on) return
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(timer)
  }, [on])
  return alert ? words(alert, Date.now()) : ''
}

/** One field of a request's input as the card shows it: code in a code block, anything else on a line after its
 * name. */
export interface AskField {
  key: string
  code: boolean
  value: string
}

/** The input fields that hold code, with the language each is coloured in, as the transcript's calls colour them. */
export const CODE_LANGS: Readonly<Record<string, string>> = { command: 'bash', code: 'python', sql: 'sql' }

/** The fields a request's input shows: a Bash command whole as code; else each field of the input's JSON but its
 * description, code fields as code; a single text field when the preview is not a JSON object. Pure. */
export function askFields(p: Pick<PermissionRequest, 'command' | 'input' | 'what'>): AskField[] {
  if (p.command) return [{ key: 'command', code: true, value: p.command }]
  if (!p.input || p.input === p.what) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(p.input)
  } catch {
    return [{ key: '', code: false, value: p.input }]
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [{ key: '', code: false, value: p.input }]
  const out: AskField[] = []
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'description' || v == null || v === '') continue
    const value = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    if (value === p.what) continue
    out.push({ key, code: key in CODE_LANGS || typeof v === 'object', value })
  }
  return out
}

/** The head's words for a request: what the call would do, or nothing when that is only its Bash command (a call with
 * no description of its own, backend agent_session._what), which the card shows whole as code under the head. Pure. */
export function askWhat(p: Pick<PermissionRequest, 'command' | 'what'>): string {
  if (!p.command || !p.what) return p.what
  const flat = p.command.trim().split(/\s+/).join(' ')
  return flat === p.what || (p.what.length >= WHAT_CHARS && flat.startsWith(p.what)) ? '' : p.what
}

// how much of a call's command the backend keeps as its `what` (agent_session._what)
const WHAT_CHARS = 300

export const RESTARTED_LINE = "Resumed after thimble's server restarted."

export function Holds({ alert, rules, restarted = false, onRetry, className = '' }: {
  alert?: SessionAlert | null
  /** what the analyst's "don't ask again" answers added to the session, in Claude Code's words */
  rules?: readonly { text: string }[] | null
  /** the run goes on after the server restarted under it (backend agent_session, restart) */
  restarted?: boolean
  /** a retry alert's Retry now; without it the alert has no button */
  onRetry?: () => Promise<unknown>
  className?: string
}) {
  const added = (rules ?? []).map((r) => r.text).filter(Boolean)
  if (!alert && !added.length && !restarted) return null
  return (
    <div className={`chat-holds ${className}`.trim()}>
      {restarted && <p className="chat-hold-restarted">{RESTARTED_LINE}</p>}
      {alert && alert.kind === 'retry' ? (
        <RetryAlert alert={alert} onRetry={onRetry} />
      ) : alert ? (
        <div className="chat-hold" data-kind="alert" role="alert">
          {alert.text}
        </div>
      ) : null}
      {added.length > 0 && (
        <p className="chat-hold-rules">
          Not asked again in this session: <span className="chat-hold-rule">{added.join(', ')}</span>
        </p>
      )}
    </div>
  )
}

/** A session waiting to start again after the API was at capacity: the API error's card, its reason as what happened
 * and the countdown as its retry line, with Retry now. */
function RetryAlert({ alert, onRetry }: { alert: SessionAlert; onRetry?: () => Promise<unknown> }) {
  const line = useRetryText(alert, retryLine)
  return <ApiErrorCard className="chat-hold-retry-card" line={alert.reason || alert.text} retrying={line} waits onRetry={onRetry} retryLabel="Retry now" />
}
