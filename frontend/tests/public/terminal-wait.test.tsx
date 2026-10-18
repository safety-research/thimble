// @vitest-environment jsdom
// While Claude Code asks one of thimble's agents a permission prompt in the terminal (Manual mode), main's meta holds the
// request marked `terminal`, naming the agent's chat (backend events._hold). Every place that shows that agent's state
// then says it waits for the analyst's answer there, in place of its working state, and goes back once the request
// leaves main's meta (src/chat/waiting.ts terminalWaits and useTerminalWaits).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { terminalWaits } from '../../src/chat/waiting.ts'
import type { ChatMeta, PermissionRequest } from '../../src/lib/types.ts'
import { unmountAll } from './mount.tsx'

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
})
