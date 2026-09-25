// The chat as the browser folds it from a session's records (src/chat/model.ts): streamed text coalesces, a subagent's
// records nest under the call that started it, results attach to their calls, and each card a run of calls made is
// counted once. The tool names the chat reads must match the plugin's MCP server and the tools prompts/tools.md
// describes. Which sessions wait for the analyst comes from their chats' pending permission requests
// (src/chat/waiting.ts). The Start gate stays until an orientation is asked for, whatever main holds
// (src/chat/StartGate.tsx). A workflow agent's first message shows its task without the harness's preamble, a capacity
// error Claude Code wrote on every retry shows once (src/chat/tidy.ts), and a session's steps are named as the thread
// tree names them. Claude Code's API error in main is an error row with Retry, and is never taken for the summary of an
// orientation that ran into the same error. Two or more raw calls in a row fold into one chip naming each tool and its
// count (src/chat/Rows.tsx CallRun).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  API_ERROR_KIND,
  apiFailure,
  apiFailureText,
  apiRetry,
  capacityNote,
  callPieces,
  countTools,
  foldRecords,
  isApiError,
  mainSkips,
  orientSummaries,
  runTools,
  sessionSteps,
  stepEnded,
  stripHarness,
  agentFiles,
  agentChipName,
  groupTools,
  MCP_PREFIXES,
  madeBy,
  toolDisplayName,
  withApiErrors,
  toolGroupName,
  toolSummary,
  toolWord,
  wholeMessage,
  waitText,
} from '../../src/chat/model.ts'
import { countMessages } from '../../src/chat/seen.ts'
import { startGateOpen, startGateShown } from '../../src/chat/StartGate.tsx'
import { tidyRows, withoutHarness } from '../../src/chat/tidy.ts'
import { pendingAsks, waitingAt, waitingChats } from '../../src/chat/waiting.ts'
import { composerTarget } from '../../src/chat/threads.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'

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

  test('whole messages in a row stay separate messages; a streamed delta extends the text before it', () => {
    const rows = foldRecords(records([
      { type: 'text', delta: 'Most reviews came in the first hour.', reply: true, by: 'terminal' },
      { type: 'text', delta: 'A correction: the first two hours.', by: 'terminal' },
      { type: 'text', delta: 'Let me ' },
      { type: 'text', delta: 'look.' },
    ])) as any[]
    expect(rows.map((r) => [r.index, r.text])).toEqual([[0, 'Most reviews came in the first hour.'], [1, 'A correction: the first two hours.Let me look.']])
    expect(wholeMessage({ by: 'terminal' } as any)).toBe(true)
    expect(wholeMessage({ reply: true } as any)).toBe(true)
    expect(wholeMessage({} as any)).toBe(false)
  })

  test('a record whose parent call is unknown falls back to the top level', () => {
    expect((foldRecords(records([{ type: 'text', delta: 'orphan', parent_tool_use_id: 'nope' }])) as any[]).map((r) => r.kind)).toEqual(['text'])
  })

  test('a browser message and a terminal prompt are user rows that say where they were typed', () => {
    const rows = foldRecords(records([
      { type: 'user', ts: '2026-08-30T14:00:00Z', text: 'From the browser', by: 'browser', event: 'e1' },
      { type: 'user', ts: '2026-08-30T14:01:00Z', text: 'Typed in the terminal', by: 'terminal' },
    ])) as any[]
    expect(rows.map((r) => [r.kind, r.by])).toEqual([['user', 'browser'], ['user', 'terminal']])
  })

  test('counts: nested calls count as calls, and messages count as the list route counts them', () => {
    expect(countTools(foldRecords(LOG))).toBe(2)
    expect(countMessages(LOG)).toBe(4)
  })

  test('a card made and then edited in one run of calls is one card of that run', () => {
    const rows = foldRecords(records([
      { type: 'tool_use', id: 'a', name: `${P}add_card`, input: { kind: 'table', question: 'Which PRs waited longest?' } },
      { type: 'tool_result', id: 'a', summary: '$ add_card kind="table"', cell_id: '8fbcdc54' },
      { type: 'tool_use', id: 'b', name: `${P}add_card`, input: { kind: 'table', question: 'Who reviewed them?' } },
      { type: 'tool_result', id: 'b', summary: '$ add_card kind="table"', cell_id: 'fd93e1a6' },
      { type: 'tool_use', id: 'c', name: `${P}edit_card`, input: { card: 'card:8fbcdc54', code: 'df' } },
      { type: 'tool_result', id: 'c', summary: '$ edit_card card="card:8fbcdc54"', cell_id: '8fbcdc54' },
      { type: 'tool_use', id: 'd', name: `${P}edit_card`, input: { card: 'card:8fbcdc54', takeaway: 't' } },
      { type: 'tool_result', id: 'd', summary: 'card:8fbcdc54\nok' },
    ]))
    const groups = (groupTools(rows) as any[]).filter((r) => r.kind === 'tools')
    expect(groups).toHaveLength(1)
    expect(madeBy(groups[0].tools).cells.map((c: { id: string }) => c.id)).toEqual(['8fbcdc54', 'fd93e1a6'])
  })
})

/** The tools prompts/tools.md describes: each `## name` section that holds a JSON schema. */
function describedTools(): string[] {
  const text = readFileSync(path.join(ROOT, 'prompts/tools.md'), 'utf8')
  return text
    .split(/^## /m)
    .slice(1)
    .filter((s) => /^```json\s*$/m.test(s))
    .map((s) => s.split('\n', 1)[0].trim())
}

describe('tool names', () => {
  test("the chat recognizes the plugin's MCP server by the prefix Claude Code gives its tools", () => {
    const plugin = JSON.parse(readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')) as { name: string }
    const mcp = JSON.parse(readFileSync(path.join(ROOT, 'plugin/.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    for (const server of Object.keys(mcp.mcpServers)) expect(MCP_PREFIXES).toContain(`mcp__plugin_${plugin.name}_${server}__`)
  })

  test('every card, label, view, document and thread tool has a word and a group in the chat, under either prefix', () => {
    const tools = describedTools()
    expect(tools.length).toBeGreaterThan(10)
    // the calls that start or message a session thimble runs beside main show as that session's row and card
    const sessions = new Set(['start_orientation', 'start_writing', 'critique', 'message_orientation'])
    for (const name of tools.filter((t) => !sessions.has(t))) {
      for (const prefix of MCP_PREFIXES) {
        expect(toolDisplayName(prefix + name)).toBe(name)
        expect(toolWord(prefix + name), name).not.toBe(name)
        expect(toolGroupName(prefix + name), name).not.toBe(name)
      }
    }
  })

  test('the older card tool names read as the current ones', () => {
    expect(toolWord(`${P}add_cell`)).toBe(toolWord(`${P}add_card`))
    expect(toolWord(`${P}delete_cell`)).toBe('Delete card')
    expect(toolDisplayName(`${P}orient`)).toBe('start_orientation')
    expect(toolWord('mcp__thimble__retired_tool')).toBe('retired_tool')
  })

  test("a call's summary is what it was about, never its long arguments", () => {
    expect(toolSummary(`${P}add_card`, { question: 'Reviews per agent', code: 'x = 1\n' })).toBe('Reviews per agent')
    expect(toolSummary('Read', { file_path: '/data/toy/agents/agent-01.jsonl' })).toBe('agents/agent-01.jsonl')
    expect(toolSummary(`${P}read_ref`, { ref: 'card:ab12#count/total' })).toBe('card:ab12#count/total')
    expect(toolSummary(`${P}edit_card`, { card: 'card:ab12', takeaway: '[[41|card:ab12#reviews/agent-3]] of the reviews' })).toBe('41 of the reviews')
    expect(toolSummary(`${P}run_check`, { name: 'Depends on budget.xlsx', instructions: 'long text' })).toBe('Depends on budget.xlsx')
  })
})

const T = (s: number) => `2026-08-30T14:00:${String(s).padStart(2, '0')}Z`
const chat = (id: string, extra: Partial<ChatMeta> = {}) =>
  ({ id, kind: 'agent', role: 'step', title: id, created_at: T(0), parent: 'main', anchor: null, status: 'running', ...extra }) as ChatMeta
const ask = (id: string, since: string) => ({ id, tool: 'Glob', what: '/elsewhere', since })

describe('API errors, wherever they surface', () => {
  test("what failed and its status, from Claude Code's line or the server's words, as the backend's retry sorts them", () => {
    const cases: [string, string, number | null, string][] = [
      ['API Error: Repeated 529 Overloaded errors. The API is at capacity', 'overloaded', 529, "Anthropic's API is overloaded (529)"],
      ['API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', 'overloaded', 529, "Anthropic's API is overloaded (529)"],
      ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'server_error', 500, "Anthropic's API had a server error (500)"],
      ['API Error: Server error mid-response. The response above may be incomplete.', 'server_error', null, "Anthropic's API had a server error"],
      ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'rate_limited', 429, "Anthropic's API rate limit was reached (429)"],
      ['API Error: Rate limit reached', 'rate_limited', null, "Anthropic's API rate limit was reached"],
      ['API Error: Connection error.', 'connection', null, "The connection to Anthropic's API failed"],
      ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}', 'other', 400, "Anthropic's API returned an error (400)"],
      ["Anthropic's API was overloaded", 'overloaded', null, "Anthropic's API is overloaded"],
    ]
    for (const [text, failure, status, words] of cases) {
      expect(apiFailure(text), text).toEqual({ failure, status })
      expect(apiFailureText(text), text).toBe(words)
    }
  })

  test("a view build's line that it waits out an API error names the reason and the wait; any other line is none", () => {
    expect(capacityNote("Anthropic's API had a server error, so the build waits 60 s and goes on")).toEqual({ reason: "Anthropic's API had a server error", wait: 60 })
    expect(capacityNote("Anthropic's API rate limit was reached, so the build waits 120 s and goes on")).toEqual({ reason: "Anthropic's API rate limit was reached", wait: 120 })
    // a wait of a minute or more is written in whole minutes (backend dev._minutes), and read back in seconds
    expect(capacityNote("Anthropic's API was overloaded, so the build waits 4 min and goes on")).toEqual({ reason: "Anthropic's API was overloaded", wait: 240 })
    expect(waitText(45)).toBe('45 s')
    expect(waitText(240)).toBe('4 min')
    expect(capacityNote('the session writes the view')).toBeNull()
  })

  test("an API error line that ends a reply cut short is split from it: the reply's words, then the error's row", () => {
    const cut = 'Now the page: API Error: Server error mid-response. The response above may be incomplete.'
    const rows = withApiErrors(foldRecords(records([{ type: 'text', delta: cut, by: 'terminal' }])))
    expect(rows.map((r) => [r.kind, r.index, r.kind === 'text' ? r.text : r.kind === 'error' ? r.message : ''])).toEqual([
      ['text', 0, 'Now the page:'],
      ['error', 0.5, 'API Error: Server error mid-response. The response above may be incomplete.'],
    ])
    // a reply that only quotes the words keeps them
    for (const quoted of ['The agent logged "API Error: 500" and went on retrying for an hour.', 'The agent logged API Error: 500 and went on retrying.'])
      expect(withApiErrors(foldRecords(records([{ type: 'text', delta: quoted, by: 'terminal' }]))).map((r) => r.kind), quoted).toEqual(['text'])
    expect(apiRetry(records([{ type: 'user', text: 'Build it' }, { type: 'text', delta: cut, by: 'terminal' }]))).toEqual({ index: 1.5, text: 'Build it' })
  })

  test("the rows of every chat hold Claude Code's API error line as an error row, once however often it was written", () => {
    const line = 'API Error: Repeated 529 Overloaded errors.'
    const shown = withApiErrors(tidyRows(foldRecords(records([{ type: 'text', delta: line, by: 'terminal' }, { type: 'text', delta: line, by: 'terminal' }, { type: 'text', delta: 'Back.', by: 'terminal' }]))))
    expect(shown.map((r) => (r.kind === 'error' ? `${r.kind}:${r.errorKind}` : r.kind))).toEqual([`error:${API_ERROR_KIND}`, 'text'])
  })
})

describe("a thread's composer", () => {
  test('sends to the session of the thread it is in: its own, the latest orientation (from its steps too), the view a build builds, else main', () => {
    const m = (id: string, extra: object = {}) => ({ id, parent: 'main', ...extra })
    expect(composerTarget('main', m('main'), 'or2')).toEqual({ to: 'here' })
    expect(composerTarget('thread', m('t1'), 'or2')).toEqual({ to: 'here' })
    expect(composerTarget('orient', m('or2'), 'or2')).toEqual({ to: 'orient', chat: 'or2' })
    expect(composerTarget('step', m('s1', { parent: 'or2' }), 'or2')).toEqual({ to: 'orient', chat: 'or2' })
    expect(composerTarget('orient', m('or1'), 'or2'), 'an older orientation takes no message').toEqual({ to: 'main' })
    expect(composerTarget('step', m('s0', { parent: 'or1' }), 'or2')).toEqual({ to: 'main' })
    expect(composerTarget('dev', m('d1', { view: 'page-timeline' }), 'or2')).toEqual({ to: 'view', slug: 'page-timeline' })
    expect(composerTarget('dev', m('d2'), 'or2')).toEqual({ to: 'main' })
    expect(composerTarget('writer', m('w1'), null)).toEqual({ to: 'main' })
  })

})

describe('raw calls in a row', () => {
  const call = (id: string, name: string) => ({ kind: 'tool', index: 0, id, name, input: {}, children: [] }) as any
  test('two or more raw calls in a row fold into one run; one alone and any other call are lines of their own', () => {
    const tools = [call('a', 'Bash'), call('b', 'Read'), call('c', 'Grep'), call('d', `${P}add_card`), call('e', 'Read'), call('f', 'Glob'), call('g', 'Bash'), call('h', 'Skill'), call('i', 'Bash')]
    expect(callPieces(tools).map((p) => (p.kind === 'run' ? p.tools.map((t) => t.id).join('') : p.tool.id))).toEqual(['abc', 'd', 'efg', 'h', 'i'])
    expect(callPieces([call('a', 'Bash')]).map((p) => p.kind)).toEqual(['line'])
    expect(callPieces([])).toEqual([])
    // in the orientation's thread every call is a line, so calls of every tool fold together
    expect(callPieces(tools, true).map((p) => (p.kind === 'run' ? p.tools.map((t) => t.id).join('') : p.tool.id))).toEqual(['abcdefghi'])
  })

  test("a run's chip names each tool and how many calls it made, the most used first, ties in the order of first use", () => {
    expect(runTools([call('a', 'Bash'), call('b', 'Grep'), call('c', 'Bash')])).toEqual({ tools: [{ name: 'Bash', n: 2 }, { name: 'Grep', n: 1 }], more: 0 })
    expect(runTools([call('a', 'Read'), call('b', 'Grep'), call('c', 'Grep'), call('d', 'Read')]).tools.map((t) => t.name)).toEqual(['Read', 'Grep'])
    // thimble's own tools by their names, without the MCP prefix
    expect(runTools([call('a', `${P}add_card`), call('b', `${P}add_card`), call('c', 'Bash')]).tools).toEqual([{ name: 'add_card', n: 2 }, { name: 'Bash', n: 1 }])
  })

  test("past three tools the other tools' calls are counted together, and a fourth tool alone is named", () => {
    const many = [call('a', 'Bash'), call('b', 'Bash'), call('c', 'Read'), call('d', `${P}add_card`), call('e', `${P}edit_card`), call('f', `${P}propose_view`), call('g', `${P}propose_view`)]
    expect(runTools(many)).toEqual({ tools: [{ name: 'Bash', n: 2 }, { name: 'propose_view', n: 2 }, { name: 'Read', n: 1 }], more: 2 })
    const four = [call('a', 'Bash'), call('b', 'Read'), call('c', 'Grep'), call('d', 'Glob')]
    expect(runTools(four)).toEqual({ tools: ['Bash', 'Read', 'Grep', 'Glob'].map((name) => ({ name, n: 1 })), more: 0 })
  })
})

describe('who waits for the analyst', () => {
  test("a chat's permission requests count only while it runs", () => {
    expect(pendingAsks(chat('a', { permissions: [ask('p1', T(1))] }))).toHaveLength(1)
    expect(pendingAsks(chat('a', { status: 'done', permissions: [ask('p1', T(1))] } as Partial<ChatMeta>))).toEqual([])
    expect(pendingAsks(null)).toEqual([])
  })

  test('the chat that asked first comes first', () => {
    const metas = [chat('late', { permissions: [ask('p2', T(9))] }), chat('idle'), chat('early', { permissions: [ask('p1', T(3))] })]
    expect(waitingChats(metas).map((m) => m.id)).toEqual(['early', 'late'])
  })

  test("a session stands for a prompt of a chat under it, and its own prompt comes before a child's", () => {
    const orient = chat('or1', { role: 'orient' } as Partial<ChatMeta>)
    const critique = chat('cr1', { parent: 'or1', permissions: [ask('p1', T(4))] })
    const grandchild = chat('gc1', { parent: 'cr1', permissions: [ask('p0', T(1))] })
    expect(waitingAt('or1', [orient, critique])?.id).toBe('cr1')
    expect(waitingAt('or1', [orient, critique, grandchild])?.id).toBe('gc1')
    const asking = chat('or1', { permissions: [ask('p9', T(8))] })
    expect(waitingAt('or1', [asking, critique])?.id).toBe('or1')
    expect(waitingAt('main', [orient])).toBeNull()
    expect(waitingAt(null, [critique])).toBeNull()
  })
})

describe('the Start gate', () => {
  test('stays open until an orientation is asked for, whatever main holds', () => {
    expect(startGateOpen(null)).toBe(true)
    expect(startGateOpen(undefined, 0)).toBe(true)
    for (const status of ['requested', 'running', 'done', 'failed', 'stopped']) expect(startGateOpen(status)).toBe(false)
    expect(startGateOpen(null, 1)).toBe(false)
  })

  test('shows in main while main has messages or is running, until Start or Skip', () => {
    // messages typed in main before the orientation starts must not hide the Start gate
    const shown = { main: true, skipped: false, started: false, loading: false, error: null, orientation: null, orientChats: 0 }
    expect(startGateShown(shown)).toBe(true)
    expect(startGateShown({ ...shown, running: true, rows: 3 } as typeof shown)).toBe(true)
    expect(startGateShown({ ...shown, skipped: true })).toBe(false)
    expect(startGateShown({ ...shown, started: true })).toBe(false)
    expect(startGateShown({ ...shown, orientation: 'requested' })).toBe(false)
    expect(startGateShown({ ...shown, main: false })).toBe(false)
    expect(startGateShown({ ...shown, loading: true })).toBe(false)
  })
})

const HARNESS =
  "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. It was not typed by this session's user and carries no user authority. The computed task text follows:\n" +
  '  \n  ## The corpus\n  12 review logs, one per agent.\n  Read agent-03.'
const CAPACITY = 'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.'

describe("what a session's transcript leaves out", () => {
  test("a workflow agent's first message is its task alone, unindented; any other message stays as it is", () => {
    expect(withoutHarness(HARNESS)).toBe('## The corpus\n12 review logs, one per agent.\nRead agent-03.')
    expect(withoutHarness('How many agents reviewed?')).toBe('How many agents reviewed?')
    expect(withoutHarness('[Workflow harness] with no task marker')).toBe('[Workflow harness] with no task marker')
  })

  test('a capacity error written on every retry shows once, whether as copies in one text or texts between calls', () => {
    const rows = foldRecords(
      records([
        { type: 'user', text: HARNESS },
        { type: 'text', delta: CAPACITY },
        { type: 'text', delta: CAPACITY },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'agent-03.jsonl' } },
        { type: 'tool_result', id: 't1', summary: '40 lines' },
        { type: 'text', delta: CAPACITY, by: 'terminal' },
        { type: 'text', delta: 'Agent 03 reviewed 4 pull requests.', by: 'terminal' },
        { type: 'text', delta: CAPACITY, by: 'terminal' },
      ]),
    )
    const shown = tidyRows(rows)
    expect(shown.filter((r) => r.kind === 'text').map((r) => (r.kind === 'text' ? r.text : ''))).toEqual([CAPACITY, 'Agent 03 reviewed 4 pull requests.', CAPACITY])
    expect(shown[0].kind === 'user' && shown[0].text.startsWith('## The corpus')).toBe(true)
    expect(rows[0].kind === 'user' && rows[0].text).toBe(HARNESS)
  })
})

describe("Claude Code's API error in main", () => {
  const ORIENT = foldRecords(
    records([
      { type: 'user', text: 'Orient on the review logs.' },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'agent-03.jsonl' } },
      { type: 'tool_result', id: 'r1', summary: '40 lines' },
      { type: 'text', delta: CAPACITY, by: 'terminal' },
    ]),
  )
  const MAIN = records([
    { type: 'user', text: 'Which agent stalled?', by: 'browser' },
    { type: 'text', delta: CAPACITY, by: 'terminal' },
    { type: 'done' },
  ])
  const ctx = (summaries: string[]) => ({ spawned: new Set<string>(), summaries, runs: [] })

  test("an orientation's last text is a summary only once it has ended, and an API error never is", () => {
    const done = foldRecords(records([{ type: 'user', text: 'Orient.' }, { type: 'text', delta: 'Agent 03 stalled on review 4.', by: 'terminal' }]))
    expect(orientSummaries(done)).toEqual([])
    expect(orientSummaries(done, true)).toEqual(['Agent 03 stalled on review 4.'])
    expect(orientSummaries(ORIENT, true)).toEqual([])
    const back = foldRecords(records([{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: 'Agent 03 stalled.' } }]))
    expect(orientSummaries(back)).toEqual(['Agent 03 stalled.'])
  })

  test("main's error stays in main when the orientation wrote the same line, and shows as an error row", () => {
    const summaries = orientSummaries(ORIENT, true)
    expect(mainSkips(MAIN, ctx(summaries)).size).toBe(0)
    // even a summary list that held the line leaves main's error in
    expect(mainSkips(MAIN, ctx([CAPACITY])).size).toBe(0)
    const rows = withApiErrors(foldRecords(MAIN, mainSkips(MAIN, ctx(summaries))))
    expect(rows.map((r) => r.kind)).toEqual(['user', 'error'])
    expect(rows[1]).toEqual({ kind: 'error', index: 1, message: CAPACITY, errorKind: API_ERROR_KIND })
    expect(isApiError(`  ${CAPACITY}`)).toBe(true)
    expect(isApiError('The API Error: line is quoted here.')).toBe(false)
  })

  test("Retry resends the message that opened the failed turn, while the error is the last thing in main", () => {
    expect(apiRetry(MAIN)).toEqual({ index: 1, text: 'Which agent stalled?' })
    // the analyst moved on, or main replied after all
    expect(apiRetry(records([...MAIN, { type: 'user', text: 'Never mind.' }]))).toBeNull()
    expect(apiRetry(records([...MAIN, { type: 'text', delta: 'Agent 03 stalled.', by: 'terminal' }]))).toBeNull()
    // a turn the analyst did not open (a thread's event) resends nothing older
    expect(apiRetry(records([{ type: 'user', text: 'Earlier question' }, { type: 'done' }, { type: 'text', delta: CAPACITY, by: 'terminal' }]))).toBeNull()
    // a record main leaves out after the error does not hide it
    const withChip = records([...MAIN, { type: 'chip', kind: 'session', text: 'terminal attached' }])
    expect(apiRetry(withChip, new Set([3]))).toEqual({ index: 1, text: 'Which agent stalled?' })
    expect(apiRetry(records([{ type: 'user', text: 'Hi' }, { type: 'text', delta: 'Hello.', by: 'terminal' }]))).toBeNull()
  })
})

describe("a session's steps", () => {
  test('named by their key alone while they share a phase, with the phase once they span two', () => {
    const agent = (chat: string, title: string) => ({ type: 'agent', chat, role: 'step', title })
    const readers = foldRecords(records([agent('s1', 'Read: read:early-relay'), agent('s2', 'Read: read:coord-jun16')]))
    const metas = new Map([['s1', { status: 'done' }], ['s2', { status: 'running' }], ['s3', { status: 'failed' }]])
    expect(sessionSteps(readers, metas, true).map((s) => s.text)).toEqual(['early-relay', 'coord-jun16'])
    const mixed = foldRecords(records([agent('s1', 'Read: read:links'), agent('s3', 'Verify: verify:H1')]))
    expect(sessionSteps(mixed, metas, true).map((s) => s.text)).toEqual(['read: links', 'verify: H1'])
    expect(sessionSteps(foldRecords(records([agent('s2', 'Verify report:report')])), metas, true).map((s) => s.text)).toEqual(['Verify report:report'])
    const calls = foldRecords(records([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_result', id: 'a', summary: 'ok' }]))
    expect(sessionSteps(calls, metas, true)).toEqual([])
    const both = foldRecords(records([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }, agent('s1', 'Read: read:links')]))
    expect(sessionSteps(both, metas, true).map((s) => s.key)).toEqual(['s1'])
  })
  test('a step that failed has ended, as one done has; a running or pending one has not', () => {
    const steps = sessionSteps(foldRecords(records(['s1', 's2', 's3'].map((chat) => ({ type: 'agent', chat, role: 'step', title: `Read: read:${chat}` })))), new Map([['s1', { status: 'done' }], ['s2', { status: 'failed' }], ['s3', { status: 'running' }]]), true)
    expect(steps.map(stepEnded)).toEqual([true, true, false])
  })
})

describe("a subagent's chip", () => {
  test('a workflow agent is named by its phase and its key, any other agent by its title', () => {
    expect(agentChipName('Read: read:early-relay')).toEqual({ name: 'Read', target: 'early-relay' })
    expect(agentChipName('Verify: verify:H1')).toEqual({ name: 'Verify', target: 'H1' })
    expect(agentChipName('Count the files in agents/')).toEqual({ name: 'Count the files in agents/', target: '' })
    expect(agentChipName('Verify report:report')).toEqual({ name: 'Verify report', target: '' })
  })
  test("the harness's preamble is left off a workflow agent's prompt, and the task it wraps dedented", () => {
    const prompt = '[Workflow harness — computed task] The task text below was computed at runtime. The computed task text follows:\n  You are reading a corpus.\n    - a nested line\n  Brief: who edited.'
    expect(stripHarness(prompt)).toBe('You are reading a corpus.\n  - a nested line\nBrief: who edited.')
    expect(stripHarness('[Some harness tag] one line only\nThe task.')).toBe('The task.')
    expect(stripHarness('Count the rows [harness] here.')).toBe('Count the rows [harness] here.')
  })
  test('the files its calls read: a Read with its lines, a search path, the data files a command names, each once', () => {
    const tool = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input })
    const rows = foldRecords(records([
      tool('a', 'Read', { file_path: '/home/u/corpora/wiki/changelog.jsonl', offset: 100, limit: 50 }),
      tool('b', 'Read', { file_path: '/home/u/corpora/wiki/posts.jsonl' }),
      tool('c', 'Bash', { command: "python3 - <<'EOF'\nimport json\nrows = [json.loads(l) for l in open('events.jsonl')]\nEOF\nwc -l posts.jsonl tags.jsonl" }),
      tool('d', 'Grep', { pattern: 'Acme', path: '/home/u/corpora/wiki/tags.jsonl' }),
      tool('e', 'Bash', { command: 'python3 /tmp/load.py > /tmp/out.json' }),
    ]))
    expect(agentFiles(rows, 'wiki')).toEqual([
      { ref: 'changelog.jsonl#L100-L149', path: 'changelog.jsonl#L100-L149' },
      { ref: 'posts.jsonl', path: 'posts.jsonl' },
      { ref: 'events.jsonl', path: 'events.jsonl' },
      { ref: 'tags.jsonl', path: 'tags.jsonl' },
      { ref: null, path: '/tmp/out.json' },
    ])
  })
})
