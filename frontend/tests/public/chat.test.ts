// The chat as the browser folds it from a session's records (src/chat/model.ts): streamed text coalesces, a subagent's
// records nest under the call that started it, and results attach to their calls. The tool names the chat reads must
// match the plugin's MCP server.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { callLineText, callTarget, foldRecords, leadText, madeBy, mainSkips, MCP_PREFIXES, type UserRow } from '../../src/chat/model.ts'
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
  test('a view thimble proposed for a run, as a chip in its chat, is among the views the run proposed', () => {
    const made = madeBy(foldRecords(records([
      { type: 'chip', ts: '2026-08-30T14:00:00Z', kind: 'view', text: 'Swarm', ref: 'view:swarm' },
      { type: 'tool_use', ts: '2026-08-30T14:00:01Z', id: 'v1', name: `${P}propose_view`, input: { name: 'Wiki Pages' } },
      { type: 'tool_result', ts: '2026-08-30T14:00:02Z', id: 'v1', summary: 'Proposed the view Wiki Pages (view:wiki-pages) over …' },
    ])))
    expect(made.views).toEqual(['Swarm', 'Wiki Pages'])
    expect(made.viewSlugs).toEqual({ Swarm: 'swarm', 'Wiki Pages': 'wiki-pages' })
  })

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

test('an extension\'s orientation instructions lead its follow-up as a line naming the extension', () => {
  const [row] = foldRecords(records([{ type: 'user', text: 'Read every record in `*.jsonl`.', by: 'extension', extension: 'swarm-orient', run: 1 }]))
  expect(leadText(row as UserRow)).toBe('swarm-orient added: its orientation instructions')
  expect(leadText({ kind: 'user', index: 0, text: ' Count them. ', by: 'browser' })).toBe('Count them.')
})

describe('tool names', () => {
  test("the chat recognizes the plugin's MCP server by the prefix Claude Code gives its tools", () => {
    const plugin = JSON.parse(readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')) as { name: string }
    const mcp = JSON.parse(readFileSync(path.join(ROOT, 'plugin/.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    for (const server of Object.keys(mcp.mcpServers)) expect(MCP_PREFIXES).toContain(`mcp__plugin_${plugin.name}_${server}__`)
  })
})

describe('a cited call', () => {
  test('is named by what it points at in plain words, never by its tool or its input as JSON', () => {
    const named = [
      callTarget('Read', { file_path: '/data/toy/agents/agent-01.jsonl' }, 3, 'toy'),
      callTarget('Grep', { pattern: 'escalat', path: '/data/toy/tickets' }, 4, 'toy'),
      callTarget('Bash', { command: 'grep -c refund tickets/*.jsonl', description: 'Count refund tickets' }, 5, 'toy'),
      callTarget('Bash', { command: 'wc -l notes.jsonl' }, 6, 'toy'),
      callTarget(`${P}add_card`, { question: 'Reviews per agent', code: 'print(1)' }, 7, 'toy'),
      callTarget(`${P}critique`, { context: 'The account the drafts present.' }, 8, 'toy'),
      callTarget('StructuredOutput', { summary: 'What the agent found.' }, 9, 'toy'),
      callTarget('mcp__other__lookup', { q: 'x' }, 10, 'toy'),
    ]
    expect(named).toEqual(['agents/agent-01.jsonl', 'search for “escalat” in tickets', 'Count refund tickets', 'wc -l notes.jsonl', 'Reviews per agent', 'the critic’s report', 'an agent’s report', 'step 10'])
    for (const n of named) expect(n).not.toMatch(/[{}]|StructuredOutput|critique|Bash|Grep|Read/)
  })
})

describe("main's look at the agent tray", () => {
  test('a list_agents call and its result are left out of main, and a call with no input never reads as {}', () => {
    const log = records([
      { type: 'user', ts: '2026-08-30T14:00:00Z', text: 'What is running?' },
      { type: 'tool_use', ts: '2026-08-30T14:00:01Z', id: 'l1', name: `${P}list_agents`, input: {} },
      { type: 'tool_result', ts: '2026-08-30T14:00:02Z', id: 'l1', summary: 'orientation: running' },
      { type: 'text', delta: 'The orientation is running.' },
    ])
    expect([...mainSkips(log, { spawned: new Set(), summaries: [], runs: [] })].sort()).toEqual([1, 2])
    expect(callLineText(`${P}some_new_tool`, {}, '')).toBe('some_new_tool')
  })
})
