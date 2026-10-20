// The chat as the browser folds it from a session's records (src/chat/model.ts): streamed text coalesces, a subagent's
// records nest under the call that started it, and results attach to their calls. The tool names the chat reads must
// match the plugin's MCP server.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { callLineText, callTarget, foldRecords, madeBy, MCP_PREFIXES, type CallsRow, type ToolGroup } from '../../src/chat/model.ts'
import { shownRows } from '../../src/chat/Rows.tsx'
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

describe('tool names', () => {
  test("thimble browser's tools reach the chat by their own names, which carry no MCP prefix to strip", () => {
    const names = [...readdirSync(path.join(ROOT, 'prompts')).filter((f) => f.startsWith('tools')).map((f) => readFileSync(path.join(ROOT, 'prompts', f), 'utf8')).join('\n').matchAll(/^## (\S+)$/gm)].map((m) => m[1])
    expect(names).toContain('add_card')
    for (const n of names) expect(MCP_PREFIXES.some((p) => n.startsWith(p))).toBe(false)
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

describe('a call of a tool thimble does not know', () => {
  test("is one compact line, named by its words and never by its input as JSON; thimble's own calls stay cards", () => {
    // live QA 2: main's SendFeedback call was a card of its own that read `SendFeedback {"type":"bug",…`
    const rows = foldRecords(records([
      { type: 'tool_use', ts: '2026-10-10T11:09:33Z', id: 'b1', name: 'Bash', input: { command: 'wc -l revisions.jsonl' } },
      { type: 'tool_use', ts: '2026-10-10T11:09:34Z', id: 'u1', name: 'TodoWrite', input: { todos: [{ content: 'Look', status: 'done' }] } },
      { type: 'tool_use', ts: '2026-10-10T11:09:35Z', id: 'u2', name: 'mcp__claude-in-chrome__navigate', input: { tabId: 3, url: 'https://example.org/' } },
      { type: 'tool_use', ts: '2026-10-10T11:09:36Z', id: 't1', name: `${P}open_view`, input: { view: 'wiki-pages' } },
    ]))
    const shown = shownRows(rows)
    expect(shown.map((r) => r.kind)).toEqual(['calls', 'tools'])
    const [calls, card] = [shown[0] as CallsRow, shown[1] as ToolGroup]
    expect(calls.tools.map((t) => callLineText(t.name, t.input, ''))).toEqual(['Bash wc -l revisions.jsonl', 'TodoWrite', 'navigate https://example.org/'])
    expect(callLineText(card.tools[0].name, card.tools[0].input, '')).toBe('open_view wiki-pages')
    const feedback = { type: 'bug', title: 'The hook says to end the turn silently', details: '- **What happened:** …' }
    expect(callLineText('SendFeedback', feedback, '')).toBe('SendFeedback The hook says to end the turn silently')
    expect(callLineText('CronCreate', { cron: '*/5 * * * *', recurring: true }, '')).toBe('CronCreate */5 * * * *')
  })
})

describe("a writer's saves of its document in main", () => {
  test('consecutive saves of one document by one run are one row, the latest; other documents, runs and rows between stay apart', () => {
    // live check: a writer's first save and its eleven edit_document calls were "wrote Report" and eleven "revised Report"
    const save = (ts: string, text: string, ref: string, extra: Record<string, unknown> = {}) => ({ type: 'chip', ts, kind: 'artifact', text, ref, status: 'done', ...extra })
    const rows = foldRecords(records([
      { type: 'agent', ts: '2026-10-15T05:08:44Z', chat: 'w1', role: 'writer', title: 'Write report' },
      save('2026-10-15T05:15:59Z', 'wrote', 'report:report', { status: 'generated', generation: 1, writer: 'w1' }),
      save('2026-10-15T05:16:52Z', 'revised', 'report:report#95cf0dd8', { what: 'edited a passage', writer: 'w1' }),
      save('2026-10-15T05:16:53Z', 'revised', 'report:report#2b9f13b0', { what: 'edited a passage', writer: 'w1' }),
      save('2026-10-15T05:17:41Z', 'revised', 'report:report#b1cd2b76', { what: 'edited a passage', writer: 'w1' }),
      save('2026-10-15T05:18:00Z', 'wrote', 'report:slides', { generation: 1, writer: 'w1' }),
      save('2026-10-15T05:18:10Z', 'revised', 'report:report#5b25217d', { writer: 'w1' }),
      { type: 'user', ts: '2026-10-15T05:19:00Z', text: 'Shorten the second paragraph.', by: 'browser' },
      save('2026-10-15T05:19:30Z', 'revised', 'report:report#6c6895ac', { writer: 'w1' }),
      save('2026-10-15T05:19:40Z', 'revised', 'report:report#9cf20f9b', { writer: 'w2' }),
      save('2026-10-15T05:19:50Z', 'revised', 'report:report#e1312a3e'),
      save('2026-10-15T05:19:55Z', 'revised', 'report:report#5ed451d9'),
    ]))
    const shown = shownRows(rows) as any[]
    expect(shown.map((r) => (r.kind === 'chip' ? `${r.text} ${r.ref}` : r.kind))).toEqual([
      'agent',
      'revised report:report#b1cd2b76',
      'wrote report:slides',
      'revised report:report#5b25217d',
      'user',
      'revised report:report#6c6895ac',
      'revised report:report#9cf20f9b',
      'revised report:report#e1312a3e',
      'revised report:report#5ed451d9',
    ])
  })
})

