// @vitest-environment jsdom
// Code tickets in the browser: Report a problem offers File a code ticket in a development install, which files the
// description as a ticket (the analyst's click, which starts the ticket's agent as a subagent of their Claude Code
// session) and opens its thread (src/shell/ProblemReport.tsx); main's ticket that waits while another runs shows Start
// and Discard at the foot of its thread (src/chat/TicketStatus.tsx).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HELD_LINE, TicketStatus, ticketStatusText } from '../../src/chat/TicketStatus.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { Ticket } from '../../src/lib/types.ts'
import { ProblemReportPopover, TITLE_CHARS, ticketTitle } from '../../src/shell/ProblemReport.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

let calls: [string, string, unknown][] = []
let tickets = ''

beforeEach(() => {
  calls = []
  tickets = ''
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push([method, String(url), init?.body ? JSON.parse(String(init.body)) : null])
    const path = String(url)
    const body = path.endsWith('/dev/status')
      ? { running: false, tickets, queued: 0 }
      : path.endsWith('/dev/tickets') && method === 'POST'
        ? { id: 't1', n: 1, workspace: 'mini', title: 'x', body: 'y', status: 'running', chat: 'c-ticket' }
        : path.includes('/dev/tickets/')
          ? { id: 't2', n: 2, workspace: 'mini', title: 'Wider pane', body: '', status: 'queued', chat: 'c2', held: false }
          : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)

describe('File a code ticket in Report a problem', () => {
  test("a ticket's title is the description's first line with words, cut to a length", () => {
    expect(ticketTitle('\n  The chart cuts off its bars  \nmore')).toBe('The chart cuts off its bars')
    const long = ticketTitle('x'.repeat(200))
    expect(long).toHaveLength(TITLE_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  test('in a development install it files the description and opens the ticket\'s thread', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const opened: string[] = []
    const off = bus.on('openChat', (e) => opened.push(e.chatId))
    const onClose = vi.fn()
    await mount(<ProblemReportPopover ws="mini" anchor={anchor} open onClose={onClose} prefill={{ description: 'The chart cuts off its bars\nIn the Files tab.', focus: [] }} />)
    await settle()
    const file = button(document.body, 'File a code ticket')!
    expect(file).toBeTruthy()
    await act(async () => file.click())
    await settle()
    const post = calls.find(([m, u]) => m === 'POST' && u.endsWith('/dev/tickets'))!
    expect(post[2]).toEqual({ workspace: 'mini', title: 'The chart cuts off its bars', body: 'The chart cuts off its bars\nIn the Files tab.', source: 'ui' })
    expect(opened).toEqual(['c-ticket'])
    expect(onClose).toHaveBeenCalled()
    off()
  })

  test('a release install offers no ticket', async () => {
    tickets = "thimble's own code can only be changed in a development install"
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    await mount(<ProblemReportPopover ws="mini" anchor={anchor} open onClose={() => undefined} />)
    await settle()
    expect(calls.some(([, u]) => u.endsWith('/dev/status'))).toBe(true)
    expect(button(document.body, 'File a code ticket')).toBeUndefined()
    expect(button(document.body, 'Prepare bundle')).toBeTruthy()
  })
})

describe("a ticket main filed while another runs", () => {
  const held: Ticket = { id: 't2', n: 2, workspace: 'mini', title: 'Wider pane', body: '', status: 'queued', chat: 'c2', held: true }

  test('says it waits for the analyst, and Start starts it', async () => {
    expect(ticketStatusText(held)).toBe(HELD_LINE)
    expect(ticketStatusText({ ...held, held: false })).toBe('Queued behind another ticket')
    const changed: Ticket[] = []
    const el = await mount(<TicketStatus ticket={held} onChange={(t) => changed.push(t)} />)
    expect(el.textContent).toContain(HELD_LINE)
    expect(button(el, 'Discard')).toBeTruthy()
    await act(async () => button(el, 'Start')!.click())
    await settle()
    expect(calls.some(([m, u]) => m === 'POST' && u.endsWith('/dev/tickets/t2/start'))).toBe(true)
    expect(changed.at(-1)?.held).toBe(false)
  })

  test("a ticket thimble stopped as main went into plan mode says why with Retry, and one the analyst stopped says Stopped (live check U4)", async () => {
    const plan = "Stopped when your Claude Code session went into plan mode, where thimble's agents would have to ask you before every step. Leave plan mode (shift+tab in your terminal), then choose Retry on the ticket."
    const stopped: Ticket = { ...held, held: false, status: 'stopped', error: plan }
    expect(ticketStatusText(stopped)).toBe(plan)
    expect(ticketStatusText({ ...stopped, error: 'thimble stopped when its Claude Code session ended' })).toBe('thimble stopped when its Claude Code session ended')
    expect(ticketStatusText({ ...stopped, error: null })).toBe('Stopped')
    const el = await mount(<TicketStatus ticket={stopped} onChange={() => undefined} />)
    expect(el.textContent).toContain('then choose Retry on the ticket.')
    expect(button(el, 'Retry')).toBeTruthy()
  })

  test('a ticket queued by a click shows no Start', async () => {
    const el = await mount(<TicketStatus ticket={{ ...held, held: false }} onChange={() => undefined} />)
    expect(button(el, 'Start')).toBeUndefined()
  })
})
