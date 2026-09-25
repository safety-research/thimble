// A dev ticket's state at the foot of its thread: Stop while it runs, Discard while it waits, and after a failure or a
// stop the reason with Retry and Discard. An applied ticket shows nothing. The ticket is re-fetched on each `ticket`
// stream event.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { Ticket } from '../lib/types'
import { Note, openThread } from './Notes'

/** The ends that leave nothing applied and take Retry and Discard (backend dev.RETRYABLE). */
const ENDED = new Set(['failed', 'needs manual merge', 'rolled back', 'stopped', 'reverted', 'dismissed'])

/** What the line says for a ticket's status: the reason for a failure, a word for the rest; null for none. Pure. */
export function ticketStatusText(t: Pick<Ticket, 'status' | 'error'>): string | null {
  switch (t.status) {
    case 'queued':
      return 'Queued behind another ticket'
    case 'stopped':
      return 'Stopped'
    case 'reverted':
      return 'Reverted'
    case 'dismissed':
      return 'Dismissed'
    case 'failed':
    case 'needs manual merge':
    case 'rolled back':
      // the reason as the server words it, begun with a capital unless it begins with thimble's lowercase name
      if (!t.error) return 'Failed'
      return t.error.startsWith('thimble') ? t.error : t.error.charAt(0).toUpperCase() + t.error.slice(1)
    default:
      return null
  }
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

export function TicketStatus({ ticket, onChange }: { ticket: Ticket; onChange: (t: Ticket) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  // the request itself is the telemetry record (lib/telemetry's wrapped fetch)
  const act = (what: 'stop' | 'retry' | 'dismiss') => {
    setBusy(what)
    const call = what === 'stop' ? api.stopTicket(ticket.id) : what === 'retry' ? api.retryTicket(ticket.id) : api.dismissTicket(ticket.id)
    call
      .then(() => api.ticket(ticket.id))
      .then((t) => {
        onChange(t)
        // a Retry runs in a new agent chat: follow it there
        if (what === 'retry' && t.chat && t.chat !== ticket.chat) openThread(t.chat, 'ticket-retry')
      })
      .catch((e: Error) => bus.emit('toast', { text: `Could not ${what} the ticket. ${e.message}`, kind: 'error' }))
      .finally(() => setBusy(null))
  }
  const text = ticketStatusText(ticket)
  const failed = ticket.status === 'failed' || ticket.status === 'needs manual merge' || ticket.status === 'rolled back'
  if (ticket.status === 'running') {
    return (
      <Note
        className="chat-ticket-status"
        data-status="running"
        chips={
          <Button size="sm" className="chat-ticket-act" busy={busy === 'stop'} onClick={() => act('stop')}>
            Stop
          </Button>
        }
      />
    )
  }
  if (ticket.status === 'queued') {
    return (
      <Note
        className="chat-ticket-status"
        data-status="queued"
        text={text}
        chips={
          <Button size="sm" className="chat-ticket-act" busy={busy === 'dismiss'} onClick={() => act('dismiss')}>
            Discard
          </Button>
        }
      />
    )
  }
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
      chips={
        <>
          <Button size="sm" className="chat-ticket-act" busy={busy === 'retry'} onClick={() => act('retry')}>
            Retry
          </Button>
          {ticket.status !== 'dismissed' && (
            <Button size="sm" className="chat-ticket-act" busy={busy === 'dismiss'} onClick={() => act('dismiss')}>
              Discard
            </Button>
          )}
        </>
      }
    />
  )
}
