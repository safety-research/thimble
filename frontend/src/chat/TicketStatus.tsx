// A dev ticket's state at the foot of its thread: while it runs, a line only while thimble's question about its code
// waits on the card (its Stop is the composer's stop square, ChatPanel), Discard while it waits in the queue, Start and
// Discard for main's ticket that waits for the analyst while another runs (`held`), and after a failure or a stop the
// reason with Retry and Discard. An applied ticket shows nothing. The ticket is re-fetched on each `ticket` stream event.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { Ticket } from '../lib/types'
import { Note, openThread } from './Notes'

/** The ends that leave nothing applied and take Retry and Discard (backend dev.RETRYABLE). */
const ENDED = new Set(['failed', 'needs manual merge', 'rolled back', 'stopped', 'reverted', 'dismissed'])

/** The line of main's ticket that waits for the analyst's Start while another ticket runs (backend dev.start_typed). */
export const HELD_LINE = 'Waits for your Start, since code tickets run one at a time'

/** What the line says for a ticket's status: the reason for a failure, and for a stop thimble made (main's quit:
 * backend dev._settle_ticket), a word for the rest; null for none. Pure. */
export function ticketStatusText(t: Pick<Ticket, 'status' | 'error' | 'held'>): string | null {
  switch (t.status) {
    case 'queued':
      return t.held ? HELD_LINE : 'Queued behind another ticket'
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
  const [busy, setBusy] = useState<string | null>(null)
  // the request itself is the telemetry record (lib/telemetry's wrapped fetch)
  const act = (what: 'retry' | 'dismiss' | 'start') => {
    setBusy(what)
    const call = what === 'retry' ? api.retryTicket(ticket.id) : what === 'start' ? api.startTicket(ticket.id) : api.dismissTicket(ticket.id)
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
  if (ticket.status === 'running') return waiting ? <Note className="chat-ticket-status" data-status="running" data-waiting="" text={WAITING_LINE} /> : null
  if (ticket.status === 'queued') {
    return (
      <Note
        className="chat-ticket-status"
        data-status="queued"
        text={text}
        chips={
          <>
            {ticket.held && (
              <Button size="sm" className="chat-ticket-act" busy={busy === 'start'} onClick={() => act('start')}>
                Start
              </Button>
            )}
            <Button size="sm" className="chat-ticket-act" busy={busy === 'dismiss'} onClick={() => act('dismiss')}>
              Discard
            </Button>
          </>
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
