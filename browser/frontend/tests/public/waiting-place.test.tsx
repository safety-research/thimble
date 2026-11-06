// @vitest-environment jsdom
// Where a request that waits for the analyst waits (src/chat/waiting.ts): at the thread the permission card's head
// names for it (src/chat/permissions.ts askThread). That thread's strip shows the wait dot in place of the spinner, the
// card of one of thimble's agents in main's chat says it waits, and the thread tree marks that thread's row; no other
// strip or row waits on it. Main's session relays the requests of its agents (with the server's runtime off, main runs
// in the analyst's terminal), each naming the chat of the agent that asked: none for main's own, the thread's for a
// thread's fork, the agent's for one of thimble's agents run as main's subagent, and its own chat for a subagent of
// main's own, which the tree does not list, so that request waits at main.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentCard } from '../../src/chat/AgentCard.tsx'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import type { ChatMeta, ChatRecord, PermissionRequest } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const LATER = '2026-10-15T10:00:05+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
const MAIN = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: true, attached: ATTACHED, unread: [] } as unknown as ChatMeta
const THREAD = { id: 'th1', kind: 'thread', role: 'thread', title: 'push-retries', created_at: T, parent: 'main', anchor: null, anchor_text: null, running: true, fork: { agent_id: 'afork1' } } as unknown as ChatMeta
/** a subagent of main's own (an Agent call of main's), which the tree does not list */
const SUB = { id: 'sa1', kind: 'agent', role: 'subagent', title: 'Explore the runs', created_at: LATER, parent: 'main', status: 'running', agent_id: 'asub1', session: 's1' } as unknown as ChatMeta
/** the orientation, run as main's subagent */
const ORIENT = { id: 'or1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: T, parent: 'main', status: 'running', route: 'subagent', agent_id: 'aor1', session: 's1', sessions: ['s1'] } as unknown as ChatMeta
/** A request main's session relays for the agent of `chat`, none for its own; Claude Code asks one of thimble's agents'
 * in the terminal. */
const relayed = (chat?: string, terminal = false): PermissionRequest => ({ id: 'p1', tool: 'Bash', what: 'List the runs', since: LATER, ...(chat ? { chat } : {}), ...(terminal ? { terminal } : {}) })

let main: ChatMeta
let others: ChatMeta[]
let mainEvents: ChatRecord[]

beforeEach(() => {
  localStorage.clear()
  others = []
  main = MAIN
  mainEvents = [
    { type: 'user', text: 'Count the runs per agent.', by: 'browser' },
    { type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Explore the runs', prompt: 'List the runs.' } },
  ]
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const other = others.find((m) => u.endsWith(`/chats/${m.id}`))
    const body = other
      ? { meta: other, events: [] }
      : u.endsWith('/chats/main')
        ? { meta: main, events: mainEvents }
        : /\/chats(\?|$)/.test(u)
          ? [main, ...others]
          : /\/(proposals|notices|views)(\?|$)/.test(u)
            ? []
            : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** The chat panel showing the thread `current`, its tree open: the thread the permission card's head names, whether
 * the strip shows the wait dot or the spinner, and the rows of the tree that show the waiting dot. */
async function shown(current: string) {
  unmountAll()
  localStorage.setItem('thimble:mini:thread-current', JSON.stringify(current))
  localStorage.setItem('thimble:mini:threads-collapsed', JSON.stringify(false))
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await settle()
  const strip = el.querySelector('.chat-strip')
  return {
    from: el.querySelector('.chat-perm-from [data-thread]')?.getAttribute('data-thread') ?? null,
    strip: strip && (strip.querySelector('.chat-strip-wait-dot') ? 'dot' : strip.querySelector('.spinner') ? 'spinner' : 'none'),
    waiting: [...el.querySelectorAll('.tt-row[data-thread]')].filter((r) => r.querySelector('.tt-end .tt-waiting')).map((r) => r.getAttribute('data-thread')),
  }
}

describe('a request that waits for the analyst', () => {
  test("of main's own session waits at main: its strip, the card's head and its row in the tree", async () => {
    main = { ...MAIN, permissions: [relayed()] }
    expect(await shown('main')).toEqual({ from: 'main', strip: 'dot', waiting: ['main'] })
  })

  test("of a subagent of main's own, which the tree does not list, waits at main too", async () => {
    others = [SUB]
    main = { ...MAIN, permissions: [relayed('sa1')] }
    expect(await shown('main')).toEqual({ from: 'main', strip: 'dot', waiting: ['main'] })
  })

  test("of the orientation run as main's subagent waits at the orientation: its strip in its thread, and in main's chat while main is idle", async () => {
    others = [ORIENT]
    main = { ...MAIN, permissions: [relayed('or1', true)] }
    expect(await shown('or1')).toEqual({ from: 'or1', strip: 'dot', waiting: ['or1'] })
    // main's turn works on
    expect(await shown('main')).toEqual({ from: 'or1', strip: 'spinner', waiting: ['or1'] })
    // with main idle, main's chat shows the orientation's strip
    main = { ...main, running: false }
    mainEvents = [...mainEvents, { type: 'done' }]
    expect(await shown('main')).toEqual({ from: 'or1', strip: 'dot', waiting: ['or1'] })
  })

  test("of the orientation run as main's subagent puts the wait on the orientation's card in main's chat", async () => {
    const waits = async (mainMeta: ChatMeta) => {
      unmountAll()
      const el = await mount(
        <ThreadsContext.Provider value={{ labels: new Map(), metas: new Map([mainMeta, ORIENT].map((m) => [m.id, m])), main: mainMeta }}>
          <AgentCard ws="mini" chat="or1" role="orient" title="Orientation" log={{ meta: ORIENT, records: [], error: null }} />
        </ThreadsContext.Provider>,
      )
      return el.querySelector('.chat-task')?.getAttribute('data-waiting') ?? null
    }
    expect(await waits({ ...MAIN, permissions: [relayed('or1', true)] })).toBe('true')
    expect(await waits({ ...MAIN, permissions: [relayed()] })).toBeNull()
  })

  test("of a thread's fork waits at the thread, and main's turn works on", async () => {
    others = [THREAD]
    main = { ...MAIN, permissions: [relayed('th1')] }
    expect(await shown('th1')).toEqual({ from: 'th1', strip: 'dot', waiting: ['th1'] })
    expect(await shown('main')).toEqual({ from: 'th1', strip: 'spinner', waiting: ['th1'] })
  })
})
