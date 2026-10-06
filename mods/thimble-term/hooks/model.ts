// What thimble-term reads from `thimble state`, put in the forms its drawing takes (no `$`): cells, a citation's check,
// a thread's chat as a side thread's turns, the threads list, the agents, the workspace's counts; and the rules for what
// a turn of main made (the cards each tool call names) and what main's reply shows (no end token).
//
// Each reader takes the shape the server's GET route for that surface answers, and is lenient: a field it cannot read
// is left out rather than failing the drawing.
import type { ChatThread, ChatThreadTurn, TermAgent, TermHome, TermThreadRow, TermVerdict } from '../types'
import type { ThimbleCell, ThimbleLabel } from './cell'
import { shownMatches, valueIn } from './lib'
import type { Citation } from './lib'
import { quotedWords, showsValue } from './cite'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : 0)

// ------------------------------------------------------------------------------------------------ cells and labels

/** The cells `thimble state cards --since` printed: the canvas route's `{groups, cells}`, or a list of cells. */
export function cellsOf(v: unknown): ThimbleCell[] {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.cells) ? v.cells : []
  return list.filter((c): c is ThimbleCell => isObj(c) && typeof c.id === 'string')
}

/** The cell `thimble state card <id>` printed: the cell route's cell, or `{cell}`. */
export function cellOf(v: unknown): ThimbleCell | null {
  const c = isObj(v) && isObj(v.cell) ? v.cell : v
  return isObj(c) && typeof c.id === 'string' ? (c as ThimbleCell) : null
}

/** A label with its counts in `label_stats`, where the drawing reads them: the concept routes give them as `counts`
 *  and `n_labeled` beside the concept's fields (concepts.with_stats); the label's stored file holds `label_stats`. */
function withStats(c: Obj): ThimbleLabel {
  if (isObj(c.label_stats) || !isObj(c.counts)) return c as ThimbleLabel
  return { ...c, label_stats: { counts: c.counts as Record<string, number>, ...(typeof c.n_labeled === 'number' ? { n_labeled: c.n_labeled } : {}) } } as ThimbleLabel
}

/** The label `thimble state label <id>` printed: the concept route's concept, or `{concept, rows}`. */
export function labelOf(v: unknown): ThimbleLabel | null {
  if (!isObj(v)) return null
  const c = isObj(v.concept) && typeof v.concept.id === 'string' ? { ...v.concept, ...(Array.isArray(v.rows) ? { rows: v.rows } : {}) } : v
  return typeof c.id === 'string' ? withStats(c) : null
}

/** The labels `thimble state labels` printed: the concepts route's list. */
export function labelsOf(v: unknown): ThimbleLabel[] {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.labels) ? v.labels : isObj(v) && Array.isArray(v.concepts) ? v.concepts : []
  return list.filter((c): c is Obj => isObj(c) && typeof c.id === 'string').map(withStats)
}

/** The label a label card counts: its payload's concept, else the first label it carries. */
export function labelIdOf(cell: ThimbleCell): string {
  const p = cell.payload
  const c = p && typeof p === 'object' ? str((p as Obj).concept) : ''
  return c || (cell.kind === 'label' ? str(cell.labels?.[0]) : '')
}

// ------------------------------------------------------------------------------------------------ main's turn

const CARD_TOOLS = /^mcp__plugin_thimble_thimble__(add_card|edit_card|add_cell|edit_cell)$/
const LABEL_TOOL = /^mcp__plugin_thimble_thimble__apply_label$/
const RUN_RE = /(?:^|[\s/'"])thimble-run['"]?\s+(card|label|stale)\b\s*['"]?([A-Za-z0-9_-]*)/

/** The cards a call of main's names as its own: add_card's and edit_card's card, apply_label's label card, the card a
 *  `thimble-run card <id>` ran (each card a code label's `thimble-run label` made or reran, named in its output). */
export function cardsOfCall(tool: string, input: unknown, text: string): string[] {
  const inp = isObj(input) ? input : {}
  if (CARD_TOOLS.test(tool)) {
    const own = /^card:([A-Za-z0-9_-]+)\s*$/m.exec(text)?.[1] ?? /\bcard:([A-Za-z0-9_-]+)/.exec(text)?.[1]
    const named = str(inp.card).replace(/^(?:card|cell):/, '')
    return [...new Set([own, named].filter((x): x is string => Boolean(x)))].slice(0, 1)
  }
  if (LABEL_TOOL.test(tool)) {
    const card = /The label's card is \[\[card:([A-Za-z0-9_-]+)\]\]/.exec(text)?.[1]
    return card ? [card] : []
  }
  if (tool === 'Bash') {
    const m = RUN_RE.exec(str(inp.command))
    if (!m) return []
    if (m[1] === 'card' && m[2]) return [m[2]]
    const card = /The label's card is \[\[card:([A-Za-z0-9_-]+)\]\]/.exec(text)?.[1]
    return card ? [card] : []
  }
  return []
}

/** main's end token: what it ends a turn with when it has nothing for the analyst, which no chat shows (session.py). */
export const END_TOKEN = '(shown in the dashboard)'
const END_RE = /[ \t]*[*_]*\(shown in the dashboard\)\.?[*_]*\.?\s*$/i

/** A reply block as the analyst reads it: without main's end token. */
export function withoutEnd(text: string): string {
  const m = END_RE.exec(text)
  return m ? text.slice(0, m.index).replace(/\s+$/, '') : text
}

// ------------------------------------------------------------------------------------------------ a citation's check

type Resolution = Obj & { error?: unknown; excerpt?: unknown; meta?: unknown; path?: unknown; line?: unknown; kind?: unknown; record?: unknown; context?: unknown; blocks?: unknown; end_line?: unknown }

/** The resolution of one ref out of what `thimble state resolve` printed: `{ref: resolution}`, a list of resolutions
 *  (each naming its `ref`), or `{refs: …}` around either. */
export function resolutionOf(v: unknown, ref: string): Resolution | null {
  const inner = isObj(v) && (isObj(v.refs) || Array.isArray(v.refs)) ? v.refs : v
  if (Array.isArray(inner)) {
    const hit = inner.find(x => isObj(x) && x.ref === ref)
    return isObj(hit) ? (hit as Resolution) : null
  }
  if (isObj(inner) && isObj(inner[ref])) return inner[ref] as Resolution
  return null
}

function blocksText(b: unknown): string {
  return Array.isArray(b) ? b.map(x => (isObj(x) ? str(x.text) : str(x))).join('\n') : ''
}

function recordText(r: unknown): string {
  if (!isObj(r)) return str(r)
  const blocks = blocksText(r.blocks)
  return blocks || str(r.text) || (isObj(r.record) ? JSON.stringify(r.record) : str(r.record))
}

/** Where the shown value stands in a line: each [start, end) of it. */
function spansIn(line: string, display: string | null): number[][] {
  const words = quotedWords(display) || (display ?? '').trim()
  if (!words) return []
  const out: number[][] = []
  const lower = line.toLowerCase()
  const w = words.toLowerCase()
  for (let i = lower.indexOf(w); i >= 0 && out.length < 4; i = lower.indexOf(w, i + w.length)) out.push([i, i + w.length])
  if (out.length) return out
  // a number written another way (3,908 against 3908): each number of the line that matches it
  for (const m of line.matchAll(/[-−]?\d[\d,]*(?:\.\d+)?%?/g)) if (shownMatches(m[0], words)) out.push([m.index!, m.index! + m[0].length])
  return out.slice(0, 4)
}

/** The lines of a resolved place, the cited ones hit, the records around them not. */
function linesOf(res: Resolution, display: string | null): TermVerdict['lines'] {
  const out: TermVerdict['lines'] = []
  const line = typeof res.line === 'number' ? res.line : 0
  const ctx = isObj(res.context) ? res.context : {}
  const push = (n: number, text: string, hit: boolean) => {
    for (const [k, t] of text.split('\n').entries()) {
      if (k > 30) break
      out.push({ n: k === 0 ? n : 0, text: t, hit, ...(hit ? { spans: spansIn(t, display) } : {}) })
    }
  }
  const before = Array.isArray(ctx.before) ? ctx.before : []
  const after = Array.isArray(ctx.after) ? ctx.after : []
  before.forEach((r, i) => push(isObj(r) && typeof r.line === 'number' ? r.line : line - before.length + i, recordText(r), false))
  if (Array.isArray(res.records) && res.records.length) res.records.forEach((r, i) => push(isObj(r) && typeof r.line === 'number' ? r.line : line + i, recordText(r), true))
  else push(line, line ? blocksText(res.blocks) || str(res.excerpt) : str(res.excerpt), true)
  after.forEach((r, i) => push(isObj(r) && typeof r.line === 'number' ? r.line : line + 1 + i, recordText(r), false))
  return out
}

/** A citation's check from its resolution: missing when the place does not resolve (or a card's cited cell or line is
 *  gone), differs when it resolves and its shown value (a number or quoted words) is not there, else ok. */
export function verdictOf(c: Citation, res: Resolution | null, at = 0): TermVerdict {
  const base = { ref: c.ref, display: c.display, kind: '', lines: [] as TermVerdict['lines'], at }
  if (!res) return { ...base, status: 'pending', why: 'not checked yet' }
  if (res.error !== undefined) return { ...base, status: 'missing', why: `the place does not resolve: ${str(res.error)}` }
  const kind = str(res.kind)
  const meta = isObj(res.meta) ? res.meta : {}
  const span = isObj(meta.span) ? meta.span : null
  const out: TermVerdict = { ...base, kind, status: 'ok', why: 'the place resolves', lines: [] }
  if (kind === 'cell') {
    out.card = str(res.cell_id)
    if (span && 'col' in span) {
      out.column = str(span.col)
      out.row = str(span.row)
      out.value = str(span.value)
    }
    if (meta.span_missing) return { ...out, status: 'missing', why: 'the card no longer shows the cited cell or line' }
  } else {
    out.path = str(res.path)
    if (typeof res.line === 'number') out.line = res.line
    out.lines = linesOf(res, c.display)
  }
  if (!showsValue(c.display)) return { ...out, why: 'the place resolves; the citation shows no value' }
  const where = span && 'value' in span ? str(span.value) : span && 'text' in span ? str(span.text) : kind === 'cell' ? str(res.excerpt) : out.lines.filter(l => l.hit).map(l => l.text).join('\n') || str(res.excerpt)
  const holds = span && 'value' in span ? shownMatches(str(span.value), c.display!) || valueIn(c.display!, where) : valueIn(c.display!, where)
  return holds ? { ...out, why: 'the value is at its place' } : { ...out, status: 'differs', why: span && 'value' in span ? `the place shows ${str(span.value)}` : 'the value is not at its place' }
}

// ------------------------------------------------------------------------------------------------ threads and agents

/** A chat's meta and events as `thimble state thread` printed them (`{meta, events}`). */
export function chatOf(v: unknown): { meta: Obj; events: Obj[] } {
  if (!isObj(v)) return { meta: {}, events: [] }
  return { meta: isObj(v.meta) ? v.meta : {}, events: Array.isArray(v.events) ? v.events.filter(isObj) : [] }
}

/** A chat as a side thread's turns: each analyst message a question, the text after it its answer, its tool calls
 *  counted, closed by `done` (answered) or `error` (failed, or stopped). */
export function threadOf(meta: Obj, events: readonly Obj[]): ChatThread {
  const turns: ChatThreadTurn[] = []
  let cur: ChatThreadTurn | null = null
  const open = (q: string) => {
    cur = { q, a: '', state: 'running', tools: 0, partial: '' }
    turns.push(cur)
  }
  for (const e of events) {
    const t = str(e.type)
    if (t === 'user') {
      open(str(e.text))
      continue
    }
    if (t === 'again' && (!cur || (cur as ChatThreadTurn).state !== 'running')) open(str(e.text))
    if (!cur) open(str(meta.anchor_text) || str(meta.title))
    const c = cur as unknown as ChatThreadTurn
    if (t === 'text') {
      c.a += str(e.delta ?? e.text)
      c.partial = c.a
    } else if (t === 'tool_use') c.tools++
    else if (t === 'done') {
      c.state = 'done'
      if (!c.a.trim() && e.result) c.a = str(e.result)
    } else if (t === 'error') {
      c.state = 'error'
      c.a = str(e.error ?? e.message ?? e.text) || c.a
    }
  }
  const last = turns.at(-1)
  if (last && last.state === 'running' && meta.running === false && last.a.trim()) last.state = 'done'
  const at = Date.parse(str(meta.last_ts) || str(meta.created_at))
  return {
    id: str(meta.id),
    label: str(meta.anchor_text) || str(meta.title) || 'the analyst\'s question',
    ref: str(meta.anchor),
    context: '',
    agentId: '',
    engine: '',
    turns,
    file: '',
    parent: str(meta.parent) === 'main' ? '' : str(meta.parent),
    ...(Number.isFinite(at) ? { at } : {}),
  }
}

/** How many answers a chat has given (`done` records), from its meta's count when the list gives one. */
function answersOf(meta: Obj): number {
  for (const k of ['answers', 'n_answers']) if (typeof meta[k] === 'number') return meta[k] as number
  return meta.status === 'done' ? 1 : 0
}

/** The side threads `thimble state threads` listed (the chats route's metas), oldest first, each with what the rows
 *  above the prompt and the home panel need. Unread: the meta's `unread`, else its answers past `seen`. */
export function threadRowsOf(v: unknown): TermThreadRow[] {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.chats) ? v.chats : isObj(v) && Array.isArray(v.threads) ? v.threads : []
  return list
    .filter(isObj)
    .filter(m => str(m.kind) === 'thread')
    .map(m => {
      const answers = answersOf(m)
      const seen = typeof m.seen === 'number' ? (m.seen as number) : answers
      const unread = typeof m.unread === 'number' ? (m.unread as number) : typeof m.unread === 'boolean' ? (m.unread ? 1 : 0) : Math.max(0, answers - seen)
      return {
        id: str(m.id),
        title: str(m.title),
        anchor: str(m.anchor),
        anchorText: str(m.anchor_text),
        running: Boolean(m.running),
        answers,
        seen,
        unread,
        at: str(m.last_ts) || str(m.created_at),
        parent: str(m.parent),
      }
    })
}

/** thimble's agents as `thimble state agents` listed them (the agents route's `{rows}`). */
export function agentsOf(v: unknown): TermAgent[] {
  const rows = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.rows) ? v.rows : isObj(v) && Array.isArray(v.agents) ? v.agents : []
  return rows.filter(isObj).map(r => ({
    name: str(r.name),
    label: str(r.label) || str(r.name),
    state: str(r.state) || str(r.status),
    kind: str(r.kind),
    chat: str(r.chat),
    role: str(r.role),
    started: str(r.started ?? r.started_at ?? r.created_at),
  }))
}

/** The workspace's counts from `thimble state home`: a number or a list for each kind. */
export function homeOf(v: unknown, at = 0): TermHome | null {
  if (!isObj(v)) return null
  const counts = isObj(v.counts) ? v.counts : v
  const docs = counts.docs ?? counts.reports ?? counts.documents
  return {
    cards: num(counts.cards),
    labels: num(counts.labels),
    docs: isObj(docs) ? Object.values(docs).filter(d => !isObj(d) || d.exists !== false).length : num(docs),
    threads: num(counts.threads),
    views: num(counts.views),
    files: num(counts.files),
    at,
  }
}

/** The documents `thimble state docs` listed (the types route's `{slug: {exists, title, …}}`, or a list), those that
 *  exist or are being written. */
export function docsOf(v: unknown): { slug: string; title: string; renderer: string; status: string }[] {
  const entries: [string, Obj][] = Array.isArray(v) ? v.filter(isObj).map(d => [str(d.slug ?? d.type), d]) : isObj(v) ? Object.entries(v).filter((e): e is [string, Obj] => isObj(e[1])) : []
  return entries
    .filter(([, d]) => d.exists !== false || d.status === 'generating')
    .map(([slug, d]) => ({ slug, title: str(d.title) || str(d.name) || slug, renderer: str(d.renderer) || 'document', status: str(d.status) || (d.exists === false ? 'generating' : 'written') }))
}

/** One ui.jsonl record as `thimble state ui --after <n>` printed it. */
export type UiRecord = { n: number; kind: string; args: Obj }

export function uiRecordsOf(v: unknown): UiRecord[] {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.records) ? v.records : []
  return list.filter(isObj).map(r => ({ n: typeof r.n === 'number' ? r.n : 0, kind: str(r.kind), args: isObj(r.args) ? r.args : {} }))
}

// ------------------------------------------------------------------------------------------------ documents

export type DocSentence = { id?: string; text?: string; bullet?: string }
export type DocFigure = { cell?: string; caption?: string; after_paragraph?: string }
// a unit of a document: a report's or a story's section (paragraphs), a deck's slide or a story's beat (sentences, and
// one `figure` or a list of `figures`), as report_types.units reads them
export type DocSection = { id?: string; heading?: string; paragraphs?: { id?: string; sentences?: DocSentence[] }[]; sentences?: DocSentence[]; figures?: DocFigure[]; figure?: DocFigure | null }
const UNIT_KEYS = [['sections', 'section'], ['slides', 'slide'], ['beats', 'beat'], ['lines', 'line']] as const

/** The document's units (report_types.units) and their word, a slide's sentences as one paragraph each bullet a line. */
export function docUnits(doc: Obj): { units: DocSection[]; word: string } {
  for (const [key, word] of UNIT_KEYS) {
    const v = doc[key]
    if (!Array.isArray(v)) continue
    const units = (v as DocSection[]).filter(u => u && typeof u === 'object').map(u => {
      if (Array.isArray(u.paragraphs)) return { ...u, figures: u.figures ?? (u.figure ? [u.figure] : []) }
      const sentences = (u.sentences ?? []).map(x => ({ ...x, text: x.bullet ? `${x.bullet} ${String(x.text ?? '')}` : String(x.text ?? '') }))
      return { ...u, paragraphs: sentences.length ? [{ id: `${u.id ?? ''}-s`, sentences }] : [], figures: u.figures ?? (u.figure ? [u.figure] : []) }
    })
    return { units, word }
  }
  return { units: [], word: 'section' }
}
