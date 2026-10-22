// The fold of a chat log into rows the panel renders, and the words its tool calls show. `index` is the record's
// position in the log. The records are the server's (backend agent.py and the features): the analyst's message, the
// reply's text as it streams, each tool call and its result, a turn's marks and v cards, a label run, a notice, an error,
// and a view's build ending (a `view` chip).
import type { MarkItem } from '../marks/marks'
import type { StepState, ToolState, ToolStep } from '../components/ToolCard'
import type { ChatRecord, LabelRunState } from '../lib/types'

export interface UserRow {
  kind: 'user'
  index: number
  text: string
  ts?: string
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
}
export interface ToolResult {
  summary: string
  /** when the result came back */
  ts?: string
  is_error?: boolean
  /** the card an apply_label call left, which its result names (backend labels/chat.py) */
  label_card?: string
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
  ts?: string
  result?: ToolResult
}
/** A view's build that ended (backend features/views.py): `ref` is `view:<slug>` */
export interface ViewChipRow {
  kind: 'chip'
  index: number
  text: string
  ref?: string
}
/** A turn that ended on an error (backend agent.py): `errorKind` is `api` for a request that failed, `refusal` for one
 * Claude declined */
export interface ErrorRow {
  kind: 'error'
  index: number
  message: string
  errorKind?: string
}
/** A failure of thimble's own work with what to do (backend features/cards.py notice, agent.py retries) */
export interface NoticeRow {
  kind: 'notice'
  index: number
  text: string
  /** the notice's kind (`retry`, `cards`) */
  noticeKind?: string
}
/** a label run in the chat (backend labels/asks.py): the ask before a model reads many records, then the run; its later
 * records change this row in place */
export interface LabelRunRow extends LabelRunState {
  kind: 'label_run'
  index: number
  ts?: string
}
export type Row = UserRow | TextRow | ToolRow | ViewChipRow | ErrorRow | NoticeRow | LabelRunRow

/**
 * Fold the records of a log into rows: a text record extends the text row right before it, so the words between two
 * calls are one row; a tool result goes to its call's row; a label run's later records change its row. Each turn's
 * marks and v cards go on its text rows (withTurns). Pure.
 */
export function foldRecords(records: readonly ChatRecord[]): Row[] {
  const rows: Row[] = []
  const calls = new Map<string, ToolRow>()
  const labelRuns = new Map<string, LabelRunRow>()
  const marks = new Map<string, MarkItem[]>() // each turn's marks, the newest record of each
  const cards = new Map<string, string[]>() // each turn's v cards
  records.forEach((e, index) => {
    switch (e.type) {
      case 'user':
        rows.push({ kind: 'user', index, text: e.text, ts: e.ts, ...(e.turn ? { turn: e.turn } : {}) })
        return
      case 'text': {
        const last = rows[rows.length - 1]
        if (last?.kind === 'text') last.text += e.delta
        else rows.push({ kind: 'text', index, text: e.delta })
        return
      }
      case 'tool_use': {
        const row: ToolRow = { kind: 'tool', index, id: e.id, name: e.name, input: e.input, ts: e.ts }
        calls.set(e.id, row)
        rows.push(row)
        return
      }
      case 'tool_result': {
        const call = calls.get(e.id)
        if (call) call.result = { summary: e.summary, ts: e.ts, is_error: e.is_error, ...(e.label_card ? { label_card: e.label_card } : {}), ...(e.card ? { card: e.card, version: e.version } : {}) }
        return
      }
      case 'chip':
        if (e.kind === 'view') rows.push({ kind: 'chip', index, text: e.text, ref: e.ref })
        return
      case 'error':
        rows.push({ kind: 'error', index, message: e.message, errorKind: e.kind })
        return
      case 'notice': {
        const text = typeof e.text === 'string' ? e.text.trim() : ''
        if (text) rows.push({ kind: 'notice', index, text, ...(e.kind ? { noticeKind: e.kind } : {}) })
        return
      }
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
      default:
        // `done` draws nothing: the busy line said the turn ran, and the composer's model line shows the model
        return
    }
  })
  withTurns(rows, marks, cards)
  return rows
}

/** Each turn's marks and v cards on its text rows: a turn is the rows after the `user` row that names it, and its texts
 * are its text rows in order, as the server reads them (backend agent.texts_of): a mark of text `piece` goes to that
 * row, at its order `k` among the row's marks. The turn's last text row, its reply, gets the turn's marks for its
 * footer and the cards v drew of it. */
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
    } else if (r.kind === 'text') texts.push(r)
  }
  end()
}

/** What Retry under a chat's last error sends again: the analyst's message that opened the turn the error ended, and
 * the error's record index. Null when the chat went on after the error, and for a request Claude declined, which the
 * same words would meet again (the analyst rephrases it instead). Pure. */
export function retryOf(records: readonly ChatRecord[]): { index: number; text: string } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const e = records[i]
    if (e.type === 'done' || e.type === 'notice' || e.type === 'marks') continue
    if (e.type !== 'error' || e.kind === 'refusal') return null
    for (let j = i - 1; j >= 0; j--) {
      const u = records[j]
      if (u.type === 'user') return u.text.trim() ? { index: i, text: u.text.trim() } : null
    }
    return null
  }
  return null
}

// ---- tool calls

/** The name a card of calls carries for each tool: what the calls did, as a kind of work. A tool not named here shows
 * its own name. */
const TOOL_GROUPS: Readonly<Record<string, string>> = {
  Read: 'Read',
  Grep: 'Read',
  Glob: 'Read',
  run_python: 'Run Python',
  card: 'Draw card',
  apply_label: 'Label',
  show_label: 'Label',
  delete_label: 'Label',
  set_filter: 'Filter',
  clear_filter: 'Filter',
  read_document: 'Report',
  write_document: 'Report',
  edit_document: 'Report',
  propose_view: 'Views proposed',
  write_view_file: 'View build',
  view_check: 'View build',
  finish_view: 'View build',
  draft_report: 'Report a problem',
  fix_start: 'Fix',
  fix_files: 'Fix',
  fix_read: 'Fix',
  fix_edit: 'Fix',
  fix_test: 'Fix',
  fix_use: 'Fix',
  fix_undo: 'Fix',
}

export const toolGroupName = (name: string): string => TOOL_GROUPS[name] ?? name

const str = (v: unknown): string => (v == null ? '' : String(v))
const oneLine = (s: string, max = 110): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** A call's target with the folder's absolute path left off (`/…/<ws>/notes.jsonl` is `notes.jsonl`); the folder itself
 * is `.`. Pure. */
export function underCorpus(text: string, ws: string): string {
  if (!ws) return text
  const name = ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // the folder itself first, so a path through a folder of the same name further up is not cut there
  return text.replace(new RegExp(`(?<!\\S)/\\S*/${name}(?=\\s|$)`, 'g'), '.').replace(new RegExp(`(?<!\\S)/\\S*/${name}/`, 'g'), '')
}

/** One line for what a call was about: the file it read, the search, the first line of its code, the card's title, the
 * label, the document; for another tool, the first text field of its input. Paths under the folder of workspace `ws`
 * are made relative. Pure. */
export function toolSummary(name: string, input: unknown, ws = ''): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const line = (() => {
    switch (name) {
      case 'Read':
        return str(inp.file_path)
      case 'Grep':
      case 'Glob':
        return [str(inp.pattern), inp.path ? `in ${str(inp.path)}` : ''].filter(Boolean).join(' ')
      case 'run_python':
        return str(inp.code).split('\n').find((l) => l.trim() !== '') ?? ''
      case 'card':
      case 'draft_report':
      case 'fix_start':
        return str(inp.title)
      case 'apply_label':
        return [str(inp.name), inp.scope ? `on ${str(inp.scope)}` : ''].filter(Boolean).join(' ')
      case 'show_label':
        return [str(inp.name), inp.on === false ? 'off' : 'on'].join(' ')
      case 'set_filter':
        return [str(inp.scope), inp.label ? `${str(inp.label)}${inp.value ? ` = ${str(inp.value)}` : ''}` : '', inp.text ? `"${str(inp.text)}"` : ''].filter(Boolean).join(' · ')
      case 'clear_filter':
        return str(inp.scope)
      case 'read_document':
      case 'write_document':
      case 'edit_document':
        return str(inp.doc)
      case 'fix_read':
      case 'fix_edit':
      case 'fix_test':
        return str(inp.path)
      default: {
        const key = Object.keys(inp).find((k) => typeof inp[k] === 'string' && str(inp[k]).trim() !== '')
        return key ? str(inp[key]) : ''
      }
    }
  })()
  return oneLine(underCorpus(line, ws))
}

/** The tools whose calls the chat prints as one line each, as Claude Code prints a tool line: reading a file, searching
 * the files. Two or more in a row fold into one chip. */
const RAW_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])

export const isRawCall = (name: string): boolean => RAW_TOOLS.has(name)

export interface ToolGroup {
  kind: 'tools'
  /** the log index of the group's first call */
  index: number
  name: string
  tools: ToolRow[]
}

/** The rows with every run of consecutive tool calls of one kind folded into one group, which renders as one tool-call
 * card. Pure. */
export function groupTools<R extends { kind: string }>(rows: readonly (R | ToolRow)[]): (Exclude<R, ToolRow> | ToolGroup)[] {
  const out: (Exclude<R, ToolRow> | ToolGroup)[] = []
  for (const r of rows) {
    if (r.kind !== 'tool') {
      out.push(r as Exclude<R, ToolRow>)
      continue
    }
    const t = r as ToolRow
    const name = toolGroupName(t.name)
    const last = out[out.length - 1]
    if (last && last.kind === 'tools' && (last as ToolGroup).name === name) (last as ToolGroup).tools.push(t)
    else out.push({ kind: 'tools', index: t.index, name, tools: [t] })
  }
  return out
}

/** A piece of a run of calls as the transcript shows it: two or more raw calls in a row fold into one chip (`run`); a
 * call alone is a line of its own. */
export type CallPiece = { kind: 'run'; tools: ToolRow[] } | { kind: 'line'; tool: ToolRow }

/** The pieces of a run of calls (CallPiece), in order. Pure. */
export function callPieces(tools: readonly ToolRow[]): CallPiece[] {
  const out: CallPiece[] = []
  let run: ToolRow[] = []
  const flush = () => {
    if (run.length > 1) out.push({ kind: 'run', tools: run })
    else if (run.length === 1) out.push({ kind: 'line', tool: run[0] })
    run = []
  }
  for (const t of tools) {
    if (isRawCall(t.name)) {
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
const RUN_TOOLS_SHOWN = 3

/** A folded run's chip in words: each tool and its call count (Grep 2 · Read 1), most used first, ties in first-use
 * order; past RUN_TOOLS_SHOWN tools, the rest as a count (`more`). Pure. */
export function runTools(tools: readonly ToolRow[]): { tools: { name: string; n: number }[]; more: number } {
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
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

/** A card's meta: the number of steps and, once they are done, how long they took (1 step · 12s). Pure. */
export function toolMeta(tools: readonly ToolRow[]): string {
  const n = tools.length
  const first = tools[0]?.ts
  const last = tools[n - 1]?.result?.ts
  const ms = first && last ? Date.parse(last) - Date.parse(first) : NaN
  return `${n} ${n === 1 ? 'step' : 'steps'}${Number.isFinite(ms) && ms >= 0 ? ` · ${Math.round(ms / 1000)}s` : ''}`
}

/** A card's steps: each call as its tool and what it was about (card · Agents per run), with its state. */
export function toolSteps(tools: readonly ToolRow[], pending: boolean): ToolStep[] {
  return tools.map((t) => {
    const summary = toolSummary(t.name, t.input)
    const state: StepState = t.result ? (t.result.is_error ? 'failed' : 'done') : pending ? 'running' : 'pending'
    return { key: t.id, text: summary ? `${t.name} · ${summary}` : t.name, state }
  })
}

/** The card's right edge: running while a call waits on a live reply, failed when any call failed, ✓ once every call
 * came back; nothing for a call that never did. */
export function groupState(tools: readonly ToolRow[], pending: boolean): ToolState | null {
  if (pending && tools.some((t) => !t.result)) return 'running'
  if (tools.some((t) => t.result?.is_error)) return 'failed'
  return tools.every((t) => t.result) ? 'done' : null
}

/** What calls made that the chat shows as chips: the views proposed (with each slug its result names, which its
 * ViewChip is keyed by) and the labels applied, once each. Pure. */
export function madeBy(tools: readonly ToolRow[]): { views: string[]; viewSlugs: Record<string, string>; labels: string[] } {
  const out = { views: [] as string[], viewSlugs: {} as Record<string, string>, labels: [] as string[] }
  for (const t of tools) {
    if (!t.result || t.result.is_error) continue
    const inp = (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>
    const name = str(inp.name).trim()
    if (!name) continue
    if (t.name === 'propose_view' && !out.views.includes(name)) {
      out.views.push(name)
      // the slug its result names (`Proposed the view Inbox (view:inbox) …`)
      const slug = /\(view:([a-z0-9][a-z0-9-]{0,39})\)/.exec(t.result.summary)?.[1]
      if (slug) out.viewSlugs[name] = slug
    }
    // a trial on a few units (`limit`) is no label until a call runs it on everything (backend labels/chat.py)
    if (t.name === 'apply_label' && (inp.limit == null || inp.limit === '') && !out.labels.includes(name)) out.labels.push(name)
  }
  return out
}

// ---- threads

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
