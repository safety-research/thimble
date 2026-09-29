// @vitest-environment jsdom
// Stop in the composer, as in Claude (src/components/Composer.tsx, src/chat/ChatPanel.tsx composerStopOf): while an
// agent the browser can stop runs, the send square is its stop square while the field is empty and the send square
// again once there is text; a step's thread carries its running parent's Stop. The Stop goes out through stopRun (a
// session's through stopSession, a ticket's through dev.stop_ticket) and says in a toast when it could not stop; in an
// agent's own thread its card leaves Stop to the composer (AgentCard stopHere). The transcript of a running dev ticket
// carries no Stop of its own (src/chat/TicketStatus.tsx).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ComposerFrame } from '../../src/components/Composer.tsx'
import { AgentCard, stopSession } from '../../src/chat/AgentCard.tsx'
import { composerStopOf, stopRun } from '../../src/chat/ChatPanel.tsx'
import { TicketStatus, WAITING_LINE } from '../../src/chat/TicketStatus.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta, Ticket } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const stopSquare = (el: Element) => el.querySelector<HTMLButtonElement>('button.composer-send[aria-label^="Stop"]')

describe('the composer while an agent runs', () => {
  test('an empty field shows the stop square, named for what it stops, which stops it', async () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    const el = await mount(<ComposerFrame value="" onChange={() => undefined} onSubmit={onSubmit} stop={{ label: 'Stop the orientation', onStop }} />)
    const btn = stopSquare(el)!
    expect(btn.getAttribute('aria-label')).toBe('Stop the orientation')
    expect(btn.type).toBe('button')
    expect(btn.disabled).toBe(false)
    btn.click()
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('while the stop request is in flight the square is busy and ignores clicks', async () => {
    const onStop = vi.fn()
    const el = await mount(<ComposerFrame value="" onChange={() => undefined} onSubmit={() => undefined} stop={{ label: 'Stop ticket #3', onStop, busy: true }} />)
    const btn = stopSquare(el)!
    expect(btn.getAttribute('aria-busy')).toBe('true')
    btn.click()
    expect(onStop).not.toHaveBeenCalled()
  })

  test('text in the field brings the send square back, which sends it', async () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    const el = await mount(<ComposerFrame value="and the runs?" onChange={() => undefined} onSubmit={onSubmit} stop={{ label: 'Stop the orientation', onStop }} />)
    expect(stopSquare(el)).toBeNull()
    const btn = el.querySelector<HTMLButtonElement>('button.composer-send')!
    expect(btn.getAttribute('aria-label')).toBe('Send')
    btn.click()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  test('without a Stop the empty field shows the disabled send square', async () => {
    const el = await mount(<ComposerFrame value="" onChange={() => undefined} onSubmit={() => undefined} />)
    expect(stopSquare(el)).toBeNull()
    expect(el.querySelector<HTMLButtonElement>('button.composer-send')!.disabled).toBe(true)
  })
})

describe('what the composer stops (composerStopOf)', () => {
  const meta = (id: string, status: string) => ({ id, status }) as Pick<ChatMeta, 'id' | 'status'>
  const ticket = (status: string, chat = 'd1') => ({ id: 't1', n: 3, status, chat }) as Pick<Ticket, 'id' | 'n' | 'status' | 'chat'>

  test("a running session of thimble's: its chat, named for its role", () => {
    expect(composerStopOf('orient', meta('o1', 'running'), null)).toEqual({ kind: 'session', chat: 'o1', role: 'orient', label: 'Stop the orientation' })
    expect(composerStopOf('writer', meta('w1', 'running'), null)?.label).toBe('Stop the writer')
    expect(composerStopOf('check', meta('c1', 'running'), null)?.label).toBe('Stop the check')
    expect(composerStopOf('orient', meta('o1', 'done'), null)).toBeNull()
  })

  test('a running dev ticket of this chat, not a queued one or a retried ticket in another chat', () => {
    expect(composerStopOf('dev', meta('d1', 'running'), ticket('running'))).toEqual({ kind: 'ticket', ticket: 't1', label: 'Stop ticket #3' })
    expect(composerStopOf('dev', meta('d1', 'running'), ticket('queued'))).toBeNull()
    expect(composerStopOf('dev', meta('d1', 'running'), ticket('running', 'd2'))).toBeNull()
    expect(composerStopOf('dev', meta('d1', 'running'), null)).toBeNull()
  })

  test("main and its threads: none, since the browser cannot stop main's turn", () => {
    expect(composerStopOf('main', meta('main', 'running'), null)).toBeNull()
    expect(composerStopOf('thread', meta('th1', 'running'), null)).toBeNull()
  })

  test("a step: its parent's Stop while the parent runs, since its composer sends to the parent", () => {
    const parent = (status: string, role = 'orient') => ({ id: 'o1', status, role }) as Pick<ChatMeta, 'id' | 'status' | 'role'>
    expect(composerStopOf('step', meta('s1', 'running'), null, parent('running'))).toEqual({ kind: 'session', chat: 'o1', role: 'orient', label: 'Stop the orientation' })
    expect(composerStopOf('step', meta('s1', 'running'), null, parent('done'))).toBeNull()
    expect(composerStopOf('step', meta('s1', 'running'), null, null)).toBeNull()
  })
})

describe("a running ticket's foot", () => {
  const running = { id: 't1', n: 3, status: 'running', chat: 'd1', title: 'x' } as Ticket
  test('shows no Stop: nothing, or the line while a permission request waits', async () => {
    const quiet = await mount(<TicketStatus ticket={running} onChange={() => undefined} />)
    expect(quiet.querySelector('.chat-ticket-status')).toBeNull()
    const waiting = await mount(<TicketStatus ticket={running} waiting onChange={() => undefined} />)
    expect(waiting.textContent).toContain(WAITING_LINE)
    expect(waiting.querySelector('button')).toBeNull()
  })
})

describe('the Stop sent', () => {
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  const toasts = () => {
    const seen: { text: string; kind?: string }[] = []
    const off = bus.on('toast', (t) => seen.push(t))
    return { seen, off }
  }
  const session = { kind: 'session', chat: 'o1', role: 'orient', label: 'Stop the orientation' } as const

  test('a session stopped resolves true with no toast', async () => {
    answer({ stopped: true })
    const t = toasts()
    expect(await stopRun('mini', session, () => undefined)).toBe(true)
    expect(t.seen).toEqual([])
    t.off()
  })

  test('no session to stop, or a failed request, resolves false with an error toast', async () => {
    const t = toasts()
    answer({ stopped: false })
    expect(await stopSession('mini', 'o1', 'orient')).toBe(false)
    answer({ detail: 'down' }, 500)
    expect(await stopRun('mini', session, () => undefined)).toBe(false)
    expect(t.seen.map((x) => [x.kind, x.text.split(':')[0]])).toEqual([['error', 'Could not stop it'], ['error', 'Could not stop it']])
    t.off()
  })

  test('a subagent of main is asked of main: an info toast, not an error', async () => {
    answer({ stopped: false, asked: 'main' })
    const t = toasts()
    expect(await stopSession('mini', 'a1', 'orient')).toBe(true)
    expect(t.seen).toEqual([{ text: 'Asked main to stop it.' }])
    t.off()
  })

  test("a ticket's Stop reads the ticket again, and a failure says so in the same form", async () => {
    const got: Ticket[] = []
    answer({ id: 't1', status: 'stopped' })
    expect(await stopRun('mini', { kind: 'ticket', ticket: 't1', label: 'Stop ticket #3' }, (t) => got.push(t))).toBe(true)
    expect(got.map((t) => t.status)).toEqual(['stopped'])
    const t = toasts()
    answer({ detail: 'the ticket is not running' }, 409)
    expect(await stopRun('mini', { kind: 'ticket', ticket: 't1', label: 'Stop ticket #3' }, () => undefined)).toBe(false)
    expect(t.seen.map((x) => [x.kind, x.text.startsWith('Could not stop the ticket: ')])).toEqual([['error', true]])
    t.off()
  })
})

describe("a running session's card", () => {
  const log = { meta: { id: 'o1', kind: 'agent', role: 'orient', title: 'Orientation', status: 'running' } as ChatMeta, records: [], error: null }

  test("keeps its Stop in main, and leaves it to the composer in its own thread while the spinner stays", async () => {
    vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
    const inMain = await mount(<AgentCard ws="mini" chat="o1" role="orient" title="Orientation" log={log} />)
    await settle()
    expect(inMain.querySelector('.chat-task-stop')).not.toBeNull()
    unmountAll()
    const own = await mount(<AgentCard ws="mini" chat="o1" role="orient" title="Orientation" log={log} stopHere={false} />)
    await act(async () => undefined)
    await settle()
    expect(own.querySelector('.chat-task-stop')).toBeNull()
    expect(own.querySelector('[aria-label="running"]')).not.toBeNull()
  })
})
