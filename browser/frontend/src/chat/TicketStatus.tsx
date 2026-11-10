// A dev ticket's state at the foot of its thread: while it runs, a line only while thimble's question about its code
// waits on the card (its Stop is the composer's stop square, ChatPanel), and for one that still waits in the queue how
// to ask for the change now (FIX_ALONE), since nothing starts a code ticket, with Discard. After a failure or a stop it
// shows the reason with Discard. An applied ticket shows nothing. The ticket is re-fetched on each `ticket` stream event.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { Ticket } from '../lib/types'
import { FIX_ALONE } from './fix'
import { Note } from './Notes'

/** The ends that leave nothing applied: each shows its reason, and Discard unless it is discarded already. */
const ENDED = new Set(['failed', 'needs manual merge', 'rolled back', 'stopped', 'reverted', 'dismissed'])

/** What the line says for a ticket's status: for one that waits in the queue, which nothing starts, how to ask for the
 * change now; the reason for a failure, and for a stop thimble made (main's quit: backend dev._settle_ticket), a word
 * for the rest; null for none. Pure. */
export function ticketStatusText(t: Pick<Ticket, 'status' | 'error'>): string | null {
  switch (t.status) {
    case 'queued':
      return FIX_ALONE
    case 'stopped':
      return t.error ? reason(t.error) : 'Stopped'
    case 'reverted':
      return 'Reverted'
    case 'dismissed':
      return 'Dismissed'
    case 'failed':
    case 'needs manual merge':
    case 'rolled back':
      return t.error ? reason(t.error) : 'Failed'
    default:
      return null
  }
}

/** The reason as the server words it, begun with a capital unless it begins with thimble's lowercase name. Pure. */
function reason(error: string): string {
  return error.startsWith('thimble') ? error : error.charAt(0).toUpperCase() + error.slice(1)
}

/** The ticket record, fetched when `id` changes and again on each `ticket` event for it. */
export function useTicket<T extends Ticket>(id: string | null): [T | null, (t: T) => void] {
  const [ticket, setTicket] = useState<T | null>(null)
  useEffect(() => {
    setTicket(null)
    if (!id) return
    let alive = true
    const load = () => {
      api
        .ticket(id)
        .then((t) => alive && setTicket(t as T))
        .catch(() => undefined)
    }
    load()
    const off = bus.on('ticket', (e) => {
      if (e.id === id) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [id])
  return [ticket, setTicket]
}

/** The running ticket's line while thimble's question about its code waits on the card. */
export const WAITING_LINE = 'Waiting for permission'

export function TicketStatus({ ticket, waiting = false, onChange }: { ticket: Ticket; waiting?: boolean; onChange: (t: Ticket) => void }) {
  const [busy, setBusy] = useState(false)
  // the request itself is the telemetry record (lib/telemetry's wrapped fetch)
  const discard = () => {
    setBusy(true)
    api
      .dismissTicket(ticket.id)
      .then(() => api.ticket(ticket.id))
      .then(onChange)
      .catch((e: Error) => bus.emit('toast', { text: `Could not dismiss the ticket. ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(false))
  }
  const discardButton = (
    <Button size="sm" className="chat-ticket-act" busy={busy} onClick={discard}>
      Discard
    </Button>
  )
  const text = ticketStatusText(ticket)
  const failed = ticket.status === 'failed' || ticket.status === 'needs manual merge' || ticket.status === 'rolled back'
  if (ticket.status === 'running') return waiting ? <Note className="chat-ticket-status" data-status="running" data-waiting="" text={WAITING_LINE} /> : null
  if (ticket.status === 'queued') return <Note className="chat-ticket-status" data-status="queued" text={text} chips={discardButton} />
  if (!ENDED.has(ticket.status)) return null
  return (
    <Note
      className="chat-ticket-status"
      data-status={ticket.status}
      text={
        <>
          {failed && <Mark kind="failed" className="chat-ticket-mark" />}
          <span className="chat-ticket-why">{text}</span>
        </>
      }
      chips={ticket.status !== 'dismissed' && discardButton}
    />
  )
}
