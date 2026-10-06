// @vitest-environment jsdom
// The card of one of thimble's agents run as a subagent of main (src/chat/AgentCard.tsx, src/chat/subagent.ts): its
// header names the model and effort its run used; the orientation waiting for its critic says so; a run main's quit
// stopped says so, with Write again on a writer's card and no Resume anywhere; the terminal is named as Claude Code
// shows the agent (↓ while it runs, /tasks once it finished); an orientation of an earlier session or version cannot
// take a message here, and the composer says how to continue it.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentCard } from '../../src/chat/AgentCard.tsx'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { STOPPED_CONTINUE_LINE, continueOf, continueText, planLine, planStoppedLine, runValues, stoppedLine, terminalLine, valuesText } from '../../src/chat/subagent.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let posted: [string, unknown][] = []
beforeEach(() => {
  posted = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push([String(url), JSON.parse(String(init.body))])
    return new Response(JSON.stringify(init?.method === 'POST' ? { agentId: 'a2' } : []), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const meta = (extra: Partial<ChatMeta>): ChatMeta =>
  ({ id: 'o1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: '2026-10-06T10:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, status: 'running', route: 'subagent', agent_id: 'ag1', agent_type: 'thimble:orientation', values: { model: 'claude-opus-5-5[1m]', effort: 'max' }, session: 's1', sessions: ['s1'], ...extra }) as ChatMeta
const records: ChatRecord[] = [{ type: 'user', text: 'Orient on the moderators.' }]
const card = (m: ChatMeta, main: Partial<ChatMeta> | null = null) =>
  mount(
    <ThreadsContext.Provider value={{ labels: new Map(), main: main as ChatMeta | null }}>
      <AgentCard ws="mini" chat={m.id} role={m.role} title={m.title} log={{ meta: m, records, error: null }} />
    </ThreadsContext.Provider>,
  )

describe('the words', () => {
  test("a run's values: what its transcript recorded, else its own", () => {
    expect(valuesText(runValues(meta({})))).toBe('Opus 5.5 · max')
    expect(valuesText(runValues(meta({ run: 1, ran: { '1': { model: 'claude-sonnet-5', effort: 'high' } } })))).toBe('Sonnet 5 · high')
    expect(valuesText({ model: 'claude-haiku-4-5-20251001', effort: '' })).toBe('Haiku 4.5')
  })

  test('the terminal: ↓ while it runs, /tasks once it finished', () => {
    expect(terminalLine(meta({}), true)).toBe('In your terminal: ↓ to thimble:orientation in the agent tray, then Enter.')
    expect(terminalLine(meta({}), false)).toBe('In your terminal: /tasks, then Enter on thimble:orientation.')
  })

  test("a stop by main's quit, and an orientation of an earlier session or version", () => {
    expect(stoppedLine(meta({ status: 'stopped', stopped_by: 'quit' }))).toBe('Stopped when your Claude Code session ended. Run `thimble --continue` in this folder, then send it a message to continue.')
    expect(stoppedLine(meta({ role: 'writer', status: 'stopped', stopped_by: 'quit' }))).toBe('Stopped when your Claude Code session ended.')
    expect(continueOf(meta({}), 's1')).toBe('here')
    expect(continueOf(meta({}), 's2')).toBe('earlier-session')
    expect(continueOf(meta({ route: null, agent_id: null }), 's1')).toBe('earlier-version')
    expect(continueText('earlier-session', 'abc-123')).toBe('This orientation ran in an earlier Claude Code session. To continue it, quit and run `thimble -r abc-123` in this folder, or start a new orientation.')
    expect(continueText('earlier-version', '')).toBe('This orientation ran in an earlier version of thimble and cannot be continued. Start a new orientation to explore further.')
  })

  test('a run thimble stopped when main went into plan mode says why, and how to go on once main leaves it (U4)', () => {
    expect(stoppedLine(meta({ status: 'stopped', stopped_by: 'plan' }))).toBe(planLine('orient'))
    expect(planLine('orient')).toMatch(/went into plan mode.*Leave plan mode \(shift\+tab in your terminal\), then send it a message to continue it\.$/)
    expect(stoppedLine(meta({ role: 'writer', status: 'stopped', stopped_by: 'plan' }))).toMatch(/then choose Write again\.$/)
    expect(planLine('dev')).toMatch(/Retry/)
  })

  test("the thread's own end line for such a run, a view's build among them, whose transcript ends with only \"stopped\" (live check U4)", () => {
    const build = meta({ role: 'dev', status: 'stopped', stopped_by: 'plan' })
    expect(planStoppedLine(build, false)).toMatch(/went into plan mode.*then choose Retry on the view\.$/)
    expect(planStoppedLine(meta({ status: 'stopped', stopped_by: 'plan' }), false)).toBe(planLine('orient'))
    expect(planStoppedLine(build, true)).toBeNull()
    expect(planStoppedLine(meta({ role: 'dev', status: 'stopped', stopped_by: 'analyst' }), false)).toBeNull()
    expect(planStoppedLine(null, false)).toBeNull()
  })

  test('an orientation stopped with Esc in its agent view, which Claude Code resumes no more, takes a message that continues it (U2)', () => {
    const stopped = meta({ status: 'stopped', stopped_by: 'user', continue: 'stopped-by-user' })
    expect(stoppedLine(stopped)).toBe('Stopped with Esc in your terminal.')
    expect(continueOf(stopped, 's1')).toBe('stopped-by-user')
    // no closed text: the composer stays, and its message starts a new run in the thread (no New orientation offer)
    expect(continueText('stopped-by-user', '')).toBe('')
    expect(STOPPED_CONTINUE_LINE).toMatch(/Send a message to continue it/)
  })
})

describe('the card', () => {
  test("names the run's model and effort, and while the orientation waits for its critic says so", async () => {
    const el = await card(meta({ paused: 'critique' }))
    expect(el.textContent).toContain('Opus 5.5 · max')
    expect(el.querySelector('.chat-sub-paused')?.textContent).toBe('Waiting for the critique')
    expect(el.querySelector('.chat-task-stop')).not.toBeNull()
  })

  test("without thimble's module in main's session there is no Stop, and the card says to press Esc in the terminal", async () => {
    const el = await card(meta({}), { module: false })
    expect(el.querySelector('.chat-task-stop')).toBeNull()
    expect(el.querySelector('.chat-sub-nostop')?.textContent).toMatch(/press Esc in its view/)
  })

  test("a writer main's quit stopped offers Write again, which posts again; nothing offers Resume", async () => {
    const el = await card(meta({ id: 'w1', role: 'writer', title: 'report', doc: 'report', status: 'stopped', stopped_by: 'quit', request: 'r9', agent_type: 'thimble:writer' }))
    expect(el.querySelector('.chat-sub-stopped')?.textContent).toBe('Stopped when your Claude Code session ended.')
    expect(el.textContent).not.toMatch(/Resume/)
    const again = el.querySelector<HTMLButtonElement>('.chat-task-again')!
    expect(again.textContent).toBe('Write again')
    await act(async () => again.click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/subagents/again', { request: 'r9' }]])
    const orient = await card(meta({ status: 'stopped', stopped_by: 'quit' }))
    expect(orient.querySelector('.chat-task-again')).toBeNull()
    expect(orient.textContent).toContain('In your terminal: /tasks, then Enter on thimble:orientation.')
  })
})
