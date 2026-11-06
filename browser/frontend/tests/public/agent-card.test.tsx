// @vitest-environment jsdom
// The card of one of thimble's agents run as a subagent of main (src/chat/AgentCard.tsx, src/chat/subagent.ts): its
// header names the model and effort its run used, its title at the card's edge while the card has nothing to open; a
// run main's quit stopped says so, with Write again on a writer's card and no Resume anywhere; no card says where the
// terminal shows the agent, in any state.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentCard } from '../../src/chat/AgentCard.tsx'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { runValues, stoppedLine, valuesText } from '../../src/chat/subagent.ts'
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
  ({ id: 'c1', kind: 'agent', role: 'check', title: 'Unverified', created_at: '2026-10-06T10:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, status: 'running', route: 'subagent', agent_id: 'ag1', agent_type: 'thimble:check', values: { model: 'claude-opus-5-5', effort: 'max' }, session: 's1', sessions: ['s1'], ...extra }) as ChatMeta
const brief: ChatRecord[] = [{ type: 'user', text: 'Check the report for claims no card shows.' }]
const card = (m: ChatMeta, main: Partial<ChatMeta> | null = null, records: ChatRecord[] = brief) =>
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

  test("a stop by main's quit, by the analyst, and with Esc in the terminal", () => {
    expect(stoppedLine(meta({ status: 'stopped', stopped_by: 'quit' }))).toBe('Stopped when your Claude Code session ended.')
    expect(stoppedLine(meta({ role: 'writer', status: 'stopped', stopped_by: 'quit' }))).toBe('Stopped when your Claude Code session ended.')
    expect(stoppedLine(meta({ status: 'stopped', stopped_by: 'analyst' }))).toBe('Stopped.')
    expect(stoppedLine(meta({ status: 'stopped', stopped_by: 'user' }))).toBe('Stopped with Esc in your terminal.')
  })
})

describe('the card', () => {
  test("names the run's model and effort, with its Stop while it runs", async () => {
    const el = await card(meta({}))
    expect(el.textContent).toContain('Opus 5.5 · max')
    expect(el.querySelector('.chat-task-stop')).not.toBeNull()
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
    const check = await card(meta({ status: 'stopped', stopped_by: 'quit' }))
    expect(check.querySelector('.chat-task-again')).toBeNull()
  })

  test('says nothing of where the terminal shows the agent, running, finished or stopped, in main or in its thread', async () => {
    const states: Partial<ChatMeta>[] = [{}, { status: 'done' }, { status: 'stopped', stopped_by: 'quit' }, { status: 'stopped', stopped_by: 'analyst' }, { status: 'stopped', stopped_by: 'user' }]
    for (const extra of states)
      for (const records of [brief, []]) {
        const el = await card(meta(extra), { attached: { session: 's1', cwd: '/c', since: '' } }, records)
        expect(el.textContent, JSON.stringify(extra)).not.toMatch(/In your terminal|agent tray|\/tasks/)
      }
    // a running card with nothing else to say has no empty row under its head
    const running = await card(meta({}), null, [])
    expect(running.querySelector('.toolcard-chips, .chat-sub-notes')).toBeNull()
  })

  test("the title starts at the card's edge while the card has nothing to open, behind the chevron once it has", async () => {
    // a run with no brief and no steps yet has nothing to open
    const bare = await card(meta({}), null, [])
    expect(bare.querySelector('.toolcard-head')?.getAttribute('role')).toBeNull()
    expect(bare.querySelector('.toolcard-caret')).toBeNull()
    expect(bare.querySelector('.toolcard-head > .chat-task-title, .toolcard-head > .toolcard-title')).not.toBeNull()
    expect(bare.querySelector('.toolcard-head')?.firstElementChild?.classList.contains('toolcard-title')).toBe(true)
    // a brief is behind the chevron
    const withBrief = await card(meta({}))
    expect(withBrief.querySelector('.toolcard-head')?.firstElementChild?.classList.contains('toolcard-caret')).toBe(true)
    expect(withBrief.querySelector('.toolcard-caret svg')).not.toBeNull()
  })
})
