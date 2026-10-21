// The report's Write, on its toolbar: one small field for the analyst's instructions or feedback, such as "fill this in
// for my team" or "shorter, lead with the number", and the button, Write on a report Claude has not written in yet and
// Revise on one it has. Enter (or the button) gives them to Claude in the chat, which writes from the report as it
// stands and keeps the analyst's own blocks; an empty field asks for the report as the analyst left it. While Claude
// writes, the button reads Writing, with Stop beside it, which stops Claude's turn in the chat.
import { useEffect, useState, type KeyboardEvent } from 'react'
import { STOP_HOLD_MS, stopRun } from '../chat/ChatPanel'
import { Button } from '../components/Button'
import { TextInput } from '../components/Field'

/** Stop beside Writing: stops Claude's turn in main, as the chat's own Stop does. Busy from the request until the turn
 * ends, which takes the button away, or STOP_HOLD_MS pass; a request that failed clears it at once, its toast saying
 * why. */
export function StopWriter({ ws }: { ws: string }) {
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!stopping) return
    const t = window.setTimeout(() => setStopping(false), STOP_HOLD_MS)
    return () => window.clearTimeout(t)
  }, [stopping])
  const stop = () => {
    if (stopping) return
    setStopping(true)
    void stopRun(ws, { kind: 'chat', chat: 'main', label: '' }).then((ok) => ok || setStopping(false))
  }
  return (
    <Button variant="ghost" icon="stop" className="wu-stop" busy={stopping} onClick={stop}>
      Stop
    </Button>
  )
}

/** The field's placeholder: what it takes. */
export const WRITE_PLACEHOLDER = 'Instructions or feedback for Claude'

export function WriteAction({ name, written, busy, disabled, onWrite }: {
  /** the report's name, for the field's accessible name */
  name: string
  /** Claude has written in the report before: the button reads Revise */
  written: boolean
  busy: boolean
  disabled?: boolean
  /** sends the instructions (may be empty); resolves true when they went out */
  onWrite: (instructions: string) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const send = async () => {
    if (sending || busy || disabled) return
    setSending(true)
    try {
      if (await onWrite(text.trim())) setText('')
    } finally {
      setSending(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void send()
    }
  }
  return (
    <span className="wu-write">
      <TextInput className="wu-write-field" value={text} onChange={setText} onKeyDown={onKey} placeholder={WRITE_PLACEHOLDER} aria-label={`Instructions for Claude about ${name}`} disabled={busy || sending} spellCheck={false} />
      {/* while Claude writes, the busy line above the chat's input box says so (lib/busy.ts): the button only waits */}
      <Button variant="primary" className="wu-write-go" disabled={disabled || busy || sending} onClick={() => void send()}>
        {busy ? 'Writing' : written ? 'Revise' : 'Write'}
      </Button>
    </span>
  )
}
