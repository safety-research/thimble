// The quiet lines of the transcript and the chips in them: small tertiary text with accent chips for what it points at
// (a thread, an orientation, a dev ticket, a view, a ticket stage). A shot is a dev ticket's picture of its target,
// before or after the change.
import { createContext, useContext, type ReactNode } from 'react'
import { Chip } from '../components/Chip'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { ChatMeta } from '../lib/types'

export interface ThreadsCtx {
  /** every listed chat's full name by id: main, main/why-the-spike, orient, dev/group-board-by-round */
  labels: ReadonlyMap<string, string>
  /** every chat's meta by id, the agent chats' status among them (a label run's card reads its runs' state here) */
  metas?: ReadonlyMap<string, ChatMeta>
}

export const ThreadsContext = createContext<ThreadsCtx>({ labels: new Map() })

/** Go to a thread: the chat panel shows it. */
export function openThread(id: string, from = 'chip'): void {
  track('thread-switch', { target: `chat:${id}`, detail: { from } })
  bus.emit('openChat', { chatId: id })
}

/** The accent chip of a thread: the thread glyph and its full name in the body face, as the thread tree names it; a
 * click goes to it. */
export function ThreadChip({ id, label }: { id: string; label?: string }) {
  const { labels } = useContext(ThreadsContext)
  const name = label ?? labels.get(id) ?? 'thread'
  return (
    <Chip kind="ref" tone="accent" icon="thread" face="sans" className="chat-thread-chip" data-thread={id} onClick={(e) => (e.stopPropagation(), openThread(id))}>
      {name}
    </Chip>
  )
}

/** A quiet line: the spinner while its work runs, the words, then the chips. */
export function Note({ text, chips, spin = false, className, ...data }: { text?: ReactNode; chips?: ReactNode; spin?: boolean; className?: string; [k: `data-${string}`]: string | number | undefined }) {
  return (
    <div className={`chat-row chat-note${className ? ` ${className}` : ''}`} {...data}>
      {spin && <Spinner label="working" />}
      {text != null && text !== '' && <span className="chat-note-text">{text}</span>}
      {chips}
    </div>
  )
}

/** A line between the part of main a thread inherited and the thread's own conversation. */
export function Divider({ text }: { text: string }) {
  return (
    <div className="chat-divider" role="separator">
      <span className="chat-divider-text">{text}</span>
    </div>
  )
}

/** A dev ticket's shot of its target: the phase and what was shot over the picture, which opens full size. */
export function ShotCard({ ticket, name, phase, note }: { ticket: string; name: string; phase: string; note?: string }) {
  const src = api.ticketShotUrl(ticket, name)
  const word = phase === 'after' ? 'After' : phase === 'before' ? 'Before' : phase
  return (
    <figure className="chat-msg chat-shot" data-phase={phase}>
      <div className="chat-shot-frame">
        <div className="chat-shot-head">
          <span className="chat-shot-phase">{word}</span>
          {note && <span className="chat-shot-note">· {note}</span>}
        </div>
        <a className="chat-shot-img" href={src} target="_blank" rel="noreferrer">
          <img src={src} alt={`${word} the change`} loading="lazy" />
        </a>
      </div>
    </figure>
  )
}
