// An error that ended a turn, as one card: the server's words for what failed and what to do (backend llm.failure, or
// a request Claude declined), and Retry where sending the message again can go through.
import { useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { bus } from '../lib/bus'

export function ErrorCard({ text, onRetry }: { text: string; onRetry?: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const retry = () => {
    if (!onRetry) return
    setBusy(true)
    onRetry()
      .catch((e: Error) => bus.emit('toast', { text: `Could not retry: ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <div className="chat-apierr" role="alert">
      <div className="chat-apierr-head">
        <Icon name="warning" size={13} className="chat-apierr-ico" />
        <span className="chat-apierr-what">{text}</span>
      </div>
      {onRetry && (
        <div className="chat-apierr-foot">
          <Button variant="secondary" size="sm" className="chat-apierr-retry" busy={busy} onClick={retry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}
