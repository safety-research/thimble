// The fold of a chat log into rows the panel renders. `index` is the record's position in the log.
import type { MarkItem } from '../marks/marks'
import type { StepState, ToolState, ToolStep } from '../components/ToolCard'
import { parseRef, refLabel } from '../lib/refs'
import type { ChatRecord, LabelRunState } from '../lib/types'

export interface UserRow {
  kind: 'user'
  index: number
  text: string
  ts?: string
  /** where the analyst typed it: the session's terminal or the browser; `main` for a message main sent the orientation */
  by?: string
  /** with `by` terminal: the analyst typed it in Claude Code's agent tray, not a prompt main's call sent */
  tray?: boolean
  /** `orient-follow-up` on a message an earlier build passed to the orientation through main, kept in older logs; a
   * follow-up's message now says so by its `run` */
  event?: string
  /** the orientation's run that message started: 1 for its first follow-up */
  run?: number
  /** with `by` extension: the extension whose orientation instructions the message is */
  extension?: string
  /** the turn the message started (backend agent.Session.send), which its marks and v's cards name */
  turn?: string
}
export interface TextRow {
  kind: 'text'
  index: number
  text: string
  /** the check of this row's marks, by their order in its text (backend features/marks.py) */
  checks?: (MarkItem | undefined)[]
  /** the turn's marks, on the turn's last text row (its reply), for the footer under it */
  turnMarks?: MarkItem[]
  /** the cards v drew of this reply, which draw under it */
  cards?: string[]
  /** Claude Code's API error line, as the server read it from its record (backend session.api_error_class): the
   * failure's class, so the row is an error card whatever its words (withApiErrors) */
  apiError?: string
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
  /** the card a `card` call drew, and its version (backend features/cards.py) */
  card?: string
  version?: number
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
  /** the view a `view_failed` line names (backend dev._repairs_failed), whose chip it shows */
  view?: string
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
  /** a dev chat that builds or reviews this view rather than running a code ticket */
  view?: string
}
export interface ErrorRow {
  kind: 'error'
  index: number
  message: string
  errorKind?: string
  /** an API error's class, as the server read it from Claude Code's record (failureOf), which the card names */
  failure?: ApiFailure
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
export interface NoticeRow {
  kind: 'notice'
  index: number
  id: string
  key?: string
  /** the notice's kind (backend notices.post `kind`) */
  noticeKind?: string
  text: string
  agent?: string
  closed: boolean
  ts?: string
}
/** a label run in the chat (backend labels/asks.py): the ask before a model reads many records, then the run; its later
 * records change this row in place */
export interface LabelRunRow extends LabelRunState {
  kind: 'label_run'
  index: number
  ts?: string
}
export type Row = UserRow | TextRow | ToolRow | ChipRow | AgentRow | ErrorRow | NoteRow | NoticeRow | LabelRunRow

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
 * mirror copies the call only once Claude Code flushes its transcript, so the record can come first in the log. A
 * notice under the key of one still open replaces it in place, so a failure that happens again shows as one row; a
 * notice's end closes its row. Pure.
 */
export function foldRecords(records: readonly ChatRecord[], skip?: ReadonlySet<number>): Row[] {
  const rows: Row[] = []
  const calls = new Map<string, number>() // a top-level tool call's id -> its record's index, for the calls folded
  const notices = new Map<string, NoticeRow>() // a notice's key -> its row while it is open
  const labelRuns = new Map<string, LabelRunRow>() // a label run's id -> its row
  records.forEach((e, index) => {
    if (e.type === 'tool_use' && !skip?.has(index) && typeof e.parent_tool_use_id !== 'string') calls.set(e.id, index)
  })
  const held = new Map<string, AgentRow[]>() // the agent rows that wait for their call's row
  const marks = new Map<string, MarkItem[]>() // each turn's marks, the newest record of each
  const cards = new Map<string, string[]>() // each turn's v cards
  records.forEach((e, index) => {
    if (skip?.has(index)) return
    const parent = 'parent_tool_use_id' in e && typeof e.parent_tool_use_id === 'string' ? findTool(rows, e.parent_tool_use_id) : undefined
    const into = parent ? parent.children : rows
    switch (e.type) {
      case 'user':
        rows.push({ kind: 'user', index, text: e.text, ts: e.ts, by: e.by, ...(e.tray ? { tray: true } : {}), event: e.event, run: e.run, extension: e.extension, ...(e.turn ? { turn: e.turn } : {}) })
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
        // Claude Code's API error line, which the server marked by its record: a row of its own
        if (typeof e.api_error === 'string' && e.api_error) {
          into.push({ kind: 'text', index, text: e.delta, apiError: e.api_error })
          return
        }
        const last = into[into.length - 1]
        if (last && last.kind === 'text' && !last.apiError && !wholeMessage(e)) last.text += e.delta
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
        if (tool) tool.result = { summary: e.summary, ts: e.ts, is_error: e.is_error, cell_id: e.cell_id, notebook: e.notebook, ...(e.not_run ? { not_run: true } : {}), ...(e.label_card ? { label_card: e.label_card } : {}), ...(e.card ? { card: e.card, version: e.version } : {}) }
        return
      }
      case 'chip': {
        rows.push({ kind: 'chip', index, chip: String(e.kind), text: chipText(String(e.kind), e.text), ref: e.ref, ts: e.ts, status: typeof e.status === 'string' ? e.status : undefined, chat: typeof e.chat === 'string' ? e.chat : undefined, generation: typeof e.generation === 'number' ? e.generation : undefined, writer: typeof e.writer === 'string' ? e.writer : undefined, message: typeof e.message === 'string' ? e.message : undefined, view: typeof e.view === 'string' ? e.view : undefined })
        return
      }
      case 'agent': {
        const row: AgentRow = { kind: 'agent', index, chat: e.chat, role: e.role, title: e.title, ts: e.ts, ...(typeof e.run === 'number' ? { run: e.run } : {}), ...(e.view ? { view: e.view } : {}) }
        const call = e.tool_use_id ? calls.get(e.tool_use_id) : undefined
        if (e.tool_use_id && call !== undefined && call > index) held.set(e.tool_use_id, [...(held.get(e.tool_use_id) ?? []), row])
        else rows.push(row)
        return
      }
      case 'error':
        rows.push({ kind: 'error', index, message: e.message, errorKind: e.kind, detail: e.detail })
        return
      case 'done':
        // the turn's end draws nothing: its cards are on the canvas, which the page opened on the first (lib/events.ts),
        // and the composer's model line shows the model
        return
      case 'marks':
        marks.set(e.turn, e.items)
        return
      case 'card':
        cards.set(e.turn, [...new Set([...(cards.get(e.turn) ?? []), e.card])])
        return
      case 'label_run': {
        const { type: _t, ts, ...state } = e
        const row = labelRuns.get(e.id)
        if (row) Object.assign(row, state, ts ? { ts } : {})
        else {
          const made: LabelRunRow = { kind: 'label_run', index, ...state, ...(ts ? { ts } : {}) }
          labelRuns.set(e.id, made)
          rows.push(made)
        }
        return
      }
      case 'notice': {
        // the end of a notice (a fix that worked, or the analyst's ×): its row stays, closed; a later notice under its
        // key is a row of its own
        if (e.dismissed || e.cleared) {
          const id = e.id
          const row = (id ? rows.find((r): r is NoticeRow => r.kind === 'notice' && r.id === id) : undefined) ?? (e.key ? notices.get(e.key) : undefined)
          if (!row) return
          row.closed = true
          if (row.key) notices.delete(row.key)
          return
        }
        const text = typeof e.text === 'string' ? e.text.trim() : ''
        if (!text) return
        const fields = { id: e.id ? String(e.id) : `#${index}`, text, ...(e.kind ? { noticeKind: e.kind } : {}), ...(typeof e.agent === 'string' && e.agent.trim() ? { agent: e.agent.trim() } : {}), ...(e.ts ? { ts: e.ts } : {}) }
        // a notice under the key of one still open replaces it in place
        const open = e.key ? notices.get(e.key) : undefined
        if (open) {
          delete open.agent
          Object.assign(open, fields)
          return
        }
        const row: NoticeRow = { kind: 'notice', index, ...(e.key ? { key: e.key } : {}), closed: false, ...fields }
        if (e.key) notices.set(e.key, row)
        rows.push(row)
        return
      }
      default:
        return
    }
  })
  withTurns(rows, marks, cards)
  return rows
}

/** Each turn's marks and v cards on its text rows: a turn is the rows after the `user` row that names it, and its texts
 * are its top-level text rows in order, as the server reads them (backend agent.texts_of): a mark of text `piece` goes
 * to that row, at its order `k` among the row's marks. The turn's last text row, its reply, gets the turn's marks for
 * its footer and the cards v drew of it. */
function withTurns(rows: Row[], marks: ReadonlyMap<string, MarkItem[]>, cards: ReadonlyMap<string, string[]>): void {
  if (!marks.size && !cards.size) return
  let turn: string | undefined
  let texts: TextRow[] = []
  const end = () => {
    if (!turn) return
    const items = marks.get(turn) ?? []
    for (const m of items) {
      const row = texts[m.piece]
      if (!row) continue
      row.checks = row.checks ?? []
      row.checks[m.k] = m
    }
    const reply = texts[texts.length - 1]
    if (reply && items.length) reply.turnMarks = items
    if (reply && cards.has(turn)) reply.cards = cards.get(turn)
  }
  for (const r of rows) {
    if (r.kind === 'user') {
      end()
      turn = r.turn
      texts = []
    } else if (r.kind === 'text' && !r.apiError) texts.push(r)
  }
  end()
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

/** What a SubagentHandback call's line and step say: the agent sent its summary to main, as its folded row says
 * (HandBack's `Summary sent to main`); its summary shows once the line is opened. */
export const HANDBACK_LINE = 'Sent its summary to main'

/** The tool a call's line, chip or step names (Rows CallLine, runTools, stepText; a card of calls by toolGroupName):
 * toolDisplayName, but a SubagentHandback in words (HANDBACK_LINE). Pure. */
export function callToolName(name: string): string {
  const n = toolDisplayName(name)
  return n === 'SubagentHandback' ? HANDBACK_LINE : n
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
  return target ? `${callToolName(name)} ${target}` : callToolName(name)
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
    case 'delete_label':
      return inp.name ? `label “${oneLine(str(inp.name), 60)}”` : step
    case 'critique':
      return 'the critic’s report'
    case 'StructuredOutput':
      return 'an agent’s report'
    default:
      return step
  }
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

/** The input fields that name what a call of a tool the chat has no words for is about, in the order toolSummary looks
 * for one; else it takes the input's first field of text. */
const TARGET_KEYS: readonly string[] = ['description', 'title', 'name', 'query', 'url', 'file_path', 'path', 'pattern', 'prompt', 'message', 'command']

/** One line for a tool call's input; a Bash command has paths under workspace `ws`'s folder made relative before the
 * line is cut to length. */
export function toolSummary(name: string, input: unknown, ws = ''): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (toolDisplayName(name)) {
    case 'SubagentHandback':
      // its line says it all (HANDBACK_LINE); the summary is the call's input, shown once the line is opened
      return ''
    case 'Read':
      return corpusRelative(str(inp.file_path ?? inp.path))
    case 'Grep':
    case 'Glob':
      return [str(inp.pattern), inp.path ? `in ${corpusRelative(str(inp.path))}` : ''].filter(Boolean).join(' ')
    case 'card':
      return oneLine(str(inp.title))
    case 'run_python':
      return firstLine(str(inp.code))
    case 'apply_label':
      return [str(inp.name), inp.scope ? `on ${str(inp.scope)}` : ''].filter(Boolean).join(' ')
    case 'show_label':
      return [str(inp.name), inp.on === false ? 'off' : 'on'].join(' ')
    case 'delete_label':
      return str(inp.name)
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
      // a tool the chat has no words for: the field of its input that names what the call is about, never the input
      // as JSON (live QA 2: `SendFeedback {"type":"bug",…`)
      const named = (k: string) => typeof inp[k] === 'string' && str(inp[k]).trim() !== ''
      const key = TARGET_KEYS.find(named) ?? Object.keys(inp).find(named)
      return key ? oneLine(str(inp[key])) : ''
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
  card: 'Draw card',
  run_python: 'Run Python',
  apply_label: 'Apply label',
  show_label: 'Show label',
  delete_label: 'Delete label',
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
  apply_label: 'Label',
  show_label: 'Label',
  delete_label: 'Label',
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
  return TOOL_GROUPS[n] ?? (n === 'SubagentHandback' ? HANDBACK_LINE : toolWord(name))
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

/** Claude Code's tools the chat shows in a form of its own, beside those it has words for (TOOL_WORDS, TOOL_GROUPS). */
const SHOWN_TOOLS: ReadonlySet<string> = new Set(['Workflow', 'Skill', 'SubagentHandback', 'StructuredOutput'])

/** Whether a call is a raw call, by its wire name: one of RAW_TOOLS, or a call of a tool thimble does not know, such as
 * one of Claude Code's own (live QA 2: SendFeedback was a card of its own, its input as JSON). thimble's own tools are
 * never raw. Pure. */
export function isRawCall(name: string): boolean {
  const n = toolDisplayName(name)
  if (RAW_TOOLS.has(n)) return true
  return !MCP_PREFIXES.some((p) => name.startsWith(p)) && !Object.hasOwn(TOOL_WORDS, n) && !Object.hasOwn(TOOL_GROUPS, n) && !SHOWN_TOOLS.has(n)
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
    const name = callToolName(t.name)
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
  return summary ? `${callToolName(t.name)} · ${summary}` : callToolName(t.name)
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
    case 'delete_label':
      return with_('Deleted label', str(inp.name))
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
      return HANDBACK_LINE
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


/** The group names a call gives the orientation's deck: `Orientation`, and the alias `Final` (backend
 * orientation.DECK_ALIASES). */
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
export const API_ERROR = 'API Error: '
/** The error row's kind for that line (withApiErrors). */
export const API_ERROR_KIND = 'api-error'

/** Whether a text is Claude Code's API error line. Pure. */
export const isApiError = (text: string): boolean => text.trim().startsWith(API_ERROR)

/** Claude Code's error line after the words a reply streamed before the request failed (`Now the page: API Error:
 * Server error mid-response. The response above may be incomplete.`): one of its own wordings, running to the end, a
 * refusal by Claude's safeguards among them. */
const TRAILING_API_ERROR = /(?:^|\s)(API Error: (?:Repeated \d{3}|\d{3} \{|Server error|Connection error|Rate limit|Request timed out|Request was aborted|[^\n]{0,40}overloaded|[^\n]{0,60}safeguards|[^\n]{0,100}Usage Policy|Claude can.t help with this)[\s\S]*)$/

/** Claude Code 2.1.300's error lines that do not start with "API Error" (a sign-in, a model the account cannot use),
 * as the whole of a text: what a record from before the server marked them (`api_error`) shows, and a failed run's
 * result. */
const WHOLE_API_ERROR = /^(?:Not logged in · Please run \/login|Please run \/login · API Error: \d{3}\b[^\n]*|Failed to authenticate\. API Error: \d{3}\b[^\n]*|Invalid API key · [^\n]*|There's an issue with the selected model \([^\n]*)$/

/** Where Claude Code's API error line begins in a text: 0 when the text is the line, the offset of a line that ends a
 * reply cut short, -1 for none. Pure. */
export function apiErrorAt(text: string): number {
  const t = text.trimEnd()
  if (isApiError(t) || WHOLE_API_ERROR.test(t.trim())) return t.length - t.trimStart().length
  const m = TRAILING_API_ERROR.exec(t)
  return m ? t.length - m[1].length : -1
}

/** The kinds of failure an API error card names, sorted as the backend's retry.transient_class sorts them; `auth`
 * (401), `forbidden` (403), `not_found` (404, a model id the account or provider does not have) and `refused` (a
 * request Claude's safeguards or the usage policy stopped), which no retry fixes; and `other` for an error that is none
 * of them. */
export type ApiFailure = 'overloaded' | 'rate_limited' | 'server_error' | 'connection' | 'auth' | 'forbidden' | 'not_found' | 'refused' | 'other'

const FAILURE_OF_STATUS: Readonly<Record<number, ApiFailure>> = { 401: 'auth', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited', 500: 'server_error', 502: 'server_error', 503: 'server_error', 504: 'server_error', 529: 'overloaded' }
const FAILURE_OF_BODY: Readonly<Record<string, ApiFailure>> = { overloaded_error: 'overloaded', api_error: 'server_error', server_error: 'server_error', rate_limit_error: 'rate_limited', authentication_error: 'auth', permission_error: 'forbidden', not_found_error: 'not_found' }
const STATUS_TEXT = /\b(?:HTTP|API Error:?|Error code:?|status(?: code)?:?)\s*(\d{3})\b/i
const BARE_STATUS = /\b(429|5\d\d)\b/
const BODY_TEXT = /\b(overloaded_error|api_error|server_error|rate_limit_error|authentication_error|permission_error|not_found_error)\b/i
const CONNECTION_TEXT = /connection error|connection reset|connection refused|econnreset|econnrefused|etimedout|socket hang up|fetch failed|network error/i
/** A request Claude's safeguards stopped, in Claude Code's words or the API's (backend model.py's refusal detail):
 * "Opus 5.5's safeguards flagged this message", "… Usage Policy …", or "Claude can't help with this. Start a new session
 * to continue." */
const REFUSED_TEXT = /safeguards|usage polic|can['’]t help with this/i
/** Claude Code's refusal that takes the session with it: only a new session goes on. */
const NEW_SESSION_TEXT = /start a new session/i
/** Claude Code 2.1.300's lines of a sign-in that failed and of a model the account cannot use, which name no status
 * ("Not logged in · Please run /login", "There's an issue with the selected model (…)") */
const AUTH_TEXT = /not logged in|please run \/login|invalid api key|failed to authenticate|authentication_failed|oauth token/i
const NOT_FOUND_TEXT = /issue with the selected model|model_not_found/i

/** What an API error says failed, and the HTTP status it names (`Repeated 529 Overloaded errors`: 529), from Claude
 * Code's error line or the server's words for it; the same patterns the backend's retry.transient_class reads. Pure. */
export function apiFailure(text: string): { failure: ApiFailure; status: number | null } {
  const named = STATUS_TEXT.exec(text)?.[1] ?? BARE_STATUS.exec(text)?.[1]
  const status = named ? Number(named) : null
  const body = BODY_TEXT.exec(text)?.[1]?.toLowerCase()
  const failure: ApiFailure = REFUSED_TEXT.test(text)
    ? 'refused'
    : /overloaded/i.test(text)
      ? 'overloaded'
      : status != null && FAILURE_OF_STATUS[status]
        ? FAILURE_OF_STATUS[status]
        : body
          ? FAILURE_OF_BODY[body]
          : AUTH_TEXT.test(text)
            ? 'auth'
            : NOT_FOUND_TEXT.test(text)
              ? 'not_found'
              : /rate[ _-]?limit/i.test(text)
                ? 'rate_limited'
                : /server error/i.test(text)
                  ? 'server_error'
                  : CONNECTION_TEXT.test(text)
                    ? 'connection'
                    : 'other'
  return { failure, status }
}

/** The failure a class the server read from Claude Code's record names (backend session.api_error_class: its
 * apiErrorStatus and `error`, before its words), else null for one this page does not know. Pure. */
export function failureOf(kind: string | null | undefined): ApiFailure | null {
  return kind && kind in FAILURE_WORDS ? (kind as ApiFailure) : null
}

const FAILURE_WORDS: Readonly<Record<ApiFailure, string>> = {
  overloaded: "Anthropic's API is overloaded",
  rate_limited: "Anthropic's API rate limit was reached",
  server_error: "Anthropic's API had a server error",
  connection: "The connection to Anthropic's API failed",
  auth: "Claude Code's login or API key was refused",
  forbidden: 'Your account may not make this request',
  not_found: "This model isn't available to your account",
  refused: "Claude's safeguards stopped this request",
  other: "Anthropic's API returned an error",
}

/** Where a failure's fix runs (the browser can't run /login or /model): `browser`, a button or a reply
 * here (Retry, a rephrased request from the composer), or `terminal`, the Claude Code terminal where thimble runs,
 * whose fix the card says after "In your terminal:" and which no button here can take. */
export const FIX_WHERE: Readonly<Record<ApiFailure, 'browser' | 'terminal'>> = {
  overloaded: 'browser',
  rate_limited: 'browser',
  server_error: 'browser',
  connection: 'browser',
  auth: 'terminal',
  forbidden: 'terminal',
  not_found: 'terminal',
  refused: 'browser',
  other: 'browser',
}

/** What the analyst does about a failure no retry fixes, after its words in the card's head: a fix in the terminal
 * (FIX_WHERE) after "In your terminal:", to which `{then}` adds ", then Retry" where the card has Retry. */
const FAILURE_FIX: Readonly<Partial<Record<ApiFailure, string>>> = {
  auth: 'In your terminal: run /login (or claude auth login in a shell){then}.',
  forbidden: "In your terminal: check your sign-in (/login) and your account's or organization's settings{then}.",
  not_found: "In your terminal: run /model to pick another model (thimble's own agents take theirs from Settings){then}.",
  refused: 'rephrase or narrow the request and send it again.',
}
const NEW_SESSION_FIX = 'In your terminal: run /clear to start a new session, then send a rephrased or narrower request here.'

/** What happened, in the card's head: the failure in plain words and its status (Anthropic's API is overloaded (529)),
 * then what to do when no retry fixes it, and where (FIX_WHERE). A refusal names no status, which says nothing of why.
 * `failure` is the class the server read from Claude Code's record (failureOf), which decides before the words do;
 * `retry`, whether the card offers Retry, which a fix in the terminal comes before. Pure. */
export function apiFailureText(text: string, opts: { failure?: ApiFailure | null; retry?: boolean } = {}): string {
  const read = apiFailure(text)
  const failure = opts.failure ?? read.failure
  // a failure of no known class in Claude Code's own words (a spend limit, say), which say more than a generic head
  const own = text.trim().split('\n', 1)[0].trim()
  if (failure === 'other' && own && !isApiError(own)) return own.length > 300 ? `${own.slice(0, 299).trimEnd()}…` : own
  const status = read.status != null && FAILURE_OF_STATUS[read.status] === failure ? read.status : failure === read.failure ? read.status : null
  const head = status != null && failure !== 'refused' ? `${FAILURE_WORDS[failure]} (${status})` : FAILURE_WORDS[failure]
  const fix = (failure === 'refused' && NEW_SESSION_TEXT.test(text) ? NEW_SESSION_FIX : FAILURE_FIX[failure])?.replace('{then}', opts.retry ? ', then Retry' : '')
  if (!fix) return head
  return FIX_WHERE[failure] === 'terminal' || fix === NEW_SESSION_FIX ? `${head}. ${fix}` : `${head}: ${fix}`
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

/** Rows with each of Claude Code's API error lines as an error row (API_ERROR_KIND) in place of its text row: a row
 * the server marked by its record (`apiError`, with its class) whole, else a line its words show, where one that ends
 * a reply cut short is split off, the error row's index half a step on so each row keeps its own key. Pure. */
export function withApiErrors<T extends { kind: string }>(rows: readonly T[]): (T | ErrorRow)[] {
  return rows.flatMap((r): (T | ErrorRow)[] => {
    const t = r as unknown as TextRow
    if (r.kind !== 'text') return [r]
    if (t.apiError) {
      const failure = failureOf(t.apiError)
      return [{ kind: 'error', index: t.index, message: t.text.trim(), errorKind: API_ERROR_KIND, ...(failure ? { failure } : {}) }]
    }
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
    const at = e.api_error ? 0 : apiErrorAt(e.delta)
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
