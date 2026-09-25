// A request that Anthropic's API failed, as one card wherever it surfaces (model.withApiErrors, model.capacityNote,
// sessions waiting to retry). It says what happened with the status, whether and when thimble retries, and offers Retry
// where something can run again. The error's own words are one click away. A wait thimble ends by itself is a status;
// a request that stays failed is an alert.
import { useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { TipButton } from '../components/Tooltip'
import { bus } from '../lib/bus'
import { apiFailure, apiFailureText, isApiError } from './model'

export interface ApiErrorCardProps {
  /** Claude Code's error line, or the server's words for the failure (Anthropic's API was overloaded) */
  line: string
  /** whether thimble retries it, and when, in one line */
  retrying?: string
  /** thimble retries it by itself (a session that starts again, a view build that waits): a status, not an alert */
  waits?: boolean
  /** runs the request again: main's or a thread's message, or a waiting session at once */
  onRetry?: () => Promise<unknown>
  /** the button's word: Retry, or Retry now for a wait thimble would end by itself */
  retryLabel?: string
  /** what failed, in place of the API error's words for it (The report was not written. Anthropic's API is …) */
  head?: string
  /** the words behind the chevron, in place of Claude Code's error line */
  detail?: string
  /** more buttons in the foot, before Retry */
  actions?: ReactNode
  className?: string
}

export function ApiErrorCard({ line, retrying, waits = false, onRetry, retryLabel = 'Retry', head, detail: given, actions, className = '' }: ApiErrorCardProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const words = line.trim()
  const what = head ?? apiFailureText(words)
  // Claude Code's own words for the error, one click away; the server's words say no more than the head
  const detail = given ?? (isApiError(words) ? words : '')
  const retry = () => {
    if (!onRetry) return
    setBusy(true)
    onRetry()
      .catch((e: Error) => bus.emit('toast', { text: `Could not retry: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <div className={`chat-apierr ${className}`.trim()} role={waits ? 'status' : 'alert'} data-failure={apiFailure(words).failure} data-waits={waits || undefined}>
      <div className="chat-apierr-head">
        <Icon name="warning" size={13} className="chat-apierr-ico" />
        <span className="chat-apierr-what">{what}</span>
        {detail && (
          <TipButton tip={open ? 'Hide the error' : 'Show the error'} className="chat-apierr-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name="chevron-right" size={10} />
          </TipButton>
        )}
      </div>
      {open && detail && <p className="chat-apierr-detail">{detail}</p>}
      {(retrying || onRetry || actions) && (
        <div className="chat-apierr-foot">
          {retrying && <span className="chat-apierr-retrying">{retrying}</span>}
          {actions}
          {onRetry && (
            <Button variant="secondary" size="sm" className="chat-apierr-retry" busy={busy} onClick={retry}>
              {retryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
