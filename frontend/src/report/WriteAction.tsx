// The Report bar's primary action: Write on a document not written yet, which asks for it at once, and Revise on a
// written one, which asks in a sheet under the button before a writer starts on a new draft. Writing while one runs.
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Popover } from '../components/Menu'

export function WriteAction({ name, written, busy, disabled, history, onWrite }: {
  /** the document's name, as the bar's chip shows it */
  name: string
  written: boolean
  busy: boolean
  disabled?: boolean
  /** its drafts are listed in History */
  history?: boolean
  onWrite: () => void
}) {
  const at = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (busy || disabled || !written) setAsking(false)
  }, [busy, disabled, written])
  useEffect(() => {
    if (asking) requestAnimationFrame(() => cancel.current?.focus())
  }, [asking])
  const click = () => {
    if (busy) return
    if (written) setAsking((a) => !a)
    else onWrite()
  }
  return (
    <>
      <Button ref={at} variant="primary" busy={busy} disabled={disabled} aria-haspopup={written && !busy ? 'dialog' : undefined} aria-expanded={written && !busy ? asking : undefined} onClick={click}>
        {busy ? 'Writing' : written ? 'Revise' : 'Write'}
      </Button>
      <Popover anchor={at} open={asking} onClose={() => setAsking(false)} align="end" label={`Revise the ${name}`} className="wu-revise" width={300}>
        <div className="wu-revise-body">
          <p>
            Revise the {name}? A writer starts a new draft from the cards as they stand.{history ? ' Past drafts stay in History.' : ''}
          </p>
          <div className="wu-revise-actions">
            <Button size="sm" ref={cancel} onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setAsking(false)
                onWrite()
              }}
            >
              Revise
            </Button>
          </div>
        </div>
      </Popover>
    </>
  )
}
