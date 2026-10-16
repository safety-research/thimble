// The Report bar's primary action: Write on a document not written yet, which asks for it at once, and Revise on a
// written one, which asks in a sheet under the button before a writer starts on a new draft. Writing while one runs,
// with Stop beside it (StopWriter); while Claude Code asks that writer a permission prompt in the terminal, the words
// TERMINAL_WAIT with a still dot in the button's place, since the writer does nothing until the analyst answers there.
import { useEffect, useRef, useState } from 'react'
import { stopSession } from '../chat/AgentCard'
import { STOP_HOLD_MS } from '../chat/ChatPanel'
import { Button } from '../components/Button'
import { Popover } from '../components/Menu'
import { TERMINAL_WAIT } from '../chat/waiting'

/** Stop on the writer that runs (`chat`), beside Writing: the same call as Stop in the writer's thread (the composer's
 * Stop, chat/ChatPanel stopRun, which is stopSession). Busy from the request until the writer ends, which takes the
 * button away, or STOP_HOLD_MS pass; a request that failed clears it at once, its toast saying why. */
export function StopWriter({ ws, chat }: { ws: string; chat: string }) {
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!stopping) return
    const t = window.setTimeout(() => setStopping(false), STOP_HOLD_MS)
    return () => window.clearTimeout(t)
  }, [stopping])
  const stop = () => {
    if (stopping) return
    setStopping(true)
    void stopSession(ws, chat, 'writer').then((ok) => ok || setStopping(false))
  }
  return (
    <Button variant="ghost" icon="stop" className="wu-stop" busy={stopping} onClick={stop}>
      Stop
    </Button>
  )
}

export function WriteAction({ name, written, busy, waiting = false, disabled, history, onWrite }: {
  /** the document's name, as the bar's chip shows it */
  name: string
  written: boolean
  busy: boolean
  /** while busy: the writer waits on a permission prompt in the terminal */
  waiting?: boolean
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
  if (busy && waiting) {
    return (
      <span className="wu-wait" role="status">
        <span className="dot tt-waiting wu-wait-dot" aria-hidden="true" />
        {TERMINAL_WAIT}
      </span>
    )
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
