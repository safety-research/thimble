// @vitest-environment jsdom
// While Claude Code asks one of thimble's agents a permission prompt in the terminal (Manual mode), main's meta holds the
// request marked `terminal`, naming the agent's chat (backend events._hold). Every place that shows that agent's state
// then says it waits for the analyst's answer there, in place of its working state, and goes back once the request
// leaves main's meta (src/chat/waiting.ts terminalWaits and useTerminalWaits).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { subagentNotes, SubagentNotes } from '../../src/chat/AgentCard.tsx'
import { pickItems, threadNodes } from '../../src/chat/threads.ts'
import { TERMINAL_WAIT, terminalWaits, useTerminalWaits } from '../../src/chat/waiting.ts'
import { ThreadTree } from '../../src/components/ThreadTree.tsx'
import { buildLabel } from '../../src/files/ViewsBar.tsx'
import { api } from '../../src/lib/api'
import { bus } from '../../src/lib/bus'
import type { ChatMeta, PermissionRequest } from '../../src/lib/types.ts'
import { checkRunLabel } from '../../src/report/Checks.tsx'
import { WriteAction } from '../../src/report/WriteAction.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const meta = (m: Partial<ChatMeta> & { id: string }): ChatMeta =>
  ({ kind: 'agent', role: 'writer', title: '', created_at: '2026-10-15T20:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, ...m }) as ChatMeta

const ask = (id: string, chat: string | null, terminal = true): PermissionRequest =>
  ({ id, tool: 'Bash', what: 'Bash', input: '{"command": "ls"}', since: '2026-10-15T20:01:00Z', ...(chat ? { chat } : {}), ...(terminal ? { terminal: true } : {}) }) as PermissionRequest

const chats = (permissions: PermissionRequest[]): ChatMeta[] => [
  meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null, permissions }),
  meta({ id: 'orient-1', role: 'orient', title: 'Orientation', status: 'running' }),
  meta({ id: 'critic-1', role: 'step', title: 'critique', parent: 'orient-1', status: 'running' }),
  meta({ id: 'writer-1', role: 'writer', title: 'Write report', status: 'running' }),
]

describe("the chats whose agent waits in the terminal", () => {
  test("those main's terminal requests name, and every chat each runs under; no other request counts", () => {
    expect(terminalWaits(null, chats([]))).toEqual(new Set())
    expect(terminalWaits(null, chats([ask('h1', 'writer-1')]))).toEqual(new Set(['writer-1']))
    // the critique's prompt: the orientation waits on it too
    expect(terminalWaits(null, chats([ask('h2', 'critic-1')]))).toEqual(new Set(['critic-1', 'orient-1']))
    // main's own prompt, a fork's (answered in the browser), and one that names no chat
    expect(terminalWaits(null, chats([ask('h3', 'writer-1', false), ask('h4', null)]))).toEqual(new Set())
    // main's meta passed on its own, as the chat panel has it
    const [main, ...rest] = chats([ask('h5', 'writer-1')])
    expect(terminalWaits(main, rest)).toEqual(new Set(['writer-1']))
    // a cycle of parents ends the walk
    const loop = [meta({ id: 'main', kind: 'main', parent: null, permissions: [ask('h6', 'a')] }), meta({ id: 'a', parent: 'b' }), meta({ id: 'b', parent: 'a' })]
    expect(terminalWaits(null, loop)).toEqual(new Set(['a', 'b']))
  })

  test('read once for every component that asks, again on a `chat` record, and empty once the request is gone', async () => {
    let list = chats([ask('h1', 'writer-1')])
    const read = vi.spyOn(api, 'chats').mockImplementation(async () => list)
    const seen: string[][] = []
    function Probe({ tag }: { tag: string }) {
      const waits = useTerminalWaits('ws-tw')
      seen.push([tag, ...[...waits].sort()])
      return <span data-probe={tag}>{[...waits].join(',')}</span>
    }
    const el = await mount(
      <>
        <Probe tag="a" />
        <Probe tag="b" />
      </>,
    )
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[data-probe="a"]')!.textContent).toBe('writer-1')
    expect(el.querySelector('[data-probe="b"]')!.textContent).toBe('writer-1')
    // answered in the terminal: the backend takes the request off main's meta, and the stream says main's chat changed
    list = chats([])
    await act(async () => {
      bus.emit('chat', { chat: 'main' })
      await new Promise((r) => setTimeout(r, 300)) // past the refetch's debounce
    })
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(el.querySelector('[data-probe="a"]')!.textContent).toBe('')
    expect(el.querySelector('[data-probe="b"]')!.textContent).toBe('')
  })
})

describe('where an agent waiting in the terminal says so', () => {
  test("the Report bar: the words and a still dot in Writing's place, no button; Writing again once answered", async () => {
    const onWrite = vi.fn()
    const el = await mount(<WriteAction name="report" written busy waiting onWrite={onWrite} />)
    expect(el.querySelector('button.btn-primary')).toBeNull()
    const wait = el.querySelector('.wu-wait')!
    expect(wait.getAttribute('role')).toBe('status')
    expect(wait.textContent).toBe(TERMINAL_WAIT)
    expect(wait.querySelector('.dot.tt-waiting')).not.toBeNull()
    unmountAll()
    const again = await mount(<WriteAction name="report" written busy waiting={false} onWrite={onWrite} />)
    expect(again.querySelector('.wu-wait')).toBeNull()
    expect(again.querySelector('button.btn-primary')!.textContent).toBe('Writing')
    // `waiting` means nothing while no writer runs
    unmountAll()
    const idle = await mount(<WriteAction name="report" written busy={false} waiting onWrite={onWrite} />)
    expect(idle.querySelector('button.btn-primary')!.textContent).toBe('Revise')
  })

  test("an agent's card in main: the line in place of the critique's wait, only while it runs", async () => {
    const orient = meta({ id: 'orient-1', role: 'orient', route: 'subagent', status: 'running', paused: 'critique' } as Partial<ChatMeta> & { id: string })
    expect(subagentNotes(orient, true, false, false, true)).toMatchObject({ terminal: true, paused: false })
    expect(subagentNotes(orient, true, false, false, false)).toMatchObject({ terminal: false, paused: true })
    expect(subagentNotes({ ...orient, paused: null } as ChatMeta, false, false, false, true)).toBeNull()
    const el = await mount(<SubagentNotes ws="ws-tw" meta={orient} running inTerminal />)
    const line = el.querySelector('.chat-sub-terminal')!
    expect(line.textContent).toBe(TERMINAL_WAIT)
    expect(line.getAttribute('role')).toBe('status')
    expect(el.querySelector('.chat-sub-notes')!.textContent).not.toContain('Waiting for the critique')
  })

  test("the thread tree: the row's waiting dot says it on hover and to a screen reader; another wait keeps its words", async () => {
    const list = chats([ask('h1', 'critic-1'), ask('h2', 'writer-1', false)])
    const terminal = terminalWaits(null, list)
    const items = pickItems(list, (m) => m.status === 'running', () => false, { waiting: new Set(['writer-1']), terminal })
    const orient = items.find((i) => i.id === 'orient-1')!
    expect([orient.waiting, orient.waitText]).toEqual([true, TERMINAL_WAIT])
    const writer = items.find((i) => i.id === 'writer-1')!
    expect([writer.waiting, writer.waitText]).toEqual([true, undefined])
    const el = await mount(<ThreadTree nodes={threadNodes(items)} current="main" onPick={() => undefined} collapsed={false} onCollapsedChange={() => undefined} />)
    const labels = [...el.querySelectorAll('.tt-waiting')].map((d) => d.getAttribute('aria-label'))
    expect(labels).toContain(TERMINAL_WAIT)
    expect(labels).toContain('Waiting for you')
  })

  test("a report check's run and a view build name the terminal in their words", () => {
    expect(checkRunLabel('Unverifiable', { chat: 'c1' }, true)).toBe('Unverifiable is waiting for your answer in the terminal: open its run')
    expect(checkRunLabel('Unverifiable', { chat: 'c1' }, false)).toBe('Unverifiable is running: open its run')
    expect(buildLabel('building', 'terminal')).toBe(TERMINAL_WAIT)
    expect(buildLabel('building', true)).toBe('Waiting for permission')
    expect(buildLabel('building', false)).toBe('Building')
    expect(buildLabel('queued', 'terminal')).toBe('Queued')
  })
})
