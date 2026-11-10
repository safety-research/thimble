// @vitest-environment jsdom
// The foot of an earlier code ticket's thread (src/chat/TicketStatus.tsx). Nothing starts a code ticket: a change to
// thimble's code is asked for with /thimble-fix. So a ticket that still waits says how to ask now and offers Discard
// alone, and one that failed shows its reason with Discard alone.
import { afterEach, expect, test } from 'vitest'
import { FIX_ALONE } from '../../src/chat/fix.ts'
import { TicketStatus } from '../../src/chat/TicketStatus.tsx'
import type { Ticket } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

const ticket = (over: Partial<Ticket>): Ticket => ({ id: 'ab12cd34', n: 2, workspace: 'mini', title: 'the canvas should scroll', body: '', status: 'queued', chat: 't1', ...over })
const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent)

afterEach(unmountAll)

test('a ticket that still waits says how to ask for the change now, with Discard and no Start', async () => {
  const el = await mount(<TicketStatus ticket={ticket({ held: true })} onChange={() => undefined} />)
  expect(el.querySelector('.chat-note-text')?.textContent).toBe(FIX_ALONE)
  expect(buttons(el)).toEqual(['Discard'])
})

test('a ticket that failed shows its reason, with Discard and no Retry', async () => {
  const el = await mount(<TicketStatus ticket={ticket({ status: 'failed', error: 'the dev agent made no change' })} onChange={() => undefined} />)
  expect(el.querySelector('.chat-ticket-why')?.textContent).toBe('The dev agent made no change')
  expect(buttons(el)).toEqual(['Discard'])
})
