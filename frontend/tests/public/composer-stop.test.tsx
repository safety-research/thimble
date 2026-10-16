// @vitest-environment jsdom
// Stop in the composer, as in Claude (src/components/Composer.tsx, src/chat/ChatPanel.tsx composerStopOf): while what
// the browser can stop runs (main's turn, a side thread's fork, one of thimble's agents), the send square is its stop
// square while the field is empty and the send square again once there is text; a step's thread carries its running
// parent's Stop. The Stop goes out through stopRun (main's, a thread's or a session's through stopSession, a ticket's
// through dev.stop_ticket, a view's build or review through its own route) and says in a toast when it could not stop;
// in an agent's own thread its card leaves Stop to the composer (AgentCard stopHere). The transcript of a running dev
// ticket carries no Stop of its own (src/chat/TicketStatus.tsx).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ComposerFrame } from '../../src/components/Composer.tsx'
import { stopSession } from '../../src/chat/AgentCard.tsx'
import { stopRun } from '../../src/chat/ChatPanel.tsx'
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
    answer({ detail: 'down' }, 500)
    expect(await stopRun('mini', session, () => undefined)).toBe(false)
    expect(t.seen.map((x) => x.kind)).toEqual(['error', 'error', 'error'])
    expect(t.seen[0].text).toMatch(/^Could not stop it/)
    expect(t.seen[1].text).toBe("thimble could not stop it: Claude Code did not load thimble's hooks module. Stop it in your terminal: ↓ to it in the agent tray, Enter, then Esc.")
    expect(t.seen[2].text).toMatch(/^thimble could not stop it: 500 down/)
    t.off()
  })
})
