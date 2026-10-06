// The fold of a chat log into rows the panel renders. `index` is the record's position in the log.
import type { StepState, ToolState, ToolStep } from '../components/ToolCard'
import { parseRef, refLabel } from '../lib/refs'
import type { ChatRecord } from '../lib/types'
import { shortStepNames, stepParts } from './threads'

export interface UserRow {
  kind: 'user'
  index: number
  text: string
  ts?: string
  /** where the analyst typed it: the session's terminal or the browser; `main` for a message main sent the orientation */
  by?: string
  /** `orient-follow-up` on a message an earlier build passed to the orientation through main, kept in older logs; a
   * follow-up's message now says so by its `run` */
  event?: string
  /** the orientation's run that message started: 1 for its first follow-up */
  run?: number
  /** with `by` extension: the extension whose orientation instructions the message is */
  extension?: string
}
export interface TextRow {
  kind: 'text'
  index: number
  text: string
}
export interface ToolResult {
  summary: string
  /** when the result came back */
  ts?: string
  is_error?: boolean
  /** the call did not run and is made again: auto mode refused it and the analyst allowed it, auto mode could not
   * judge it and thimble sent it back, or a mode switch answered it (backend session.not_run) */
  not_run?: boolean
  cell_id?: string
  /** the card an apply_label call left, which its result names (backend session.LABEL_TOOL) */
  label_card?: string
  notebook?: string
}
export interface ToolRow {
  kind: 'tool'
  index: number
  id: string
  name: string
  input: unknown
  /** the call's number in its orientation's one sequence, which its `call:` ref names (backend calls.py) */
  n?: number
  ts?: string
  result?: ToolResult
  /** a subagent's records, nested under the tool call that spawned it */
  children: Row[]
}
export interface ChipRow {
  kind: 'chip'
  index: number
  chip: string
  text: string
  ref?: string
  ts?: string
  /** the act's state when it was appended: `generating`, `proposed`, `building`, `done`, … */
  status?: string
  /** the chat the act belongs to: a fork's act with no reply, a dev ticket's thread, the orientation that ended */
  chat?: string
  /** a document save's generation (report_types.write_document) */
  generation?: number
  /** the writer's chat a document save came from (report_types._writer_chat) */
  writer?: string
  /** a follow-up that was not passed on (orient_session.not_passed_on): the message, which Send again sends */
  message?: string
}
export interface AgentRow {
  kind: 'agent'
  index: number
  chat: string
  role: string
  title: string
  ts?: string
  /** an orientation's follow-up, in main: the run of its session a message started (1 for the first) */
  run?: number
}
export interface ErrorRow {
  kind: 'error'
  index: number
  message: string
  errorKind?: string
  detail?: string
  /** an API error a view build waits out: the seconds it waits before it goes on (capacityNote) */
  wait?: number
}
/** a line the server wrote about a run's progress (a dev ticket's stages: worktree ready, gates, applied) */
export interface NoteRow {
  kind: 'note'
  index: number
  text: string
}
/** a screenshot a dev ticket's run took of its target, before or after the change */
export interface ShotRow {
  kind: 'shot'
  index: number
  phase: string
  ticket: string
  name: string
  note?: string
}
export type Row = UserRow | TextRow | ToolRow | ChipRow | AgentRow | ErrorRow | NoteRow | ShotRow

/** Find the tool row with `id` anywhere in `rows`, nested rows included. */
function findTool(rows: Row[], id: string): ToolRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.kind !== 'tool') continue
    if (r.id === id) return r
    const inner = findTool(r.children, id)
    if (inner) return inner
  }
  return undefined
}

/** A chip's text as the row shows it, without a `proposed a view: ` prefix, which the icon replaces. */
export function chipText(kind: string, text: string): string {
  return kind === 'view' ? text.replace(/^proposed a view: /, '') : text
}

/**
 * Whether a text record is a whole message. The mirror of the analyst's session and reply_in_thread write whole
 * messages (they carry `by` or `reply`), so each starts a row of its own and two in a row read as two messages, not as
 * two paragraphs of one; a record with neither is a streamed delta and extends the row before it. Pure.
 */
export function wholeMessage(rec: { by?: string; reply?: boolean }): boolean {
  return !!(rec.by || rec.reply)
}

/** The stage line of a session that has shown no activity for a while (backend dev.QUIET_LINE, agent_session.QUIET_LINE). */
export const QUIET_RE = /^no activity for \d+ (min|s)$/

/** A stage line a server-run task writes between the session's messages (dev.py's `Log.stage`: a line of its own that
 * starts with `· `): its text, else null. Pure. */
export function stageLine(delta: string): string | null {
  const m = /^\n· ([^\n]+)\n$/.exec(delta)
  return m ? m[1].trim() : null
}

/**
 * Fold the records of a log into rows: a whole message is a text row of its own, a text delta extends the last text row
 * of its level, a stage line is a note. A record `skip` names is left out; every row keeps its record's index. An
 * `agent` record that names the tool call which started its chat (`tool_use_id`) follows that call's row, since the
 * mirror copies the call only once Claude Code flushes its transcript, so the record can come first in the log. Pure.
 */
export function foldRecords(records: readonly ChatRecord[], skip?: ReadonlySet<number>): Row[] {
  const rows: Row[] = []
  const calls = new Map<string, number>() // a top-level tool call's id -> its record's index, for the calls folded
  records.forEach((e, index) => {
    if (e.type === 'tool_use' && !skip?.has(index) && typeof e.parent_tool_use_id !== 'string') calls.set(e.id, index)
  })
  const held = new Map<string, AgentRow[]>() // the agent rows that wait for their call's row
  records.forEach((e, index) => {
    if (skip?.has(index)) return
    const parent = 'parent_tool_use_id' in e && typeof e.parent_tool_use_id === 'string' ? findTool(rows, e.parent_tool_use_id) : undefined
    const into = parent ? parent.children : rows
    switch (e.type) {
      case 'user':
        rows.push({ kind: 'user', index, text: e.text, ts: e.ts, by: e.by, event: e.event, run: e.run, extension: e.extension })
        return
      case 'text': {
        // a Claude Code notification the model copied into its reply is harness text, not words for the analyst
        const delta = withoutNotifications(e.delta)
        if (delta !== e.delta && !delta.trim()) return
        e = { ...e, delta }
        const stage = parent ? null : stageLine(e.delta)
        if (stage) {
          rows.push({ kind: 'note', index, text: stage })
          return
        }
        const last = into[into.length - 1]
        if (last && last.kind === 'text' && !wholeMessage(e)) last.text += e.delta
        else into.push({ kind: 'text', index, text: e.delta })
        return
      }
      case 'tool_use':
        into.push({ kind: 'tool', index, id: e.id, name: e.name, input: e.input, ts: e.ts, children: [], ...(typeof e.n === 'number' ? { n: e.n } : {}) })
        if (into === rows) rows.push(...(held.get(e.id) ?? []))
        held.delete(e.id)
        return
      case 'tool_result': {
        const tool = findTool(rows, e.id)
        if (tool) tool.result = { summary: e.summary, ts: e.ts, is_error: e.is_error, cell_id: e.cell_id, notebook: e.notebook, ...(e.not_run ? { not_run: true } : {}), ...(e.label_card ? { label_card: e.label_card } : {}) }
        return
      }
      case 'chip': {
        rows.push({ kind: 'chip', index, chip: String(e.kind), text: chipText(String(e.kind), e.text), ref: e.ref, ts: e.ts, status: typeof e.status === 'string' ? e.status : undefined, chat: typeof e.chat === 'string' ? e.chat : undefined, generation: typeof e.generation === 'number' ? e.generation : undefined, writer: typeof e.writer === 'string' ? e.writer : undefined, message: typeof e.message === 'string' ? e.message : undefined })
        return
      }
      case 'agent': {
        const row: AgentRow = { kind: 'agent', index, chat: e.chat, role: e.role, title: e.title, ts: e.ts, ...(typeof e.run === 'number' ? { run: e.run } : {}) }
        const call = e.tool_use_id ? calls.get(e.tool_use_id) : undefined
        if (e.tool_use_id && call !== undefined && call > index) held.set(e.tool_use_id, [...(held.get(e.tool_use_id) ?? []), row])
        else rows.push(row)
        return
      }
      case 'error':
        rows.push({ kind: 'error', index, message: e.message, errorKind: e.kind, detail: e.detail })
        return
      case 'shot':
        rows.push({ kind: 'shot', index, phase: e.phase, ticket: e.ticket, name: e.name, note: e.note })
        return
      default:
        return
    }
  })
  return rows
}

/** Every tool call in `rows`, nested ones included. */
export function countTools(rows: readonly Row[]): number {
  let n = 0
  for (const r of rows) if (r.kind === 'tool') n += 1 + countTools(r.children)
  return n
}

// ---- tools ----

export const MCP_PREFIXES: readonly string[] = ['mcp__plugin_thimble_thimble__', 'mcp__thimble__']

/** Alias names of the card tools and start_orientation (backend tools.TOOL_ALIASES), read as the current ones. */
const OLD_TOOL_NAMES: Record<string, string> = {
  add_cell: 'add_card',
  edit_cell: 'edit_card',
  delete_cell: 'delete_card',
  list_cells: 'list_cards',
  orient: 'start_orientation',
}

export function toolDisplayName(name: string): string {
  const prefix = MCP_PREFIXES.find((p) => name.startsWith(p))
  const bare = prefix ? name.slice(prefix.length) : name.replace(/^mcp__.+?__/, '')
  return OLD_TOOL_NAMES[bare] ?? bare
}

const str = (v: unknown): string => (v == null ? '' : String(v))
const oneLine = (s: string, max = 110): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}
const firstLine = (s: string, max = 110): string => oneLine(s.split('\n').find((l) => l.trim() !== '') ?? '', max)

/** A call's target with the corpus folder's absolute path left off, as Claude Code prints a path under its working
 * directory; the folder itself is `.`. Pure. */
export function underCorpus(text: string, ws: string): string {
  if (!ws) return text
  const name = ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // the folder itself first, so a path through a folder of the same name further up is not cut there
  return text.replace(new RegExp(`(?<!\\S)/\\S*/${name}(?=\\s|$)`, 'g'), '.').replace(new RegExp(`(?<!\\S)/\\S*/${name}/`, 'g'), '')
}

/** A call's chip line, as Claude Code prints a tool line: the tool and its target (`Read notes.jsonl`, `Bash grep -c
 * refund tickets/`). Pure. */
export function callLineText(name: string, input: unknown, ws: string): string {
  const target = underCorpus(toolSummary(name, input, ws), ws)
  return target ? `${toolDisplayName(name)} ${target}` : toolDisplayName(name)
}

/** The tools that read or write one file, and the input keys that name it. */
const FILE_TOOLS: Record<string, string[]> = {
  Read: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  MultiEdit: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path'],
}

/** The file a call read or wrote, relative to the corpus; '' for a call of another kind. Pure. */
export function callFile(name: string, input: unknown, ws = ''): string {
  const keys = FILE_TOOLS[toolDisplayName(name)]
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const key = keys?.find((k) => typeof inp[k] === 'string' && inp[k])
  return key ? underCorpus(corpusRelative(str(inp[key])), ws) : ''
}

/** What a cited call points at, in plain words, as a citation's chip names it: the file it read or wrote, the search it
 * ran, what its command did, the card it made, the task it handed on, the critic's report. Never a tool's name or its
 * input as JSON: a call none of these fit reads as its step number `n`. Pure. */
export function callTarget(name: string, input: unknown, n: number, ws = ''): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const file = callFile(name, input, ws)
  if (file) return file
  const step = `step ${n}`
  const where = inp.path ? ` in ${underCorpus(corpusRelative(str(inp.path)), ws)}` : ''
  switch (toolDisplayName(name)) {
    case 'Grep':
      return inp.pattern ? `search for “${oneLine(str(inp.pattern), 60)}”${where}` : step
    case 'Glob':
      return inp.pattern ? `files matching ${oneLine(str(inp.pattern), 60)}${where}` : step
    case 'Bash':
      return oneLine(str(inp.description)) || oneLine(underCorpus(str(inp.command), ws)) || step
    case 'add_card':
    case 'edit_card':
      return oneLine(str(inp.question ?? inp.title)) || 'a card'
    case 'Agent':
    case 'Task':
      return oneLine(str(inp.description)) || 'a subagent’s task'
    case 'Workflow':
      return workflowTitle(inp) || 'a workflow'
    case 'WebFetch':
      return str(inp.url) || step
    case 'WebSearch':
      return inp.query ? `web search for “${oneLine(str(inp.query), 60)}”` : step
    case 'read_ref': {
      const ref = str(inp.ref ?? inp.span)
      return ref && parseRef(ref) ? refLabel(ref) : step
    }
    case 'apply_label':
    case 'show_label':
      return inp.name ? `label “${oneLine(str(inp.name), 60)}”` : step
    case 'critique':
      return 'the critic’s report'
    case 'StructuredOutput':
      return 'an agent’s report'
    default:
      return step
  }
}

/** What a citation's hover adds under a cited call's name: the command behind a shell call, which the chip names by what
 * it did; undefined for a call of another kind. Pure. */
export function callDetail(name: string, input: unknown, ws = ''): string | undefined {
  if (toolDisplayName(name) !== 'Bash') return undefined
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return oneLine(underCorpus(str(inp.command), ws), 240) || undefined
}

/** The SDK's Read paths are absolute; show them relative to the corpus root. */
export function corpusRelative(p: string): string {
  if (!p.startsWith('/')) return p
  const m = /\/data\/[^/]+\/(.*)$/.exec(p)
  return m ? m[1] : p
}

/** A Workflow call's title: its script's meta description, else its name (`export const meta = {name, description}`,
 * the literal every workflow script opens with), else the saved workflow it names. Pure. */
export function workflowTitle(inp: Record<string, unknown>): string {
  const head = str(inp.script).split('}', 1)[0]
  const meta: Record<string, string> = {}
  for (const m of head.matchAll(/\b(name|description)\s*:\s*(['"`])([\s\S]*?)\2/g)) meta[m[1]] ??= m[3]
  return oneLine(meta.description ?? meta.name ?? str(inp.name))
}

/** One line for a tool call's input; a Bash command has paths under workspace `ws`'s folder made relative before the
 * line is cut to length. */
export function toolSummary(name: string, input: unknown, ws = ''): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (toolDisplayName(name)) {
    case 'Read':
      return corpusRelative(str(inp.file_path ?? inp.path))
    case 'Grep':
    case 'Glob':
      return [str(inp.pattern), inp.path ? `in ${corpusRelative(str(inp.path))}` : ''].filter(Boolean).join(' ')
    case 'add_card':
      return oneLine(str(inp.question ?? inp.title)) || firstLine(str(inp.code))
    case 'edit_card':
      return (
        oneLine(str(inp.question ?? inp.title)) ||
        firstLine(str(inp.code)) ||
        oneLine(str(inp.takeaway ?? '').replace(/\[\[([^\]|]*)\|[^\]]*\]\]/g, '$1')) ||
        str(inp.card ?? inp.cell ?? '')
      )
    case 'delete_card':
      return str(inp.card ?? inp.cell ?? '')
    case 'apply_label':
      return [str(inp.name), inp.scope ? `on ${str(inp.scope)}` : ''].filter(Boolean).join(' ')
    case 'show_label':
      return [str(inp.name), inp.on === false ? 'off' : 'on'].join(' ')
    case 'set_filter': {
      // what the filter keeps, in the words of the canvas's chips: `canvas · table · Orientation · "merge"`
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])
      const label = inp.label ? `${str(inp.label)}${inp.value ? ` = ${str(inp.value)}` : ''}` : ''
      const parts = [str(inp.scope), label, ...list(inp.kinds), ...list(inp.groups), ...list(inp.makers), inp.starred ? 'starred' : '', inp.locked ? 'locked' : '', inp.text ? `"${str(inp.text)}"` : '']
      return parts.filter(Boolean).join(' · ')
    }
    case 'clear_filter':
      return str(inp.scope)
    case 'set_layout':
      return [str(inp.layout), ...(Array.isArray(inp.surfaces) ? inp.surfaces.map(String) : [])].filter(Boolean).join(' · ')
    case 'run_check':
    case 'stop_check':
      return str(inp.name)
    case 'resolve_comment':
      return str(inp.comment)
    case 'propose_view':
      return str(inp.name)
    case 'write_document':
      return str(inp.doc)
    case 'edit_document':
    case 'read_ref':
    case 'add_comment':
      return str(inp.span ?? inp.ref)
    case 'reply_in_thread':
      return oneLine(str(inp.text))
    case 'message_thread':
      return [str(inp.thread), inp.message ? oneLine(str(inp.message)) : ''].filter(Boolean).join(': ')
    case 'wait_session':
      return str(inp.session)
    case 'rename_thread':
      return `${str(inp.thread)} → ${str(inp.name)}`
    case 'delete_thread':
      return str(inp.thread)
    case 'screenshot':
      return [str(inp.ref), inp.selector ? str(inp.selector) : ''].filter(Boolean).join(' ')
    case 'file_dev_ticket':
      return oneLine(str(inp.title))
    case 'Agent':
    case 'Task':
      // the call that started a subagent or a tray entry of thimble's agents (thimble:orient, thimble:writer): its
      // description, never its input as JSON
      return oneLine(str(inp.description)) || oneLine(str(inp.subagent_type))
    case 'Workflow':
      return workflowTitle(inp)
    case 'Skill':
      return str(inp.skill ?? inp.name)
    case 'list_cards':
      return str(inp.group)
    case 'Bash':
      // the command on one line, as far as the chip has room: a script's first line alone (`python3 -c "`) says nothing
      return oneLine(underCorpus(str(inp.command), ws)) || oneLine(str(inp.description))
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return corpusRelative(str(inp.file_path ?? inp.path))
    case 'WebFetch':
    case 'WebSearch':
      return str(inp.url ?? inp.query)
    default: {
      if (!Object.keys(inp).length) return ''
      try {
        return JSON.stringify(input).slice(0, 120)
      } catch {
        return ''
      }
    }
  }
}

/** The words the analyst reads for a tool; an unknown tool keeps its wire name. */
export const TOOL_WORDS: Record<string, string> = {
  Read: 'Read file',
  Grep: 'Search',
  Glob: 'Find files',
  Bash: 'Shell',
  Edit: 'Edit file',
  MultiEdit: 'Edit file',
  Write: 'Write file',
  Task: 'Subtask',
  Agent: 'Subagent',
  WebFetch: 'Fetch page',
  WebSearch: 'Web search',
  add_card: 'Add card',
  edit_card: 'Edit card',
  delete_card: 'Delete card',
  read_ref: 'Look up',
  list_cards: 'List cards',
  apply_label: 'Apply label',
  show_label: 'Show label',
  set_filter: 'Filter',
  clear_filter: 'Clear filter',
  set_layout: 'Lay out panes',
  run_check: 'Run check',
  stop_check: 'Turn check off',
  propose_view: 'Propose view',
  write_document: 'Write document',
  edit_document: 'Edit passage',
  add_comment: 'Comment',
  resolve_comment: 'Resolve comment',
  reply_in_thread: 'Reply',
  message_thread: 'Message thread',
  wait_session: 'Wait for session',
  list_agents: 'List agents',
  rename_thread: 'Rename thread',
  delete_thread: 'Delete thread',
  screenshot: 'Screenshot',
  file_dev_ticket: 'File ticket',
}
export function toolWord(name: string): string {
  const n = toolDisplayName(name)
  return TOOL_WORDS[n] ?? n
}

// ---- tool-call cards: a run of calls of one kind is one card ----

/** The name a card of calls carries: what the calls did, as a kind of work (Cards, Label, Views, Read, …). */
export const TOOL_GROUPS: Record<string, string> = {
  add_card: 'Cards',
  edit_card: 'Cards',
  delete_card: 'Cards',
  list_cards: 'Cards',
  apply_label: 'Label',
  show_label: 'Label',
  set_filter: 'Filter',
  clear_filter: 'Filter',
  set_layout: 'Layout',
  run_check: 'Checks',
  stop_check: 'Checks',
  propose_view: 'Views proposed',
  write_document: 'Report',
  edit_document: 'Report',
  add_comment: 'Report',
  resolve_comment: 'Report',
  read_ref: 'Look up',
  Read: 'Read',
  Grep: 'Read',
  Glob: 'Read',
  Bash: 'Shell',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  Write: 'Edit',
  Task: 'Subtask',
  WebFetch: 'Web',
  WebSearch: 'Web',
  file_dev_ticket: 'Dev ticket',
  screenshot: 'Screenshot',
  reply_in_thread: 'Reply',
  message_thread: 'Threads',
  wait_session: 'Sessions',
  list_agents: 'Sessions',
  rename_thread: 'Threads',
  delete_thread: 'Threads',
}

export function toolGroupName(name: string): string {
  const n = toolDisplayName(name)
  return TOOL_GROUPS[n] ?? toolWord(name)
}

export interface ToolGroup {
  kind: 'tools'
  /** the log index of the group's first call */
  index: number
  name: string
  tools: ToolRow[]
}

/** The rows with every run of consecutive tool calls of one kind folded into one group, which renders as one tool-call
 * card. Pure. */
export function groupTools(rows: readonly Row[]): (Exclude<Row, ToolRow> | ToolGroup)[] {
  const out: (Exclude<Row, ToolRow> | ToolGroup)[] = []
  for (const r of rows) {
    if (r.kind !== 'tool') {
      out.push(r)
      continue
    }
    const name = toolGroupName(r.name)
    const last = out[out.length - 1]
    if (last && last.kind === 'tools' && last.name === name) last.tools.push(r)
    else out.push({ kind: 'tools', index: r.index, name, tools: [r] })
  }
  return out
}

/** The tools whose calls a chat prints as one line each, as Claude Code prints a tool line: reading a file, searching
 * the files, running a shell command. Only a subagent or a workflow agent is a step of its own; these are not. */
export const RAW_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'Bash'])

/** Whether a call is a raw call (RAW_TOOLS), by its wire name. Pure. */
export function isRawCall(name: string): boolean {
  return RAW_TOOLS.has(toolDisplayName(name))
}

/** A piece of a run of calls as the transcript shows it: two or more calls in a row fold into one chip (`run`); a call
 * alone is a line of its own. Only raw calls fold, except in the orientation's thread, where every call does (`all`). */
export type CallPiece = { kind: 'run'; tools: ToolRow[] } | { kind: 'line'; tool: ToolRow }

/** The pieces of a run of calls (CallPiece), in order; with `all`, calls of every tool fold together. Pure. */
export function callPieces(tools: readonly ToolRow[], all = false): CallPiece[] {
  const out: CallPiece[] = []
  let run: ToolRow[] = []
  const flush = () => {
    if (run.length > 1) out.push({ kind: 'run', tools: run })
    else if (run.length === 1) out.push({ kind: 'line', tool: run[0] })
    run = []
  }
  for (const t of tools) {
    if (all || isRawCall(t.name)) {
      run.push(t)
      continue
    }
    flush()
    out.push({ kind: 'line', tool: t })
  }
  flush()
  return out
}

/** The most tools a folded run's chip names before +N stands for the calls of the rest. */
export const RUN_TOOLS_SHOWN = 3

/** A folded run's chip in words: each tool and its call count (Bash 2 · Grep 1), most used first, ties in first-use
 * order; past RUN_TOOLS_SHOWN tools, the rest as a count (`more`). Pure. */
export function runTools(tools: readonly ToolRow[]): { tools: { name: string; n: number }[]; more: number } {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const name = toolDisplayName(t.name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  // a Map keeps the order of first use, and the sort is stable, so ties keep it
  const all = [...counts].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n)
  const shown = all.length > RUN_TOOLS_SHOWN + 1 ? all.slice(0, RUN_TOOLS_SHOWN) : all
  return { tools: shown, more: all.slice(shown.length).reduce((k, t) => k + t.n, 0) }
}

/** A run of consecutive raw calls, each shown as one chip line. */
export interface CallsRow {
  kind: 'calls'
  /** the log index of the run's first call */
  index: number
  tools: ToolRow[]
}

/** How long a run of calls took, in whole seconds, from the first call to the last result; null while it runs or when
 * a time is missing. Pure. */
export function toolSeconds(tools: readonly ToolRow[]): number | null {
  const first = tools[0]?.ts
  const last = tools[tools.length - 1]?.result?.ts
  if (!first || !last) return null
  const ms = Date.parse(last) - Date.parse(first)
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null
}

/** A card's meta: the number of steps and, once they are done, how long they took (1 step · 12s). Pure. */
export function toolMeta(tools: readonly ToolRow[]): string {
  const n = tools.length
  const secs = toolSeconds(tools)
  return `${n} ${n === 1 ? 'step' : 'steps'}${secs != null ? ` · ${secs}s` : ''}`
}

/** A call as one step of its card: its wire name and what it was about (add_card · Agents per run). */
export function stepText(t: ToolRow): string {
  const summary = toolSummary(t.name, t.input)
  return summary ? `${toolDisplayName(t.name)} · ${summary}` : toolDisplayName(t.name)
}

/** The question of each card the calls in `rows` made or edited, by card id, nested calls included. Pure. */
export function cellQuestions(rows: readonly Row[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (list: readonly Row[]) => {
    for (const r of list) {
      if (r.kind !== 'tool') continue
      const n = toolDisplayName(r.name)
      if (n === 'add_card' || n === 'edit_card') {
        const inp = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>
        const q = oneLine(str(inp.question ?? inp.title))
        const id = madeCell(r) ?? (n === 'edit_card' ? (CELL_ID_RE.exec(str(inp.card ?? inp.cell))?.[1] ?? null) : null)
        if (id && q) out.set(id, q)
      }
      walk(r.children)
    }
  }
  walk(rows)
  return out
}

const CELL_ID_RE = /^(?:(?:card|cell):)?([A-Za-z0-9_-]+)/

/** What a ref points at, in words, never its id: a card's question (or `a card`), the report, a view's name, a file and
 * line. Pure. */
export function refWords(ref: string, questions: ReadonlyMap<string, string>): string {
  const p = parseRef(ref)
  const words = (slug: string) => slug.replace(/[-_]+/g, ' ')
  if (!p) return ''
  switch (p.kind) {
    case 'cell':
      return questions.get(p.cellId) ?? 'a card'
    case 'group':
      return 'a group'
    case 'report':
      return `the ${words(p.slug)}`
    case 'view':
      return `view ${words(p.slug)}`
    case 'concept':
      return 'a label'
    case 'chat':
      return 'a message'
    case 'call':
      return `call ${p.n}`
    case 'ui':
      return words(p.name)
    case 'table':
    case 'row':
      return `${corpusRelative(p.path)}, table ${p.table}`
    case 'page':
      return `${corpusRelative(p.path)} page ${p.page}`
    case 'csvrow':
      return `${corpusRelative(p.path)} row ${p.row}`
    case 'pointer':
      return `${corpusRelative(p.path)} ${p.pointer}`
    case 'record':
    case 'range':
    case 'block':
    case 'span':
      return `${corpusRelative(p.path)} line ${p.line}`
    case 'path':
      return corpusRelative(p.path)
  }
}

/** A call as a step the analyst reads in a task's strip or a subagent's card: what it did as a verb, then what it was
 * about in plain words, such as a card's question (Added card · Agents per run); never a ref id or a wire name. Pure. */
export function plainStep(t: ToolRow, questions: ReadonlyMap<string, string> = new Map()): string {
  const inp = (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>
  const with_ = (verb: string, what: string) => (what ? `${verb} · ${what}` : verb)
  const cellQ = (v: unknown) => {
    const m = CELL_ID_RE.exec(str(v).trim())
    return m ? (questions.get(m[1]) ?? '') : ''
  }
  const refs = (v: unknown) =>
    str(v)
      .split(',')
      .map((r) => refWords(r.trim(), questions))
      .filter(Boolean)
      .join(', ')
  switch (toolDisplayName(t.name)) {
    case 'add_card':
      return with_('Added card', oneLine(str(inp.question ?? inp.title)))
    case 'edit_card':
      return with_('Edited card', oneLine(str(inp.question ?? inp.title)) || cellQ(inp.card ?? inp.cell) || oneLine(str(inp.takeaway ?? '').replace(/\[\[([^\]|]*)\|[^\]]*\]\]/g, '$1')))
    case 'delete_card':
      return with_('Deleted card', cellQ(inp.card ?? inp.cell))
    case 'list_cards': {
      const g = str(inp.group).trim()
      return g && g.toLowerCase() !== 'all' ? `Listed cards in ${g}` : 'Listed cards'
    }
    case 'read_ref':
      return with_('Read', refs(inp.ref ?? inp.span))
    case 'screenshot':
      return with_('Took screenshot', refs(inp.ref))
    case 'apply_label':
      return with_('Applied label', str(inp.name))
    case 'show_label':
      return with_(inp.on === false ? 'Hid label' : 'Showed label', str(inp.name))
    case 'run_check':
      return with_('Ran check', str(inp.name))
    case 'stop_check':
      return with_('Turned off check', str(inp.name))
    case 'propose_view':
      return with_('Proposed view', str(inp.name))
    case 'write_document':
      return with_('Wrote', inp.doc ? `the ${str(inp.doc)}` : '')
    case 'edit_document':
      return with_('Edited', refs(inp.span ?? inp.ref))
    case 'add_comment':
      return with_('Commented on', refs(inp.span ?? inp.ref))
    case 'resolve_comment':
      return with_(inp.reopen === true ? 'Reopened comment' : 'Resolved comment', str(inp.comment).startsWith('report:') ? refs(inp.comment) : '')
    case 'reply_in_thread':
      return 'Replied'
    case 'message_thread':
      return with_(inp.message ? 'Sent to thread' : 'Asked again in thread', str(inp.thread))
    case 'wait_session':
      return with_('Waited for', str(inp.session))
    case 'list_agents':
      return 'Listed agents'
    case 'rename_thread':
      return with_('Renamed thread', `${str(inp.thread)} to ${str(inp.name)}`)
    case 'delete_thread':
      return with_('Deleted thread', str(inp.thread))
    case 'file_dev_ticket':
      return with_('Filed ticket', oneLine(str(inp.title)))
    case 'Read':
      return with_('Read', filePlain(str(inp.file_path ?? inp.path)))
    case 'Grep':
      return with_('Searched for', oneLine(str(inp.pattern), 60))
    case 'Glob':
      return with_('Listed files', oneLine(str(inp.pattern), 60))
    case 'Bash':
      return with_('Ran', oneLine(str(inp.description)) || firstLine(str(inp.command)))
    case 'Edit':
    case 'MultiEdit':
      return with_('Edited', filePlain(str(inp.file_path ?? inp.path)))
    case 'Write':
      return with_('Wrote', filePlain(str(inp.file_path ?? inp.path)))
    case 'WebFetch':
      return with_('Fetched', str(inp.url))
    case 'WebSearch':
      return with_('Searched the web for', str(inp.query))
    case 'Agent':
    case 'Task':
      return with_('Started', taskTitle(oneLine(str(inp.description))))
    case 'Workflow':
      return with_('Ran workflow', workflowTitle(inp))
    case 'Skill':
      return with_('Loaded skill', str(inp.skill ?? inp.name))
    case 'SubagentHandback':
      return 'Handed back its summary'
    default:
      return with_(toolWord(t.name), toolSummary(t.name, t.input))
  }
}

/** A file as a plain step names it: relative to the corpus, or its name alone for a file outside it. Pure. */
function filePlain(p: string): string {
  const rel = corpusRelative(p)
  return rel.startsWith('/') ? (rel.split('/').pop() ?? rel) : rel
}

/** A subagent's title as its card shows it: a ref in it named by its kind alone (`Verify report:report` is `Verify
 * report`). Pure. */
export function taskTitle(title: string): string {
  return title.replace(/\b([A-Za-z]+):[A-Za-z0-9_#@./-]+/g, '$1').replace(/\s+/g, ' ').trim()
}

/** Whether a call's result only says a background subagent was launched: its work goes on, so the call is not done. */
export function launchedOnly(t: ToolRow): boolean {
  return !!t.result && !t.result.is_error && /^Async agent launched/i.test(t.result.summary)
}

function stepState(t: ToolRow, pending: boolean): StepState {
  if (t.result?.not_run) return 'skipped'
  if (t.result && !launchedOnly(t)) return t.result.is_error ? 'failed' : 'done'
  return pending ? 'running' : 'pending'
}

/** A card's steps: each call, then the calls of a subagent it ran, in order. `plain` words them for the analyst
 * (plainStep), as a task's strip and a subagent's card show them; otherwise a step is the wire name and its summary. */
export function toolSteps(tools: readonly ToolRow[], pending: boolean, opts: { plain?: boolean } = {}): ToolStep[] {
  const out: ToolStep[] = []
  const questions = opts.plain ? cellQuestions(tools) : new Map<string, string>()
  const add = (list: readonly Row[]) => {
    for (const t of list) {
      if (t.kind !== 'tool') continue
      out.push({ key: t.id, text: opts.plain ? plainStep(t, questions) : stepText(t), state: stepState(t, pending) })
      add(t.children)
    }
  }
  add(tools)
  return out
}

/** The card's right edge: running while a call waits on a live reply, failed when any call failed, ✓ once every call
 * came back; nothing for a call that never did, or for a background subagent's launch. */
export function groupState(tools: readonly ToolRow[], pending: boolean): ToolState | null {
  if (pending && tools.some((t) => !t.result)) return 'running'
  if (tools.some((t) => t.result?.is_error)) return 'failed'
  return tools.every((t) => t.result && !launchedOnly(t)) ? 'done' : null
}

// ---- what a subagent left, and where a thread branched from main ----

export interface MadeCell {
  id: string
  /** the canvas group the call named, as its last part in lower case (orientation, a group of the analyst's); '' when it
   * named none */
  group: string
}
/** What a log's calls made, nested calls included, in order and once each: the cards (made or edited), the views
 * proposed, the labels applied and the documents written. */
export interface Made {
  cells: MadeCell[]
  views: string[]
  /** each proposed view's slug by its name, read from its call's result (`view:<slug>`), which its ViewChip is keyed by */
  viewSlugs?: Record<string, string>
  labels: string[]
  docs: string[]
  /** each group's name as the call wrote it (Orientation), by its key in `cells` and `labelCards` */
  groupNames?: Record<string, string>
  /** the card of each applied label whose result named one (the orientation's labels get none), one per label name, in
   * the group its call named ('' for none). The canvas counts these among a group's cards, so the chat's counts do too. */
  labelCards: { name: string; group: string; id: string }[]
}

/** Every card a log left on the canvas: the cards it made or edited and its labels' cards. Pure. */
export function madeCards(made: Made): number {
  return made.cells.length + made.labelCards.length
}

/** The group names a call gives the orientation's deck: `Orientation`, and the alias `Final` (backend
 * orientation.DECK_ALIASES). */
const DECK_GROUPS = new Set(['orientation', 'final'])

/** What an orientation's log made, as its session files it: a card whose call names no group is in the deck, where the
 * server puts it (backend tools.default_group). Pure. */
export function orientMade(made: Made): Made {
  const fill = (g: string) => g || 'orientation'
  return {
    ...made,
    cells: made.cells.map((c) => ({ ...c, group: fill(c.group) })),
    labelCards: made.labelCards.map((l) => ({ ...l, group: fill(l.group) })),
    groupNames: { orientation: 'Orientation', ...made.groupNames },
  }
}

/** The cards an orientation left in its deck, its labels' cards among them; 0 when it wrote no deck. Pure. */
export function deckCards(made: Made): number {
  return made.cells.filter((c) => DECK_GROUPS.has(c.group)).length + made.labelCards.filter((l) => DECK_GROUPS.has(l.group)).length
}

const CELL_HEAD_RE = /^(?:card|cell):([A-Za-z0-9_-]+)\s*$/m

/** The card an add_card or edit_card call made or edited: its result's `cell_id`, else the `card:<id>` line its summary
 * opens with. Pure. */
export function madeCell(t: ToolRow): string | null {
  if (!t.result || t.result.is_error) return null
  if (t.result.cell_id) return t.result.cell_id
  const first = t.result.summary.split('\n', 1)[0] ?? ''
  const m = CELL_HEAD_RE.exec(first)
  return m ? m[1] : null
}

const groupName = (g: unknown): string => {
  const s = typeof g === 'string' ? g.trim() : ''
  return s ? (s.split('/').pop() ?? s).trim() : ''
}
const groupPart = (g: unknown): string => groupName(g).toLowerCase()

/** The slug a propose_view result names (`Proposed the view Inbox (view:inbox) over …`). */
const VIEW_REF_RE = /\(view:([a-z0-9][a-z0-9-]{0,39})\)/
/** A view's own ref, `view:<slug>`, as a chip names it. */
const VIEW_KEY_RE = /^view:([a-z0-9][a-z0-9-]{0,39})$/

/** The calls whose `group` places a card, and so names a group of the canvas. */
const PLACING = new Set(['add_card', 'edit_card', 'apply_label'])

/** What `rows` made, walked depth first. Pure. */
export function madeBy(rows: readonly Row[]): Made {
  const out: Made = { cells: [], views: [], labels: [], docs: [], labelCards: [] }
  const add = (list: string[], v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : ''
    if (s && !list.includes(s)) list.push(s)
  }
  const walk = (list: readonly Row[]) => {
    for (const r of list) {
      // a viewer thimble proposed for the run as it started (backend orient_session._note_proposed)
      if (r.kind === 'chip' && r.chip === 'view') {
        add(out.views, r.text)
        const slug = VIEW_KEY_RE.exec(r.ref ?? '')?.[1]
        if (slug) out.viewSlugs = { ...out.viewSlugs, [r.text]: slug }
        continue
      }
      if (r.kind !== 'tool') continue
      const inp = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>
      const ok = !!r.result && !r.result.is_error
      const tool = toolDisplayName(r.name)
      const g = groupPart(inp.group)
      if (g && PLACING.has(tool) && !out.groupNames?.[g]) out.groupNames = { ...out.groupNames, [g]: groupName(inp.group) }
      switch (tool) {
        case 'add_card':
        case 'edit_card': {
          const id = madeCell(r)
          if (!id) break
          // an edit of a label's card is of a card counted with its label, so it is not counted again
          const label = out.labelCards.find((l) => l.id === id)
          if (label) {
            if (groupPart(inp.group)) label.group = groupPart(inp.group)
            break
          }
          const had = out.cells.find((c) => c.id === id)
          // a later edit_card that names a group moved the card there
          if (!had) out.cells.push({ id, group: groupPart(inp.group) })
          else if (groupPart(inp.group)) had.group = groupPart(inp.group)
          break
        }
        case 'delete_card': {
          // a card the run made and then deleted, such as a duplicate or a trial, is not among what it made
          const id = str(inp.card ?? inp.cell).trim().replace(/^(?:card|cell):/, '')
          if (ok && id) {
            out.cells = out.cells.filter((c) => c.id !== id)
            out.labelCards = out.labelCards.filter((l) => l.id !== id)
          }
          break
        }
        case 'propose_view': {
          if (!ok) break
          add(out.views, inp.name)
          const slug = VIEW_REF_RE.exec(r.result?.summary ?? '')?.[1]
          const name = str(inp.name).trim()
          if (slug && name) out.viewSlugs = { ...out.viewSlugs, [name]: slug }
          break
        }
        case 'apply_label': {
          if (!ok) break
          // a trial on a few units (`limit`) is no label until a call runs it on everything (backend concepts.py, Trials)
          if (inp.limit == null || inp.limit === '') add(out.labels, inp.name)
          const name = str(inp.name).trim()
          const id = r.result?.label_card
          if (!id) break
          if (name && !out.labelCards.some((c) => c.name === name)) out.labelCards.push({ name, group: groupPart(inp.group), id })
          // a label applied again after edit_card changed its card: the card is the label's, not one more
          out.cells = out.cells.filter((c) => c.id !== id)
          break
        }
        case 'write_document':
          if (ok) add(out.docs, inp.doc)
          break
      }
      walk(r.children)
    }
  }
  walk(rows)
  return out
}

/** How long a run took, for a card's meta: 45s, 6 min, 1 h 20 min; '' without both ends. Pure. */
export function durationText(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return ''
  const s = Math.round((Date.parse(end) - Date.parse(start)) / 1000)
  if (!Number.isFinite(s) || s < 0) return ''
  if (s < 60) return `${s}s`
  const min = Math.round(s / 60)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

/** `3 views, 17 cards and a draft report`: the counts that are not zero, joined the way a sentence lists them. Pure. */
export function reviewList(counts: { views: number; cells: number; labels: number; report: boolean }): string {
  const n = (k: number, one: string, many: string) => (k > 0 ? `${k} ${k === 1 ? one : many}` : '')
  const parts = [n(counts.views, 'view', 'views'), n(counts.cells, 'card', 'cards'), n(counts.labels, 'label', 'labels'), counts.report ? 'a draft report' : ''].filter(Boolean)
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** Where a thread branched from main: the number of main's records up to the thread's creation (the first record
 * stamped later, a text record belonging with the stamped record before it). Pure. */
export function branchIndex(records: readonly ChatRecord[], createdAt: string): number {
  const at = Date.parse(createdAt)
  if (!Number.isFinite(at)) return records.length
  for (let i = 0; i < records.length; i++) {
    const ts = (records[i] as { ts?: string }).ts
    if (ts && Date.parse(ts) > at) return i
  }
  return records.length
}

/** A thread asked from main, as main shows it where it branched: what it was asked about and the way to it. */
export interface BranchRow {
  kind: 'branch'
  /** the log index it sits before; rows at that index follow it */
  index: number
  chat: string
  anchors: string[]
}

/** Main's rows with a branch row where each of `threads` was asked, in order. Pure. */
export function withBranches<T extends { index: number }>(rows: readonly T[], records: readonly ChatRecord[], threads: readonly { id: string; created_at: string; anchors: string[] }[]): (T | BranchRow)[] {
  const marks = threads
    .map((t) => ({ kind: 'branch' as const, index: branchIndex(records, t.created_at), chat: t.id, anchors: t.anchors, at: t.created_at }))
    .sort((a, b) => a.index - b.index || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const out: (T | BranchRow)[] = []
  let k = 0
  for (const r of rows) {
    while (k < marks.length && marks[k].index <= r.index) {
      const { at: _at, ...mark } = marks[k++]
      out.push(mark)
    }
    out.push(r)
  }
  while (k < marks.length) {
    const { at: _at, ...mark } = marks[k++]
    out.push(mark)
  }
  return out
}


// ---- what main leaves to the work's own cards and threads ----

/** What main needs to know of the work that shows elsewhere, to leave it out of its own transcript. */
export interface MainContext {
  /** the Agent calls whose subagent has a chat of its own (its meta's `tool_use_id`), which shows as its card or thread */
  spawned: ReadonlySet<string>
  /** the summaries the orientation handed back (orientSummaries: its last message, and in an earlier build's log, where
   * it ran as main's subagent, its hand-backs); main's word-for-word relay of one is left out, since the orientation's
   * thread shows it and main shows the counted line and the card */
  summaries: readonly string[]
  /** when each subagent ran, from its chat's creation to its end (null while it runs): a label run started then is the
   * subagent's, and its card lists the label */
  runs: readonly { from: string; to: string | null }[]
  /** the views the orientation's calls proposed (madeBy's views of its rows): its card lists them under Views, and
   * while it runs the views bar in Files shows them, so main writes no note of its own for them */
  views?: readonly string[]
  /** the writers of the orientation's report pass (orientWriters): the orientation's card shows each under Report, so
   * main writes no row for its start or its saves */
  orientWriters?: readonly OrientWriter[]
}

/** A writer that answers the orientation's report pass, which the orientation's card carries under Report. */
export interface OrientWriter {
  chat: string
  /** the orientation's chat, and the run of it whose card carries the writer (0 for its first) */
  orient: string
  run: number
  doc: string
  from: string
  to: string | null
  status: 'running' | 'done' | 'failed' | 'stopped'
  /** a writer with no `orient` in its meta, told by when it ran; its saves' chips are told by their time too */
  inferred?: boolean
}

/** How soon after the orientation ended a writer of the report must start to count as its report pass, when its meta
 * cannot say (orientWriters). */
export const ORIENT_WRITER_GAP_MS = 60_000

type WriterMeta = { id: string; role: string; created_at: string; status?: string | null; ts_end?: string | null; doc?: string | null; orient?: string | null; orient_run?: number | null }

/**
 * The writers of the orientation's report pass among `metas`: a writer whose meta names the orientation (`orient`), or,
 * for a meta with no `orient`, a report writer that started while an orientation ran or within ORIENT_WRITER_GAP_MS of
 * its end. A writer whose `orient` is null was asked for by the analyst and keeps its rows in main. Pure.
 */
export function orientWriters(metas: Iterable<WriterMeta>): OrientWriter[] {
  const all = [...metas]
  const orients = all.filter((m) => m.role === 'orient')
  const out: OrientWriter[] = []
  for (const m of all) {
    if (m.role !== 'writer') continue
    let orient: string | null = null
    let run = 0
    let inferred = false
    if (typeof m.orient === 'string' && m.orient) {
      orient = m.orient
      run = typeof m.orient_run === 'number' ? m.orient_run : 0
    } else if (!('orient' in m) && (m.doc ?? 'report') === 'report') {
      const at = Date.parse(m.created_at)
      const o = orients.find((x) => {
        const from = Date.parse(x.created_at)
        const to = x.ts_end ? Date.parse(x.ts_end) + ORIENT_WRITER_GAP_MS : Infinity
        return Number.isFinite(at) && at >= from && at <= to
      })
      orient = o?.id ?? null
      inferred = true
    }
    if (!orient) continue
    const status = m.status === 'done' || m.status === 'failed' || m.status === 'stopped' ? m.status : 'running'
    out.push({ chat: m.id, orient, run, doc: m.doc || 'report', from: m.created_at, to: m.ts_end ?? null, status, ...(inferred ? { inferred } : {}) })
  }
  return out
}

/** The writer of orientation `orient`'s report pass that its card for run `run` carries (every run's card, the
 * latest, when `run` is unset): the latest one started for it. Pure. */
export function orientWriterOf(writers: readonly OrientWriter[], orient: string, run?: number): OrientWriter | null {
  const mine = writers.filter((w) => w.orient === orient && (run == null || w.run === run))
  return mine.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))[mine.length - 1] ?? null
}

/** Whether main's record is a row of a writer of the orientation's report pass: its start (`agent`), or a save of its
 * document that names the writer (`writer`) or, for an inferred writer, falls on its document while it ran. Pure. */
export function isOrientWriterRecord(e: ChatRecord, writers: readonly OrientWriter[]): boolean {
  if (!writers.length) return false
  if (e.type === 'agent') return e.role === 'writer' && writers.some((w) => w.chat === e.chat)
  if (e.type !== 'chip' || e.kind !== 'artifact') return false
  const rec = e as { writer?: unknown; ref?: string; ts?: string }
  if (typeof rec.writer === 'string') return writers.some((w) => w.chat === rec.writer)
  const p = rec.ref ? parseRef(rec.ref) : null
  if (!p || p.kind !== 'report') return false
  const at = rec.ts ? Date.parse(rec.ts) : NaN
  return writers.some((w) => {
    if (!w.inferred || w.doc !== p.slug) return false
    const from = Date.parse(w.from)
    const to = w.to ? Date.parse(w.to) : Infinity
    return Number.isFinite(at) && at >= from && at <= to
  })
}

// the calls that start an agent chat of their own: a subagent, or a workflow the mirror follows as one chat (session.py)
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow'])
const LABEL_RUN_PREFIX = 'label '
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The name of the label a label run follows: its title after `label `. Pure. */
export function labelRunName(title: string): string {
  return title.startsWith(LABEL_RUN_PREFIX) ? title.slice(LABEL_RUN_PREFIX.length).trim() : title.trim()
}

/** The summaries an orientation's rows handed back: each SubagentHandback's message (an earlier build's, which ran the
 * orientation as main's subagent; it now runs as its own session) and, once the orientation
 * has ended, its last message. Claude Code's API error line is no summary, so main's copy of the same line still shows.
 * Pure. */
export function orientSummaries(rows: readonly Row[], ended = false): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r.kind !== 'tool' || toolDisplayName(r.name) !== 'SubagentHandback') continue
    const inp = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>
    const m = str(inp.message).trim()
    if (m && !isApiError(m)) out.push(m)
  }
  if (!ended) return out
  const last = [...rows].reverse().find((r) => r.kind === 'text')
  if (last && last.kind === 'text' && last.text.trim() && !isApiError(last.text)) out.push(last.text.trim())
  return out
}

// ---- Claude Code's API errors in main ----

/** The words that open the line Claude Code writes as the assistant's message when a request failed for good (its
 * retries at capacity spent, a request refused): `API Error: Repeated 529 Overloaded errors`. */
export const API_ERROR = 'API Error: '
/** The error row's kind for that line (withApiErrors). */
export const API_ERROR_KIND = 'api-error'

/** Whether a text is Claude Code's API error line. Pure. */
export const isApiError = (text: string): boolean => text.trim().startsWith(API_ERROR)

/** Claude Code's error line after the words a reply streamed before the request failed (`Now the page: API Error:
 * Server error mid-response. The response above may be incomplete.`): one of its own wordings, running to the end. */
const TRAILING_API_ERROR = /(?:^|\s)(API Error: (?:Repeated \d{3}|\d{3} \{|Server error|Connection error|Rate limit|Request timed out|Request was aborted|[^\n]{0,40}overloaded)[\s\S]*)$/

/** Where Claude Code's API error line begins in a text: 0 when the text is the line, the offset of a line that ends a
 * reply cut short, -1 for none. Pure. */
export function apiErrorAt(text: string): number {
  const t = text.trimEnd()
  if (isApiError(t)) return t.length - t.trimStart().length
  const m = TRAILING_API_ERROR.exec(t)
  return m ? t.length - m[1].length : -1
}

/** The kinds of failure an API error card names, sorted as the backend's retry.transient_class sorts them, and `other`
 * for an error that is none of them (a request the API refused). */
export type ApiFailure = 'overloaded' | 'rate_limited' | 'server_error' | 'connection' | 'other'

const FAILURE_OF_STATUS: Readonly<Record<number, ApiFailure>> = { 429: 'rate_limited', 500: 'server_error', 502: 'server_error', 503: 'server_error', 504: 'server_error', 529: 'overloaded' }
const FAILURE_OF_BODY: Readonly<Record<string, ApiFailure>> = { overloaded_error: 'overloaded', api_error: 'server_error', server_error: 'server_error', rate_limit_error: 'rate_limited' }
const STATUS_TEXT = /\b(?:HTTP|API Error:?|Error code:?|status(?: code)?:?)\s*(\d{3})\b/i
const BARE_STATUS = /\b(429|5\d\d)\b/
const BODY_TEXT = /\b(overloaded_error|api_error|server_error|rate_limit_error)\b/i
const CONNECTION_TEXT = /connection error|connection reset|connection refused|econnreset|econnrefused|etimedout|socket hang up|fetch failed|network error/i

/** What an API error says failed, and the HTTP status it names (`Repeated 529 Overloaded errors`: 529), from Claude
 * Code's error line or the server's words for it; the same patterns the backend's retry.transient_class reads. Pure. */
export function apiFailure(text: string): { failure: ApiFailure; status: number | null } {
  const named = STATUS_TEXT.exec(text)?.[1] ?? BARE_STATUS.exec(text)?.[1]
  const status = named ? Number(named) : null
  const body = BODY_TEXT.exec(text)?.[1]?.toLowerCase()
  const failure: ApiFailure = /overloaded/i.test(text)
    ? 'overloaded'
    : status != null && FAILURE_OF_STATUS[status]
      ? FAILURE_OF_STATUS[status]
      : body
        ? FAILURE_OF_BODY[body]
        : /rate[ _-]?limit/i.test(text)
          ? 'rate_limited'
          : /server error/i.test(text)
            ? 'server_error'
            : CONNECTION_TEXT.test(text)
              ? 'connection'
              : 'other'
  return { failure, status }
}

const FAILURE_WORDS: Readonly<Record<ApiFailure, string>> = {
  overloaded: "Anthropic's API is overloaded",
  rate_limited: "Anthropic's API rate limit was reached",
  server_error: "Anthropic's API had a server error",
  connection: "The connection to Anthropic's API failed",
  other: "Anthropic's API returned an error",
}

/** What happened, in the card's head: the failure in plain words and its status (Anthropic's API is overloaded (529)). Pure. */
export function apiFailureText(text: string): string {
  const { failure, status } = apiFailure(text)
  return status != null ? `${FAILURE_WORDS[failure]} (${status})` : FAILURE_WORDS[failure]
}

/** The line a view build's run writes when the API ended a turn and the build waits it out (backend dev.run_view):
 * its reason and the wait in seconds, else null. Pure. */
export function capacityNote(text: string): { reason: string; wait: number } | null {
  const m = /^(Anthropic's API [^,]+), so the build waits (\d+) (s|min) and goes on$/.exec(text.trim())
  return m ? { reason: m[1], wait: Number(m[2]) * (m[3] === 'min' ? 60 : 1) } : null
}

/** A wait of `seconds` as the backend's lines write it (dev._minutes): `45 s` under a minute, else `2 min`. Pure. */
export function waitText(seconds: number): string {
  return seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`
}

/** Rows with each of Claude Code's API error lines as an error row (API_ERROR_KIND) in place of its text row; a line
 * that ends a reply cut short is split off, the error row's index half a step on so each row keeps its own key. Pure. */
export function withApiErrors<T extends { kind: string }>(rows: readonly T[]): (T | ErrorRow)[] {
  return rows.flatMap((r): (T | ErrorRow)[] => {
    const t = r as unknown as TextRow
    if (r.kind !== 'text') return [r]
    const at = apiErrorAt(t.text)
    if (at < 0) return [r]
    const error: ErrorRow = { kind: 'error', index: at === 0 ? t.index : t.index + 0.5, message: t.text.slice(at).trim(), errorKind: API_ERROR_KIND }
    return at === 0 ? [error] : [{ ...t, text: t.text.slice(0, at).trimEnd() } as unknown as T, error]
  })
}

/** What Retry under main's latest API error sends again: the analyst's message that opened the failed turn, with the
 * error's record index. Null when something came after the error, or when no message of the analyst's opened the turn.
 * `skip` names the records main leaves out (mainSkips). Pure. */
export function apiRetry(records: readonly ChatRecord[], skip?: ReadonlySet<number>): { index: number; text: string } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const e = records[i]
    if (skip?.has(i)) continue
    if (e.type === 'user' || e.type === 'tool_use' || e.type === 'agent') return null
    if (e.type !== 'text' || e.parent_tool_use_id) continue
    const at = apiErrorAt(e.delta)
    if (at < 0) return null
    for (let j = i - 1; j >= 0; j--) {
      const u = records[j]
      if (u.type === 'done') return null
      if (u.type === 'user') return u.text.trim() ? { index: at === 0 ? i : i + 0.5, text: u.text.trim() } : null
    }
    return null
  }
  return null
}

/** Session attached/ended lines some logs carry in main. The session's state is main's `attached`, so these are left
 * out of every chat. */
export const SESSION_LINES: readonly string[] = ['terminal attached', 'terminal ended']

/** Whether a record is one of the SESSION_LINES. Pure. */
export function isSessionLine(e: ChatRecord): boolean {
  return e.type === 'chip' && e.kind === 'session' && SESSION_LINES.includes(String(e.text ?? ''))
}

/** Whether a record is a chip for a remark filed from the UI feedback tool. A remark is feedback to the developer, not
 * part of the analysis, so it is left out of every chat. Pure. */
export function isFeedbackChip(e: ChatRecord): boolean {
  return e.type === 'chip' && e.kind === 'feedback'
}

/**
 * The records of main's log its transcript leaves out, by index: Agent or Workflow calls whose agents show as their own
 * card or thread (with their results), text that repeats a summary the orientation handed back, label runs a subagent
 * or a call in main started, view chips the orientation proposed, the orientation's report writer's start and saves
 * (isOrientWriterRecord), main's look at the agent tray (list_agents), session lines (isSessionLine) and feedback chips
 * (isFeedbackChip). Pure.
 */
export function mainSkips(records: readonly ChatRecord[], ctx: MainContext): Set<number> {
  const skip = new Set<number>()
  const hidden = new Set<string>()
  const summaries = new Set(ctx.summaries.map(squash).filter(Boolean))
  const labelsApplied = new Set<string>()
  const orientViews = new Set((ctx.views ?? []).map(squash).filter(Boolean))
  const writers = ctx.orientWriters ?? []
  const inRun = (ts: string | undefined) => {
    const at = ts ? Date.parse(ts) : NaN
    if (!Number.isFinite(at)) return false
    return ctx.runs.some((r) => {
      const from = Date.parse(r.from)
      const to = r.to ? Date.parse(r.to) : Infinity
      return Number.isFinite(from) && at >= from && at <= to
    })
  }
  records.forEach((e, i) => {
    switch (e.type) {
      case 'tool_use': {
        const name = toolDisplayName(e.name)
        const next = records[i + 1]
        const spawnedNext = next?.type === 'agent' && next.role !== 'labels' && next.role !== 'dev'
        if (AGENT_TOOLS.has(name) && !e.parent_tool_use_id && (ctx.spawned.has(e.id) || spawnedNext)) {
          hidden.add(e.id)
          skip.add(i)
        }
        // main's call that starts the orientation's or a writer's session: that session's own note in main stands for it.
        // Its look at the agent tray is bookkeeping, which the tray itself shows
        if ((name === 'start_orientation' || name === 'start_writing' || name === 'list_agents') && !e.parent_tool_use_id) {
          hidden.add(e.id)
          skip.add(i)
        }
        if (name === 'apply_label') {
          const inp = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>
          const n = squash(str(inp.name))
          if (n) labelsApplied.add(n)
        }
        return
      }
      case 'tool_result':
        if (hidden.has(e.id)) skip.add(i)
        return
      case 'text':
        if (summaries.size && !e.parent_tool_use_id && !isApiError(e.delta) && summaries.has(squash(e.delta))) skip.add(i)
        return
      case 'agent':
        if (e.role === 'labels' && (inRun(e.ts) || labelsApplied.has(squash(labelRunName(e.title))))) skip.add(i)
        if (isOrientWriterRecord(e, writers)) skip.add(i)
        return
      case 'chip':
        if (isOrientWriterRecord(e, writers)) skip.add(i)
        if (e.kind === 'view' && orientViews.has(squash(chipText('view', String(e.text ?? ''))))) skip.add(i)
        if (isSessionLine(e) || isFeedbackChip(e)) skip.add(i)
        return
      default:
        return
    }
  })
  return skip
}

/** A step's state as its agent chat's status says it: running, done, or failed (a failed or stopped agent). */
function stepStateOf(status: string | undefined | null): 'running' | 'done' | 'failed' {
  return status === 'done' ? 'done' : status === 'failed' || status === 'stopped' ? 'failed' : 'running'
}

/**
 * The steps of a session thimble started beside main (the orientation's or a writer's): its subagents and workflow
 * agents, each an agent chat whose `agent` record is in the session's log, named by threads.shortStepNames and with its
 * state from its meta. `open` makes each step open its agent's transcript. A session's own calls are rows in its
 * thread, never steps. Pure.
 */
export function sessionSteps(rows: readonly Row[], metas: ReadonlyMap<string, { status?: string | null; title?: string }>, running: boolean, open?: (chat: string) => void): ToolStep[] {
  const agents = rows.filter((r): r is Extract<Row, { kind: 'agent' }> => r.kind === 'agent')
  if (!agents.length) return []
  const names = shortStepNames(agents.map((a) => metas.get(a.chat)?.title || a.title))
  return agents.map((a, i) => ({
    key: a.chat,
    text: names[i],
    state: stepStateOf(metas.get(a.chat)?.status ?? (running ? 'running' : 'done')),
    ...(open ? { onOpen: () => open(a.chat) } : {}),
  }))
}

/** Whether a step has ended, well or not: what a strip counts as finished. Pure. */
export const stepEnded = (s: { state?: StepState }): boolean => s.state !== 'running' && s.state !== 'pending'

// ---- an orientation's runs: its first, then one per follow-up ----

/** Whether a row is a message that started a follow-up of the orientation (backend orientation.message): a `user`
 * record that says so by its event or its run, which the orientation's first message never does. Pure. */
export const isFollowUpRow = (r: Row): r is UserRow => r.kind === 'user' && (r.event === 'orient-follow-up' || (typeof r.run === 'number' && r.run > 0))

/** The texts of the analyst's messages a thread's log holds, by which the browser stops showing one it sent as on its
 * way: a follow-up's first record (isFollowUpRow), or a message thimble's browser passed on (`by` browser), which the
 * server records as it sends it (orient_session._show_message) with no `run`, since a message to a running
 * orientation starts none. Pure. */
export function landedTexts(rows: readonly Row[]): Set<string> {
  return new Set(rows.filter((r): r is UserRow => r.kind === 'user' && (r.by === 'browser' || isFollowUpRow(r))).map((r) => r.text.trim()))
}

/** The latest time a row of `rows` carries (a message, a call, its result, a step's start); null when none does. Pure. */
export function lastRowTs(rows: readonly Row[]): string | null {
  let best: string | null = null
  let at = -Infinity
  const see = (ts: string | undefined) => {
    const t = ts ? Date.parse(ts) : NaN
    if (Number.isFinite(t) && t > at) {
      at = t
      best = ts!
    }
  }
  for (const r of rows) {
    if (r.kind === 'user' || r.kind === 'agent' || r.kind === 'chip') see(r.ts)
    if (r.kind === 'tool') {
      see(r.ts)
      see(r.result?.ts)
    }
  }
  return best
}

/** One run of an orientation's session: `k` 0 for the first, then one per follow-up, with its rows and the messages
 * that started it (none for the first). */
export interface OrientRun {
  k: number
  rows: Row[]
  messages: UserRow[]
}

/**
 * An orientation's rows cut into its runs. A follow-up's message opens the run its record names (`run`); a message with
 * no run opens the next one, unless it follows another follow-up's message directly, as the messages queued during a
 * run go together when it ends. Pure.
 */
export function orientRuns(rows: readonly Row[]): OrientRun[] {
  const out: OrientRun[] = [{ k: 0, rows: [], messages: [] }]
  let prevFollowUp = false
  for (const r of rows) {
    if (!isFollowUpRow(r)) {
      prevFollowUp = false
      out[out.length - 1].rows.push(r)
      continue
    }
    const cur = out[out.length - 1]
    const k = typeof r.run === 'number' ? r.run : prevFollowUp ? cur.k : cur.k + 1
    if (k === cur.k && cur.k > 0) {
      cur.messages.push(r)
      cur.rows.push(r)
    } else out.push({ k, rows: [r], messages: [r] })
    prevFollowUp = true
  }
  return out
}

/**
 * What a follow-up changed, in words for the orientation's card (`revised 2 cards, added 1`): the cards revised, added
 * and deleted, the views proposed and the labels applied; '' for no change. A card added then edited or deleted counts
 * once. Pure.
 */
export function followUpSummary(rows: readonly Row[]): string {
  const added = new Set<string>()
  const revised = new Set<string>()
  const deleted = new Set<string>()
  const views = new Set<string>()
  const labels = new Set<string>()
  const walk = (list: readonly Row[]) => {
    for (const r of list) {
      if (r.kind !== 'tool') continue
      const inp = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>
      const ok = !!r.result && !r.result.is_error
      const name = toolDisplayName(r.name)
      if (name === 'add_card') {
        const id = madeCell(r)
        if (id) added.add(id)
      } else if (name === 'edit_card') {
        const id = madeCell(r) ?? (CELL_ID_RE.exec(str(inp.card ?? inp.cell).trim())?.[1] ?? null)
        if (ok && id && !added.has(id)) revised.add(id)
      } else if (name === 'delete_card') {
        const id = str(inp.card ?? inp.cell).trim().replace(/^(?:card|cell):/, '')
        if (!ok || !id) continue
        if (added.has(id)) added.delete(id)
        else {
          revised.delete(id)
          deleted.add(id)
        }
      } else if (name === 'propose_view' && ok) {
        const v = str(inp.name).trim()
        if (v) views.add(v)
      } else if (name === 'apply_label' && ok && (inp.limit == null || inp.limit === '')) {
        const l = str(inp.name).trim()
        if (l) labels.add(l)
      }
      walk(r.children)
    }
  }
  walk(rows)
  return changeSummary({ revised: revised.size, added: added.size, deleted: deleted.size, views: views.size, labels: labels.size })
}

/** A follow-up's message as the card of its run leads with it: an extension's orientation instructions as the line
 * that names the extension. Pure. */
export function leadText(m: UserRow): string {
  if (m.by === 'extension') return m.extension ? `${m.extension} added: its orientation instructions` : 'An extension’s orientation instructions'
  return m.text.trim()
}

/** What a follow-up changed, counted, in words: `revised 2 cards, added 1, proposed 1 view`; '' for nothing. The
 * server's counts (the chat meta's `followups`, read from the run's undo steps) or the log's (followUpSummary). Pure. */
export function changeSummary(c: { revised?: number; added?: number; deleted?: number; views?: number; labels?: number }): string {
  const parts: string[] = []
  let noun = false
  for (const [verb, n] of [['revised', c.revised ?? 0], ['added', c.added ?? 0], ['deleted', c.deleted ?? 0]] as const) {
    if (!n) continue
    parts.push(noun ? `${verb} ${n}` : `${verb} ${n} ${n === 1 ? 'card' : 'cards'}`)
    noun = true
  }
  if (c.views) parts.push(`proposed ${c.views} ${c.views === 1 ? 'view' : 'views'}`)
  if (c.labels) parts.push(`applied ${c.labels} ${c.labels === 1 ? 'label' : 'labels'}`)
  return parts.join(', ')
}

/** The rows with each call's number filled in from an orientation's call index (by tool_use id) where its record has
 * none. Pure. */
export function withCallNumbers(rows: readonly Row[], index: ReadonlyMap<string, number>): Row[] {
  if (!index.size) return [...rows]
  return rows.map((r) => (r.kind === 'tool' && r.n == null && index.has(r.id) ? { ...r, n: index.get(r.id)! } : r))
}

// ---- a subagent's own work, as its chip opens on it ----

/** A workflow agent's prompt opens with a bracketed harness tag and a paragraph about where the task came from, up to
 * `follows:` at a line's end; the task after it is indented. Without that line, the tag's own line is the preamble. */
const HARNESS_HEAD_RE = /^\s*\[[^\]\n]*harness[^\]\n]*\][\s\S]{0,2000}?follows:[ \t]*\n/i
const HARNESS_TAG_RE = /^\s*\[[^\]\n]*harness[^\]\n]*\][^\n]*(?:\n|$)/i

/** A subagent's prompt with the harness's preamble left off and the task it wraps dedented; any other text as it is.
 * Pure. */
const NOTIFICATION_RE = /\s*<task-notification>[\s\S]*?<\/task-notification>\s*/g

/** `text` without the `<task-notification>` blocks a model copied from Claude Code into its reply; unchanged (the same
 * string) when it holds none. Pure. */
export function withoutNotifications(text: string): string {
  if (!text.includes('<task-notification>')) return text
  return text.replace(NOTIFICATION_RE, '\n\n').trim()
}

export function stripHarness(text: string): string {
  const m = HARNESS_HEAD_RE.exec(text) ?? HARNESS_TAG_RE.exec(text)
  if (!m) return text
  const lines = text.slice(m[0].length).split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length))).join('\n').trim()
}

/** A file a subagent read, as its chip lists it: a file under the corpus is its ref (a line range when the read named
 * one), which its chip opens; a file outside it is its path alone. */
export interface AgentFile {
  ref: string | null
  path: string
}

// a word in a shell command that names a data file: a path whose last part has one of these extensions (a script the
// command runs is the agent's own tool, not what it reads)
const COMMAND_FILE_RE = /(?:^|[\s'"(=,[<>])((?:\/|\.{1,2}\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.(?:jsonl|json|csv|tsv|txt|md|log|ya?ml|parquet|html?|xml|sql|ipynb|toml))(?=$|[\s'")\],:;<>|&])/g

/** The files a subagent's calls read, in first-read order: each Read's path and line range, the path a Grep or Glob
 * searched, and files a Bash command names, each once. Paths under the corpus are relative to it. Pure. */
export function agentFiles(rows: readonly Row[], ws: string): AgentFile[] {
  const out: AgentFile[] = []
  const seen = new Set<string>()
  const add = (raw: string, from?: number, to?: number) => {
    const p = underCorpus(raw.trim(), ws).replace(/^\.\//, '')
    if (!p || p === '.') return
    const inCorpus = !p.startsWith('/') && !p.startsWith('~') && !p.startsWith('$')
    const range = from != null ? (to != null && to > from ? `#L${from}-L${to}` : `#L${from}`) : ''
    const key = `${p}${range}`
    if (seen.has(key) || seen.has(p)) return
    seen.add(key)
    out.push({ ref: inCorpus ? key : null, path: key })
  }
  const walk = (list: readonly Row[]) => {
    for (const t of list) {
      if (t.kind !== 'tool') continue
      const inp = (t.input ?? {}) as Record<string, unknown>
      const name = toolDisplayName(t.name)
      if (name === 'Read') {
        const offset = Number(inp.offset)
        const limit = Number(inp.limit)
        const from = Number.isFinite(offset) && offset > 0 ? offset : Number.isFinite(limit) && limit > 0 ? 1 : undefined
        add(str(inp.file_path ?? inp.path), from, from != null && Number.isFinite(limit) && limit > 0 ? from + limit - 1 : undefined)
      } else if ((name === 'Grep' || name === 'Glob') && inp.path) {
        add(str(inp.path))
      } else if (name === 'Bash') {
        for (const m of str(inp.command).matchAll(COMMAND_FILE_RE)) add(m[1])
      }
      walk(t.children)
    }
  }
  walk(rows)
  return out
}

/** A subagent's chip in words: a workflow agent's phase as its name and its key as its target, as a call line names its
 * tool and its target (`Read` `early-relay` for `Read: read:early-relay`, threads.stepParts); any other agent's title as
 * its name (taskTitle). Pure. */
export function agentChipName(title: string): { name: string; target: string } {
  const { phase, key } = stepParts(title)
  if (!phase) return { name: taskTitle(title), target: '' }
  const shown = title.trim().slice(0, phase.length)
  return { name: shown, target: key }
}
