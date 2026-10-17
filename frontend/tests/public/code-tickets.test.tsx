// @vitest-environment jsdom
// Code tickets in the browser: Report a problem offers Ask Claude to fix it in a development install, which files the
// description as a ticket (the analyst's click, which starts the ticket's agent as a subagent of their Claude Code
// session) and opens its thread (src/shell/ProblemReport.tsx); main's ticket that waits while another runs shows Start
// and Discard at the foot of its thread (src/chat/TicketStatus.tsx).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { ProblemReportPopover } from '../../src/shell/ProblemReport.tsx'
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

describe('Ask Claude to fix it in Report a problem', () => {

  test('in a development install it files the description and opens the ticket\'s thread', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const opened: string[] = []
    const off = bus.on('openChat', (e) => opened.push(e.chatId))
    const onClose = vi.fn()
    await mount(<ProblemReportPopover ws="mini" anchor={anchor} open onClose={onClose} prefill={{ description: 'The chart cuts off its bars\nIn the Files tab.', focus: [] }} />)
    await settle()
    const file = button(document.body, 'Ask Claude to fix it')!
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
    expect(button(document.body, 'Ask Claude to fix it')).toBeUndefined()
    expect(button(document.body, 'Make report file')).toBeTruthy()
  })
})
