// The Report bar's primary action: Write on a document not written yet, which asks for it at once, and Revise on a
// written one, which asks in a sheet under the button before a writer starts on a new draft. While a writer runs it
// says what the writer does (writePhase): Writing until the text is saved, then Checking citations while the writer
// re-cites what the save's citation check tagged, with Stop beside it (StopWriter).
import { useEffect, useRef, useState } from 'react'
import { stopSession } from '../chat/AgentCard'
import { STOP_HOLD_MS } from '../chat/ChatPanel'
import { Button } from '../components/Button'
import { Popover } from '../components/Menu'

/** What a document's writer does: writes its text, then checks the citations of what it saved. */
export type WritePhase = 'writing' | 'checking'

/** The words the bar shows for each phase. */
export const PHASE_LABEL: Record<WritePhase, string> = { writing: 'Writing', checking: 'Checking citations' }

/** What a document's writer does now: 'writing' while its text is not saved yet (a write asked for and pending, which
 * the stream's `generating` says); 'checking' while the writer still runs after it saved the text, since it then reads
 * what the save's citation check tagged and re-cites those sentences before it ends; null when no writer works on the
 * document. Pure. */
export function writePhase(pending: boolean, writerRuns: boolean): WritePhase | null {
  return pending ? 'writing' : writerRuns ? 'checking' : null
}

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

export function WriteAction({ name, written, busy, phase = 'writing', disabled, history, onWrite }: {
  /** the document's name, as the bar's chip shows it */
  name: string
  written: boolean
  busy: boolean
  /** while busy, what the writer does */
  phase?: WritePhase
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
        {busy ? PHASE_LABEL[phase] : written ? 'Revise' : 'Write'}
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
