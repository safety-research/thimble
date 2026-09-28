// The chat as the browser folds it from a session's records (src/chat/model.ts): streamed text coalesces, a subagent's
// records nest under the call that started it, and results attach to their calls. The tool names the chat reads must
// match the plugin's MCP server.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { foldRecords, MCP_PREFIXES } from '../../src/chat/model.ts'
import type { ChatRecord } from '../../src/lib/types.ts'

const ROOT = path.resolve(__dirname, '../../..')
const records = (list: object[]) => list as unknown as ChatRecord[]
const P = 'mcp__plugin_thimble_thimble__'

const LOG = records([
  { type: 'user', ts: '2026-08-30T14:00:00Z', text: 'How many agents reviewed?' },
  { type: 'text', delta: 'Let me ' },
  { type: 'text', delta: 'look.' },
  { type: 'tool_use', ts: '2026-08-30T14:00:01Z', id: 't1', name: `${P}add_card`, input: { kind: 'table', question: 'Reviews per agent', code: 'print(1)' } },
  { type: 'tool_use', ts: '2026-08-30T14:00:02Z', id: 's1', name: 'Read', input: { file_path: '/data/toy/agents/agent-01.jsonl' }, parent_tool_use_id: 't1' },
  { type: 'text', delta: 'inside the subagent', parent_tool_use_id: 't1' },
  { type: 'tool_result', ts: '2026-08-30T14:00:03Z', id: 's1', summary: 'ok', parent_tool_use_id: 't1' },
  { type: 'tool_result', ts: '2026-08-30T14:00:04Z', id: 't1', summary: 'card:abcd1234\n3 rows', cell_id: 'abcd1234' },
  { type: 'text', delta: 'There are [[3|card:abcd1234#agents/total]] agents.' },
  { type: 'done', ts: '2026-08-30T14:00:06Z', session_id: 'sess', cells: ['abcd1234'] },
  { type: 'chip', ts: '2026-08-30T14:01:00Z', kind: 'artifact', text: 'the cards', ref: 'group:g1' },
  { type: 'agent', ts: '2026-08-30T14:01:01Z', chat: 'ag1', role: 'orient', title: 'orientation' },
  { type: 'error', ts: '2026-08-30T14:02:00Z', message: 'stopped', kind: 'interrupted', detail: 'the analyst stopped it' },
])

describe('the fold', () => {
  test('text coalesces, a subagent nests under its call, results attach, chips and agents are rows', () => {
    const rows = foldRecords(LOG) as any[]
    expect(rows.map((r) => r.kind)).toEqual(['user', 'text', 'tool', 'text', 'chip', 'agent', 'error'])
    expect(rows[0].text).toBe('How many agents reviewed?')
    expect(rows[1].text).toBe('Let me look.')
    const tool = rows[2]
    expect(tool.id).toBe('t1')
    expect(tool.result.cell_id).toBe('abcd1234')
    expect(tool.children.map((r: any) => r.kind)).toEqual(['tool', 'text'])
    expect(tool.children[0].result.summary).toBe('ok')
    expect(rows[3].index).toBe(8)
    expect(rows[4].ref).toBe('group:g1')
    expect(rows[5].chat).toBe('ag1')
    expect(rows[6].errorKind).toBe('interrupted')
  })
})

describe('tool names', () => {
  test("the chat recognizes the plugin's MCP server by the prefix Claude Code gives its tools", () => {
    const plugin = JSON.parse(readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')) as { name: string }
    const mcp = JSON.parse(readFileSync(path.join(ROOT, 'plugin/.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    for (const server of Object.keys(mcp.mcpServers)) expect(MCP_PREFIXES).toContain(`mcp__plugin_${plugin.name}_${server}__`)
  })
})
