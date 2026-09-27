// @vitest-environment jsdom
// A running dev ticket's line at the foot of its thread (src/chat/TicketStatus.tsx): Stop, and "Waiting for permission"
// while a request of its session is on the card.
import { afterEach, expect, test } from 'vitest'
import { TicketStatus, WAITING_LINE } from '../../src/chat/TicketStatus.tsx'
import type { Ticket } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const ticket = { id: 't1', n: 3, title: 'Darker header', status: 'running' } as Ticket

test('a running ticket says it waits for permission while its session asks, and nothing else otherwise', async () => {
  const waiting = await mount(<TicketStatus ticket={ticket} waiting onChange={() => undefined} />)
  expect(waiting.querySelector('.chat-ticket-status')?.getAttribute('data-waiting')).toBe('')
  expect(waiting.querySelector('.chat-note-text')?.textContent).toBe(WAITING_LINE)
  expect(WAITING_LINE).toBe('Waiting for permission')
  const working = await mount(<TicketStatus ticket={ticket} onChange={() => undefined} />)
  expect(working.querySelector('.chat-note-text')).toBeNull()
  expect(working.querySelector('.chat-ticket-act')?.textContent).toBe('Stop')
})
