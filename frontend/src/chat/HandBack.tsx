// The action under a finished side thread that hands its answer back to main: `Hand back to main` sends main the
// thread's question and answer as the analyst's message (backend threads.hand_back), which main's chat shows and main
// answers. The line then says it was handed back, until a later question's answer is offered again. An orientation or a
// writer that handed its summary back ends its thread on the same line, the summary folded under it.
import { useEffect, useState } from 'react'
import { Chip } from '../components/Chip'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { ChatMeta } from '../lib/types'
import { ChatMarkdown } from './markdown'
import { Note } from './Notes'

export const HAND_BACK = 'Hand back to main'
export const HANDED_BACK = 'Handed back to main'

/** The thread's hand-back as its meta's `hand_back` says: the button while its answer can be handed back, the line that
 * says it was once it is, nothing while it runs or has no answer. Disabled while no session is attached, which could not
 * take the message. */
export function HandBack({ ws, id, state, detached = false, onDone }: { ws: string; id: string; state: ChatMeta['hand_back']; detached?: boolean; onDone?: () => unknown }) {
  const [busy, setBusy] = useState(false)
  // handed back from here, until the meta read again says so (or offers a later answer)
  const [sent, setSent] = useState(false)
  useEffect(() => setSent(false), [state])
  if (!state) return null
  if (state === 'handed' || sent) return <Note className="chat-hand-back" data-state="handed" text={HANDED_BACK} />
  const hand = () => {
    setBusy(true)
    track('thread-hand-back', { target: `chat:${id}` })
    api
      .handBack(ws, id)
      .then(() => {
        setSent(true)
        return onDone?.()
      })
      .catch((e: Error) => bus.emit('toast', { text: `Could not hand it back to main: ${e.message.replace(/^\d{3}\s+/, '')}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return (
    <Note
      className="chat-hand-back"
      data-state="offer"
      chips={
        <Chip kind="status" face="sans" className="chat-hand-back-chip" disabled={busy || detached} onClick={hand}>
          {HAND_BACK}
        </Chip>
      }
    />
  )
}

/** The end of an orientation's or a writer's thread that handed its summary back to main (ChatPanel orientMessages): one
 * quiet line, which a click opens on the summary as the thread's message, and folds again. `anchor` is the summary's
 * data-anchor, so a ⌘-click on it starts a thread there. */
export function HandedBack({ text, anchor }: { text: string; anchor?: string }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((o) => !o)
  return (
    <>
      <Note
        className={`chat-hand-back${open ? ' open' : ''}`}
        data-state="handed"
        text={
          <span
            className="chat-note-head chat-note-act"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggle()
              }
            }}
          >
            {HANDED_BACK}
            <Icon name="chevron-right" size={10} className="chat-row-caret" />
          </span>
        }
      />
      {open && (
        <div className="chat-msg chat-assistant chat-hand-back-summary">
          <div className="chat-text" data-anchor={anchor} data-anchor-text={anchor ? text : undefined}>
            <ChatMarkdown text={text} />
          </div>
        </div>
      )}
    </>
  )
}
