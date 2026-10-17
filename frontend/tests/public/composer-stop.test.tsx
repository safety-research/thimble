// @vitest-environment jsdom
// Stop in the composer, as in Claude (src/components/Composer.tsx, src/chat/ChatPanel.tsx composerStopOf): while what
// the browser can stop runs (main's turn, a side thread's fork, one of thimble's agents), the send square is its stop
// square while the field is empty and the send square again once there is text; a step's thread carries its running
// parent's Stop. The Stop goes out through stopRun (main's, a thread's or a session's through stopAnswer, a ticket's
// through dev.stop_ticket, a view's build or review through its own route); when it could not stop, the Stop itself
// says why and what to do, as it does before it is pressed while thimble's module does not run in main's session; in
// an agent's own thread its card leaves Stop to the composer (AgentCard stopHere), whose stopSession says it in a
// toast. The transcript of a running dev ticket carries no Stop of its own (src/chat/TicketStatus.tsx).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ComposerFrame } from '../../src/components/Composer.tsx'
import { stopSession } from '../../src/chat/AgentCard.tsx'
import { stopBlockedLine, stopRun, stopStillLine } from '../../src/chat/ChatPanel.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, unmountAll } from './mount.tsx'

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

  test('a Stop that did not stop says why to a screen reader, its tooltip naming it while the line above says the rest', async () => {
    const why = 'thimble could not stop main: its hello was refused. To stop main, press Esc in your Claude Code terminal.'
    const el = await mount(<ComposerFrame value="" onChange={() => undefined} onSubmit={() => undefined} stop={{ label: why, tip: 'Stop main', onStop: () => undefined }} />)
    const btn = stopSquare(el) ?? el.querySelector<HTMLButtonElement>('button.composer-send')!
    expect(btn.getAttribute('aria-label')).toBe(why)
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

  test('nothing to stop resolves false with an error toast; one thimble could not pass on says how to stop it in the terminal', async () => {
    const t = toasts()
    answer({ stopped: false })
    expect(await stopSession('mini', 'o1', 'orient')).toBe(false)
    answer({ stopped: false, kind: 'no-module', reason: "Claude Code did not load thimble's hooks module" })
    expect(await stopSession('mini', 'o1', 'orient')).toBe(false)
    expect(t.seen.map((x) => x.kind)).toEqual(['error', 'error'])
    expect(t.seen[0].text).toMatch(/^Could not stop it/)
    expect(t.seen[1].text).toBe("thimble could not stop it: Claude Code did not load thimble's hooks module. Stop it in your terminal: ↓ to it in the agent tray, Enter, then Esc.")
    t.off()
  })

  test("the composer's Stop that did not stop answers why and what to do, for the Stop to say, and no toast", async () => {
    const t = toasts()
    answer({ detail: 'down' }, 500)
    const a = await stopRun('mini', session, () => undefined)
    expect(a.ok).toBe(false)
    expect(!a.ok && a.text).toMatch(/^thimble could not stop it: 500 down\. Stop it in your terminal/)
    answer({ stopped: false, kind: 'no-module', reason: 'its hello was refused' })
    const m = await stopRun('mini', { kind: 'session', chat: 'main', role: 'main', label: 'Stop main' }, () => undefined)
    expect(!m.ok && m.text).toBe('thimble could not stop main: its hello was refused. To stop main, press Esc in your Claude Code terminal.')
    answer({ stopped: true })
    expect(await stopRun('mini', session, () => undefined)).toEqual({ ok: true })
    expect(t.seen).toEqual([])
    t.off()
  })

  test("before it is pressed, the Stop says why it cannot stop while thimble's module does not run in main's session", () => {
    const main = { kind: 'session', chat: 'main', role: 'main', label: 'Stop main' } as const
    expect(stopBlockedLine(main, { module: true, module_why: '' })).toBeNull()
    expect(stopBlockedLine(main, { module: false, module_why: 'THIMBLE_NO_MODULE is set' })).toBe('thimble cannot stop main from here: THIMBLE_NO_MODULE is set. To stop main, press Esc in your Claude Code terminal.')
    expect(stopBlockedLine({ kind: 'session', chat: 't1', role: 'thread', label: 'Stop the thread' }, { module: false })).toMatch(/^thimble cannot stop it from here: .+\. Stop it in your terminal/)
    expect(stopBlockedLine({ kind: 'ticket', ticket: 'k1', label: 'Stop ticket #1' }, { module: false })).toBeNull()
  })

  test('a run that goes on after its Stop went through: the Stop says so and how to stop it in the terminal', () => {
    expect(stopStillLine({ kind: 'session', chat: 'main', role: 'main', label: 'Stop main' })).toBe('Main is still running. To stop main, press Esc in your Claude Code terminal.')
    expect(stopStillLine(session)).toMatch(/^It is still running\. Stop it in your terminal/)
    expect(stopStillLine({ kind: 'view', slug: 'v', review: false, label: 'Stop the build' })).toBeNull()
  })
})
