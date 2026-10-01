// The Transcript view, for any file the server's sniff (backend transcripts.py) reads as close to a transcript: a
// Claude Code stream as cards by record, the system records behind a toggle (a stream each record nests under one key,
// as the Agent SDK's messages kept in a database row, shows the nested records); messages (JSON lines, a CSV or TSV file's
// rows) as posts with their authors and times; JSON lines that each hold a whole conversation as one card per line,
// its turns inside; a text or markdown chat log as one card per turn, a turn's lines under its speaker; and a
// whole-file JSON transcript (a chat export, an eval log) as the turns the server parses from it, a page at a time.
// JSON lines in a file the server pages as text are parsed here, line by line. While system records are hidden, a long
// run of them (HIDDEN_RUN_NOTE or more) says in one line how many it hides, so the view is never blank while the reader
// pages past them. A record with no words to show (a turn that holds only redacted thinking, a post with an empty body)
// gets no row, unless a citation points at it; Raw shows every line.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Spinner } from '../../components/Spinner'
import { api } from '../../lib/api'
import type { Block, ChatTurn, SourceKind, SourceRecord, SourceTurn, SourceTurns, TranscriptHint } from '../../lib/types'
import { BlockEl, Collapsible, compact, errMsg, lineCount, RecordCard, recordExcerpt, targetOf, useTarget, type Target, type ViewDef, type ViewProps } from './common'
import { useDelimited } from './table'

export const CONVERSATIONAL = new Set(['assistant', 'user'])
/** hidden system records in a row from which the run says how many it hides */
export const HIDDEN_RUN_NOTE = 20
const STREAM_TYPES = new Set(['assistant', 'user', 'system', 'tool_progress', 'result'])
// The keys that name a record's author on their own (a post's author, a chat turn's role)
const STRONG_AUTHOR_KEYS = ['author', 'role', 'sender', 'from', 'speaker', 'user']
// and the ones that name it only in a record that also has a time: a revision's editor (`label` in a wiki's revision
// log), a user name; without a time, a record with a `name` and a `body` is as likely a page as a post
const WEAK_AUTHOR_KEYS = ['editor', 'user_name', 'label', 'name']
export const AUTHOR_KEYS = [...STRONG_AUTHOR_KEYS, ...WEAK_AUTHOR_KEYS]
export const BODY_KEYS = ['body', 'content', 'text', 'message', 'tool_result', 'change_summary']
const MATCH_BODY_KEYS = ['body', 'content', 'text', 'message']
export const TIME_KEYS = ['created_at', 'ts', 'timestamp', 'time', 'date']
export const CONTEXT_KEYS = ['thread_title', 'thread', 'title', 'subject', 'channel']

/** A record's time as the reader's head shows it: `YYYY-MM-DD HH:MM` for an ISO stamp, else as written. */
export function stamp(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(ts)
  return m ? `${m[1]} ${m[2]}` : ts
}

export const hasAny = (r: any, keys: string[]) => keys.some((k) => r?.[k] != null && r[k] !== '')
const isStreamRec = (r: any) => !!r && typeof r === 'object' && (STREAM_TYPES.has(r.type) || (r.message && typeof r.message === 'object') || typeof r.session_id === 'string')

function sysSummary(rec: any): string {
  const parts: string[] = [rec?.type, rec?.subtype, rec?.tool_name].filter(Boolean)
  if (rec?.type === 'tool_progress' && rec.elapsed_time_seconds != null) parts.push(`${rec.elapsed_time_seconds}s`)
  if (rec?.type === 'result') {
    if (typeof rec.result === 'string') parts.push(rec.result.slice(0, 160))
    if (rec.num_turns != null) parts.push(`${rec.num_turns} turns`)
  }
  return parts.join(' · ') || 'record'
}

function ToolResult({ block, path, line, index, target, hit, isError }: { block: Block; path?: string; line: number; index: number; target: Target | null; hit: boolean; isError: boolean }) {
  const forced = !!target && target.line === line && target.block === index
  return (
    <Collapsible lines={lineCount(block.text)} forced={forced}>
      <BlockEl block={block} path={path} line={line} index={index} target={target} hit={hit} className={isError ? 'reader-error' : undefined} />
    </Collapsible>
  )
}

function SysRow({ path, blockPath, rec, target, hit }: { path: string; blockPath?: string; rec: SourceRecord; target: Target | null; hit: boolean }) {
  const [open, setOpen] = useState(false)
  const forced = !!target && target.line === rec.line && target.block != null
  return (
    <RecordCard path={path} line={rec.line} target={target} hit={hit} className="reader-sysrow" header="system" text={sysSummary(rec.record)}>
      <Button size="sm" className="reader-sys-summary mono" aria-expanded={open || forced} onClick={() => setOpen((o) => !o)}>
        {sysSummary(rec.record)}
      </Button>
      {(open || forced) && rec.blocks.map((b, k) => <BlockEl key={k} block={b} path={blockPath} line={rec.line} index={k} target={blockPath ? target : null} hit={hit} />)}
    </RecordCard>
  )
}

/** A run of hidden system records, in one line: how many, and Show, which shows every system record. */
function HiddenRun({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <div className="reader-hidden-run">
      <span>
        {count.toLocaleString()} system {count === 1 ? 'record' : 'records'} hidden
      </span>
      <Button size="sm" onClick={onShow}>
        Show
      </Button>
    </div>
  )
}

/** Where the loaded records' runs of hidden system records stand: per run, the line it starts at and its length, for
 * the runs that get a line of their own (HIDDEN_RUN_NOTE or longer, or any run when no record is shown). Pure. */
export function hiddenRuns(types: readonly (string | undefined)[], lines: readonly number[]): Map<number, number> {
  const runs: [number, number][] = []
  let start = -1
  types.forEach((t, i) => {
    const hidden = !CONVERSATIONAL.has(t ?? 'record')
    if (hidden && start < 0) start = i
    if (!hidden && start >= 0) {
      runs.push([start, i - start])
      start = -1
    }
  })
  if (start >= 0) runs.push([start, types.length - start])
  const shown = types.some((t) => CONVERSATIONAL.has(t ?? 'record'))
  return new Map(runs.filter(([, n]) => n >= HIDDEN_RUN_NOTE || !shown).map(([i, n]) => [lines[i], n]))
}

function errorBlockIndexes(rec: any): Set<number> {
  const out = new Set<number>()
  const content = rec?.message?.content
  if (!Array.isArray(content)) return out
  let k = 0
  for (const c of content) {
    if (c?.type === 'thinking' && !c.thinking) continue
    if (c?.type === 'tool_result' && c.is_error) out.add(k)
    k++
  }
  return out
}

/** Whether a record's blocks hold any words to show. Pure. */
export function hasWords(blocks: readonly Block[]): boolean {
  return blocks.some((b) => b.text.trim() !== '')
}

export function Transcript(props: ViewProps) {
  const hint = props.transcript
  if (hint?.format === 'json') return <TurnsTranscript {...props} />
  if (hint?.format === 'conversations') return <Conversations {...props} />
  if (hint?.lines) return <MessageBoard {...props} />
  if (hint?.format === 'stream' || props.page.records.some((rec) => isStreamRec(rec.record))) return <StreamTranscript {...props} />
  if (hint?.format === 'text') return <ChatLog {...props} />
  if (hint?.format === 'csv') return <DelimitedTranscript {...props} />
  return <MessageBoard {...props} />
}

/** The key of each part of a post, chosen once for the file: the first key of each list that a record carries, so a
 * post whose author is empty (an unsigned revision) does not take its author from another field. */
export interface MessageKeys {
  author?: string
  time?: string
  body?: string
  context?: string
}

export function messageKeys(objs: unknown[]): MessageKeys {
  const first = (keys: string[]) => keys.find((k) => objs.some((r) => !!r && typeof r === 'object' && (r as any)[k] != null && (r as any)[k] !== ''))
  return { author: first(AUTHOR_KEYS), time: first(TIME_KEYS), body: first(BODY_KEYS), context: first(CONTEXT_KEYS) }
}

const present = (v: unknown) => v != null && v !== ''

/** The keys the server's sniff named for a message, else those messageKeys finds in the records; the context (a
 * thread's title) is always messageKeys'. */
function keysFor(hint: TranscriptHint | null | undefined, objs: unknown[]): MessageKeys {
  const found = messageKeys(objs)
  const k = hint?.keys
  return k ? { author: k.speaker, time: k.time ?? found.time, body: k.text, context: found.context } : found
}

/** A record's value at a key, dotted for a nested one (`message.author`); for `a|b`, the first of the keys that holds a
 * value (the sniff names who speaks so where records keep it under different keys). */
export function pick(r: unknown, key: string | undefined): unknown {
  if (!key) return undefined
  if (key.includes('|')) {
    for (const alt of key.split('|')) {
      const v = pick(r, alt)
      if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) return v
    }
    return undefined
  }
  let v: unknown = r
  for (const part of key.split('.')) {
    if (!v || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[part]
  }
  return v
}

/** the keys of a person object that hold a name in any case style (`displayName`, `full_name`), as the server's sniff
 * reads them (backend transcripts.NAME_NORMS) */
const NAME_NORMS = new Set(['name', 'displayname', 'username', 'realname', 'fullname', 'nickname', 'nick', 'handle', 'login'])

/** Who a speaker value names: a string, or a person object's name (its name keys, then its role or id). */
export function nameOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    const named = Object.entries(o).filter(([k]) => NAME_NORMS.has(k.toLowerCase().replace(/[^a-z0-9]/g, ''))).map(([k]) => k)
    for (const k of ['name', 'display_name', 'username', 'real_name', ...named, 'role', 'id']) {
      const got = nameOf(o[k])
      if (got) return got
    }
  }
  return null
}

/** The words a text value holds: a string, the text parts of a list, an object's own text or parts. */
export function textOf(v: unknown, depth = 0): string | null {
  if (typeof v === 'string') return v
  if (depth > 3 || v == null) return null
  if (Array.isArray(v)) {
    const parts = v.map((x) => textOf(x, depth + 1)).filter((t): t is string => !!t)
    return parts.length ? parts.join('\n\n') : null
  }
  if (typeof v === 'object') {
    for (const k of ['text', 'parts', 'content', 'value', 'thinking']) {
      const got = textOf((v as Record<string, unknown>)[k], depth + 1)
      if (got != null) return got
    }
  }
  return null
}

/** A time value as the head writes it: an ISO stamp as stamp() does, seconds or milliseconds since 1970 in UTC, any
 * other number as written. */
export function timeOf(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{9,13}(\.\d+)?$/.test(v.trim())) v = Number(v)
  if (typeof v === 'number' && v >= 1e8) {
    const d = new Date(v > 1e11 ? v : v * 1000)
    return Number.isNaN(d.getTime()) ? null : stamp(d.toISOString())
  }
  if (typeof v === 'number') return String(v)
  return typeof v === 'string' && v.trim() ? stamp(v.trim()) : null
}

/** A JSON line's record parsed from its text, for a file the server pages as text; any other record as it is. Pure. */
export function parsedLines(records: SourceRecord[]): SourceRecord[] {
  return records.map((rec) => {
    const text = rec.record?.text
    if (typeof text !== 'string' || !text.trim().startsWith('{')) return rec
    try {
      const v = JSON.parse(text)
      return v && typeof v === 'object' && !Array.isArray(v) ? { ...rec, record: v, blocks: [] } : rec
    } catch {
      return rec
    }
  })
}

function MessageBoard({ path, page, targetRef, transcript }: ViewProps) {
  const lines = !!transcript?.lines
  const records = useMemo(() => (lines ? parsedLines(page.records) : page.records), [lines, page.records])
  return <Posts path={path} records={records} targetRef={targetRef} hint={transcript} derived={lines} />
}

/** A CSV or TSV file's rows as posts, under the columns the sniff named. The words are the row's cell, so a span label
 * of the file's line does not mark them. */
function DelimitedTranscript({ workspace, path, page, targetRef, transcript }: ViewProps) {
  const rows = useDelimited(workspace, path, page.records)
  return <Posts path={path} records={rows} targetRef={targetRef} hint={transcript} derived />
}

/** characters of one field a post with no words shows */
const FIELD_MAX = 300

/** The other fields of a record that holds no words (an agent's action among a village's talk): those of the record
 * that would hold them, but for who speaks and the time, each value as a line, nested ones compacted. Pure. */
export function restFields(r: unknown, keys: MessageKeys): [string, string][] {
  const dot = keys.body?.lastIndexOf('.') ?? -1
  const prefix = dot > 0 ? keys.body!.slice(0, dot) : ''
  const box = prefix ? pick(r, prefix) : r
  if (!box || typeof box !== 'object' || Array.isArray(box)) return []
  const own = (k: string) => (prefix && k.startsWith(`${prefix}.`) ? k.slice(prefix.length + 1) : k)
  const skip = new Set([...(keys.author ?? '').split('|'), keys.time ?? ''].map(own))
  return Object.entries(box as Record<string, unknown>)
    .filter(([k, v]) => !skip.has(k) && v != null && v !== '')
    .map(([k, v]) => [k, typeof v === 'string' ? (v.length > FIELD_MAX ? `${v.slice(0, FIELD_MAX)}…` : v) : compact(v, FIELD_MAX)])
}

/** Records as posts: author, context and time in the head, the body under it. A body the server's blocks hold is shown
 * as those blocks (span labels mark them); a body only the record holds (`derived`, or blocks that are the raw record)
 * as its text; a record with no body, whose blocks are the raw record, as its other fields on one line. */
function Posts({ path, records, targetRef, hint, derived }: { path: string; records: SourceRecord[]; targetRef?: string; hint?: TranscriptHint | null; derived?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  const keys = useMemo(() => keysFor(hint, records.slice(0, 20).map((r) => r.record)), [hint, records])
  const asked = targetOf(targetRef, path)?.line
  return (
    <div className="reader-transcript reader-msgboard" ref={rootRef}>
      {records.map((rec) => {
        const r = rec.record ?? {}
        const author = nameOf(pick(r, keys.author)) ?? '(unsigned)'
        const ts = timeOf(pick(r, keys.time))
        const ctx = keys.context ? r[keys.context] : undefined
        const value = pick(r, keys.body)
        const body = textOf(value)
        const header = [author, present(ctx) && typeof ctx !== 'object' ? String(ctx) : null, ts].filter(Boolean).join(' · ')
        // an empty body leaves the server a raw block of the whole record: the post has no row, or, when a citation
        // points at it, says it is empty
        const empty = typeof body === 'string' && !body.trim()
        if (empty && rec.line !== asked) return null
        const fields = value == null && rec.blocks.every((b) => b.kind === 'raw') ? restFields(r, keys) : null
        const own = !derived && rec.blocks.length > 0 && !rec.blocks.every((b) => b.kind === 'raw' && body != null)
        return (
          <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-msg" header={header} text={empty ? undefined : own ? recordExcerpt(rec) : body?.slice(0, 500)}>
            {empty ? (
              <div className="reader-msg-empty">(empty body)</div>
            ) : fields?.length ? (
              <div className="reader-msg-fields">
                {fields.map(([k, v]) => (
                  <span key={k}>
                    <span className="reader-msg-field mono">{k}</span> {v}
                  </span>
                ))}
              </div>
            ) : own ? (
              rec.blocks.map((b, k) => <BlockEl key={k} block={b} path={path} line={rec.line} index={k} target={target} hit={hit} />)
            ) : (
              <BlockEl block={{ kind: 'text', text: body ?? JSON.stringify(value ?? r) }} line={rec.line} index={0} target={target} hit={hit} />
            )}
          </RecordCard>
        )
      })}
    </div>
  )
}

/** A text chat log's records as turns: each record whose line starts a turn (the server's `meta.turn`) opens one, and
 * the lines after it up to the next go on it. Lines before the first turn are one turn with no speaker. Pure. */
export function chatTurns(records: readonly SourceRecord[]): { line: number; end: number; turn: ChatTurn | null; recs: SourceRecord[] }[] {
  const out: { line: number; end: number; turn: ChatTurn | null; recs: SourceRecord[] }[] = []
  for (const rec of records) {
    const turn: ChatTurn | undefined = rec.meta?.turn
    const cur = out[out.length - 1]
    if (turn || !cur) out.push({ line: rec.line, end: rec.line, turn: turn ?? null, recs: [rec] })
    else {
      cur.recs.push(rec)
      cur.end = rec.line
    }
  }
  return out
}

/** A text or markdown chat log as one card per turn: the speaker and time in the head, the turn's lines under it, the
 * first from where its words start. Each line keeps its own record, so a span label or a citation of a line inside a
 * turn marks it there, and the card's gutter shows the labels of every line of the turn. */
function ChatLog({ path, page, targetRef }: ViewProps) {
  const records = page.records
  const turns = useMemo(() => chatTurns(records), [records])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const asked = useMemo(() => targetOf(targetRef, path), [targetRef, path])
  // a citation of a line inside a turn scrolls to and flashes the turn, and marks its span on that line
  const holder = asked ? turns.find((t) => asked.line >= t.line && asked.line <= t.end) : undefined
  const cardRef = holder && holder.line !== asked!.line ? `${path}#L${holder.line}` : targetRef
  const { target, hit } = useTarget(cardRef, path, rootRef, [records])
  return (
    <div className="reader-transcript reader-chatlog" ref={rootRef}>
      {turns.map(({ line, end, turn, recs }) => {
        const header = turn ? [turn.speaker, turn.time ? stamp(turn.time) : null].filter(Boolean).join(' · ') : undefined
        const lines = shownLines(recs, turn)
        const text = lines.map((r, i) => (i === 0 && turn ? lineText(r).slice(turn.at) : lineText(r))).join('\n').trim()
        return (
          <RecordCard key={line} path={path} line={line} end={end} target={target} hit={hit} className={turn ? 'reader-msg' : 'reader-msg reader-chat-lead'} header={header} text={text.slice(0, 500)}>
            {lines.map((r, i) =>
              r.blocks.length ? (
                r.blocks.map((b, k) => <BlockEl key={`${r.line}.${k}`} block={b} path={path} line={r.line} index={k} target={asked} hit={hit} from={i === 0 && turn && k === 0 ? turn.at : 0} className={i === 0 && turn && turn.at >= b.text.length ? 'reader-chat-empty' : undefined} />)
              ) : null,
            )}
          </RecordCard>
        )
      })}
    </div>
  )
}

const lineText = (r: SourceRecord): string => (typeof r.record?.text === 'string' ? r.record.text : '')

/** The records a turn shows: without the blank lines at its end, nor those right after a speaker's line that holds
 * no words (a `## Human` heading). The first is always kept. Pure. */
export function shownLines(recs: SourceRecord[], turn: ChatTurn | null): SourceRecord[] {
  let n = recs.length
  while (n > 1 && !lineText(recs[n - 1]).trim()) n--
  const out = recs.slice(0, n)
  if (!turn || lineText(out[0]).slice(turn.at).trim()) return out
  let k = 1
  while (k < out.length && !lineText(out[k]).trim()) k++
  return [out[0], ...out.slice(k)]
}

/** The turns of a record that holds a whole conversation, where the sniff found them: its list of messages
 * (`keys.list`), or a prompt and its response (`pair`); null when the record keeps none there. Pure. */
export function conversationTurns(r: unknown, hint: TranscriptHint | null | undefined): { speaker: string; text: string; time: string | null }[] | null {
  if (hint?.pair) {
    const [a, b] = hint.pair
    const pa = pick(r, a)
    const pb = pick(r, b)
    return typeof pa === 'string' && typeof pb === 'string'
      ? [
          { speaker: a, text: pa, time: null },
          { speaker: b, text: pb, time: null },
        ]
      : null
  }
  const k = hint?.keys
  const list = k?.list ? pick(r, k.list) : undefined
  if (!k || !Array.isArray(list)) return null
  return list.map((m) => ({ speaker: nameOf(pick(m, k.speaker)) ?? '', text: textOf(pick(m, k.text)) ?? '', time: timeOf(pick(m, k.time)) }))
}

/** characters of one turn's words a conversation shows; Raw shows the rest */
const TURN_TEXT_MAX = 20_000

/** JSON lines that each hold a whole conversation (a fine-tuning set, ShareGPT, prompt and response pairs) as one card
 * per line: its title in the head, then each turn's speaker over its words. A label or a citation of the line marks the
 * card. The words are the parsed text, which span labels do not mark. */
function Conversations({ path, page, targetRef, transcript }: ViewProps) {
  const lines = !!transcript?.lines
  const records = useMemo(() => (lines ? parsedLines(page.records) : page.records), [lines, page.records])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  return (
    <div className="reader-transcript reader-convs" ref={rootRef}>
      {records.map((rec) => {
        const r = rec.record ?? {}
        const turns = conversationTurns(r, transcript)
        const ctx = CONTEXT_KEYS.map((key) => r[key]).find((v) => present(v) && typeof v !== 'object')
        const first = turns?.find((t) => t.text.trim())?.text ?? ''
        return (
          <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-msg reader-conv" header={ctx != null ? String(ctx) : undefined} text={first.slice(0, 500) || undefined}>
            {turns ? (
              turns.map((t, k) => (
                <div key={k} className="reader-conv-turn">
                  <div className="reader-conv-speaker mono">{[t.speaker, t.time].filter(Boolean).join(' · ') || '(unsigned)'}</div>
                  {t.text.trim() ? <BlockEl block={{ kind: 'text', text: t.text.slice(0, TURN_TEXT_MAX) }} line={rec.line} index={k} target={null} hit={false} /> : <div className="reader-msg-empty">(empty)</div>}
                  {t.text.length > TURN_TEXT_MAX && <div className="reader-msg-empty">Cut at {TURN_TEXT_MAX.toLocaleString()} of {t.text.length.toLocaleString()} characters. Raw shows all of it.</div>}
                </div>
              ))
            ) : (
              <BlockEl block={{ kind: 'text', text: typeof r.text === 'string' ? r.text : JSON.stringify(r) }} line={rec.line} index={0} target={null} hit={false} />
            )}
          </RecordCard>
        )
      })}
    </div>
  )
}

const TURNS_PAGE = 200
/** turns kept in memory; past it, the ones at the far end from the reader's move are let go */
const TURNS_CAP = 2000

/** A whole-file JSON transcript (a chat export, an eval log) as the turns the server parses from it (GET
 * /source/turns): a page at a time from the start, or
 * around a cited line, more as the reader nears either end, up to TURNS_CAP at a time. Each turn stands on the line of
 * the file that holds its words, so a label or a citation of that line finds it; the words are the parsed text, which
 * span labels do not mark. */
function TurnsTranscript({ workspace, path, targetRef }: ViewProps) {
  const asked = useMemo(() => targetOf(targetRef, path), [targetRef, path])
  const [data, setData] = useState<SourceTurns | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loading = useRef(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const askedLine = asked?.line
  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    api
      .sourceTurns(workspace, path, 0, TURNS_PAGE, askedLine)
      .then((p) => alive && setData(p))
      .catch((e) => alive && setError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [workspace, path, askedLine])
  const more = useCallback(
    (dir: 'earlier' | 'later') => {
      if (!data || loading.current) return
      const end = data.start + data.turns.length
      if (dir === 'earlier' ? data.start <= 0 : end >= data.total) return
      loading.current = true
      const from = dir === 'earlier' ? Math.max(0, data.start - TURNS_PAGE) : end
      api
        .sourceTurns(workspace, path, from, dir === 'earlier' ? data.start - from : TURNS_PAGE)
        .then((p) =>
          setData((cur) => {
            if (!cur) return p
            const groups = { ...cur.groups, ...p.groups }
            if (dir === 'earlier') return { ...p, groups, turns: [...p.turns, ...cur.turns].slice(0, TURNS_CAP) }
            const turns = [...cur.turns, ...p.turns]
            const drop = Math.max(0, turns.length - TURNS_CAP)
            return { ...cur, groups, total: p.total, start: cur.start + drop, turns: turns.slice(drop) }
          }),
        )
        .catch((e) => setError(errMsg(e)))
        .finally(() => {
          loading.current = false
        })
    },
    [data, workspace, path],
  )
  const tail = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = tail.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more('later'), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more])
  const turns = data?.turns ?? []
  // a citation of a line scrolls to the turn standing on it, or the last before it
  const holder = asked ? turns.reduce<SourceTurn | null>((best, t) => (t.line <= asked.line ? t : best), null) : null
  const { target, hit } = useTarget(holder ? `${path}#L${holder.line}` : undefined, path, rootRef, [data])
  if (error) return <div className="reader-error-text">{error}</div>
  if (!data)
    return (
      <div className="reader-more">
        <Spinner size={14} label="Loading" />
      </div>
    )
  const titled = data.n_groups > 1 || Object.values(data.groups).some((g) => g.title)
  const out: ReactNode[] = []
  turns.forEach((t, k) => {
    if (!t.text.trim() && holder?.i !== t.i) return
    const g = t.group != null ? data.groups[String(t.group)] : undefined
    if (titled && g && (k === 0 || turns[k - 1].group !== t.group))
      out.push(
        <div key={`g${t.i}`} className="reader-session">
          <span>{g.title || `Conversation ${t.group! + 1}`}</span>
        </div>,
      )
    out.push(<TurnCard key={t.i} path={path} turn={t} end={Math.max(t.line, (turns[k + 1]?.line ?? t.line) - 1)} target={holder?.i === t.i ? target : null} hit={hit} />)
  })
  return (
    <div className="reader-transcript reader-turns" ref={rootRef}>
      {data.start > 0 && (
        <div className="reader-viewbar reader-turns-earlier">
          <Button size="sm" onClick={() => more('earlier')}>
            Earlier turns
          </Button>
        </div>
      )}
      {out}
      <div ref={tail} className="reader-turns-tail" aria-hidden />
    </div>
  )
}

/** One turn of a whole-file JSON transcript, whose gutter shows the labels of its line and of the lines up to the next
 * turn's (`end`). */
function TurnCard({ path, turn, end, target, hit }: { path: string; turn: SourceTurn; end: number; target: Target | null; hit: boolean }) {
  const header = [turn.speaker || turn.role, turn.time ? timeOf(turn.time) : null].filter(Boolean).join(' · ')
  const block: Block = { kind: 'text', text: turn.text }
  return (
    <RecordCard path={path} line={turn.line} end={end} target={target} hit={hit} className={`reader-msg reader-turn-${turn.role}`} header={header} text={turn.text.slice(0, 500)}>
      {turn.text.trim() ? <BlockEl block={block} line={turn.line} index={0} target={null} hit={false} /> : <div className="reader-msg-empty">(empty)</div>}
      {turn.cut != null && <div className="reader-msg-empty">Cut at {turn.text.length.toLocaleString()} of {turn.cut.toLocaleString()} characters. Raw shows all of it.</div>}
    </RecordCard>
  )
}

/** A Claude Code stream record's blocks as the server makes them for one that is not nested (refs.record_blocks). */
export function streamBlocks(r: any): Block[] {
  const content = r?.message?.content
  if ((r?.type === 'assistant' || r?.type === 'user') && typeof content === 'string') return [{ kind: 'text', text: content }]
  if ((r?.type === 'assistant' || r?.type === 'user') && Array.isArray(content)) return content.map(contentBlock).filter((b): b is Block => b != null)
  return [rawBlock(r)]
}

const asText = (x: unknown): string => (x == null ? '' : typeof x === 'string' ? x : JSON.stringify(x))
const rawBlock = (x: unknown): Block => ({ kind: 'raw', text: JSON.stringify(x, null, 2) ?? '' })

function contentBlock(b: any): Block | null {
  if (!b || typeof b !== 'object') return rawBlock(b)
  if (b.type === 'text') return { kind: 'text', text: asText(b.text) }
  if (b.type === 'tool_use') return { kind: 'tool_use', text: `${asText(b.name)}\n${JSON.stringify(b.input ?? null, null, 2)}` }
  if (b.type === 'tool_result') {
    const c = b.content
    const text = Array.isArray(c) ? c.filter((x) => x && typeof x === 'object' && x.type === 'text').map((x) => asText(x.text)).join('\n') : asText(c)
    return { kind: 'tool_result', text }
  }
  if (b.type === 'thinking') return b.thinking ? { kind: 'thinking', text: asText(b.thinking) } : null
  return rawBlock(b)
}

/** The stream records a file nests under `wrap` in each record, as records of their own: their blocks made here, their
 * time the nesting record's when they carry none. A record that nests none stays as it is. Pure. */
export function unwrapStream(records: SourceRecord[], wrap: string): SourceRecord[] {
  return records.map((rec) => {
    const outer = rec.record
    const inner = outer && typeof outer === 'object' ? outer[wrap] : undefined
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return rec
    const ts = inner.timestamp ?? TIME_KEYS.map((k) => outer[k]).find((v) => v != null && v !== '')
    return { ...rec, record: inner, blocks: streamBlocks(inner), meta: { ...rec.meta, ...(ts != null ? { timestamp: ts } : {}) } }
  })
}

/** The blocks of a conversational stream record the server keeps whole, as one raw block (in a file it types as text),
 * made here as the server makes them where it reads the file as a transcript; null for any other record. Pure. */
export function madeBlocks(rec: SourceRecord): Block[] | null {
  const r = rec.record
  const whole = rec.blocks.length === 1 && rec.blocks[0].kind === 'raw'
  return whole && CONVERSATIONAL.has(r?.type) && r?.message && typeof r.message === 'object' ? streamBlocks(r) : null
}

function StreamTranscript({ path, page, targetRef, transcript }: ViewProps) {
  const wrap = transcript?.wrap
  // the lines whose blocks are made here, from a nested record or one the server keeps whole: they are not the file's
  // own blocks, so labels' spans and citations' offsets are not drawn on them
  const { records, made } = useMemo(() => {
    if (wrap) {
      const out = unwrapStream(page.records, wrap)
      return { records: out, made: new Set(out.map((r) => r.line)) }
    }
    const lines = new Set<number>()
    const out = page.records.map((r) => {
      const blocks = madeBlocks(r)
      if (!blocks) return r
      lines.add(r.line)
      return { ...r, blocks }
    })
    return { records: out, made: lines }
  }, [wrap, page.records])
  const blockPathOf = (line: number) => (made.has(line) ? undefined : path)
  const [showSystem, setShowSystem] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records, showSystem])
  useEffect(() => {
    if (!target || showSystem) return
    const rec = records.find((r) => r.line === target.line)
    if (rec && !CONVERSATIONAL.has(rec.record?.type)) setShowSystem(true)
  }, [target, records, showSystem])

  // a conversational record with no words to show gets no row, unless a citation points at it
  const asked = targetOf(targetRef, path)?.line
  const rows = useMemo(() => records.filter((r) => !CONVERSATIONAL.has(r.record?.type) || hasWords(r.blocks) || r.line === asked), [records, asked])
  const runs = useMemo(
    () =>
      hiddenRuns(
        rows.map((r) => r.record?.type),
        rows.map((r) => r.line),
      ),
    [rows],
  )
  const out: ReactNode[] = []
  let prevSession: string | undefined
  let sessionNo = 1
  rows.forEach((rec, i) => {
    const r = rec.record ?? {}
    const sid: string | undefined = rec.meta?.session_id ?? r.session_id
    if (sid && i > 0 && prevSession && sid !== prevSession) {
      sessionNo++
      out.push(
        <div key={`s${rec.line}`} className="reader-session">
          <span>Session {sessionNo}</span>
        </div>,
      )
    }
    if (sid) prevSession = sid
    const type: string = r.type ?? 'record'
    if (!CONVERSATIONAL.has(type)) {
      if (showSystem) out.push(<SysRow key={rec.line} path={path} blockPath={blockPathOf(rec.line)} rec={rec} target={target} hit={hit} />)
      else if (runs.has(rec.line)) out.push(<HiddenRun key={`h${rec.line}`} count={runs.get(rec.line)!} onShow={() => setShowSystem(true)} />)
      return
    }
    const ts = rec.meta?.timestamp ?? r.timestamp
    const errorBlocks = errorBlockIndexes(r)
    const blockPath = blockPathOf(rec.line)
    const header = [type, ts ? stamp(String(ts)) : null].filter(Boolean).join(' · ')
    out.push(
      <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className={`reader-rec-${type}`} header={header} text={recordExcerpt(rec)}>
        {rec.blocks.map((b, k) => (b.kind === 'tool_result' ? <ToolResult key={k} block={b} path={blockPath} line={rec.line} index={k} target={blockPath ? target : null} hit={hit} isError={errorBlocks.has(k)} /> : <BlockEl key={k} block={b} path={blockPath} line={rec.line} index={k} target={blockPath ? target : null} hit={hit} />))}
      </RecordCard>,
    )
  })
  const system = records.filter((r) => !CONVERSATIONAL.has(r.record?.type)).length
  return (
    <div className="reader-transcript" ref={rootRef}>
      {system > 0 && (
        <div className="reader-viewbar">
          <Chip kind="status" icon="gear" count={system} active={showSystem} className="reader-syschip" onClick={() => setShowSystem((o) => !o)}>
            system
          </Chip>
        </div>
      )}
      {out}
    </div>
  )
}

const isBody = (v: unknown) => typeof v === 'string' || Array.isArray(v) || (!!v && typeof v === 'object')
const isMessage = (r: any) =>
  !!r && typeof r === 'object' && !Array.isArray(r) && MATCH_BODY_KEYS.some((k) => isBody(r[k])) && (hasAny(r, STRONG_AUTHOR_KEYS) || (hasAny(r, WEAK_AUTHOR_KEYS) && hasAny(r, TIME_KEYS)))

/**
 * How well the sample reads as a transcript: 1 for a Claude Code stream; 0.9 when at least 70% of the records are
 * messages (an author key and a body key, or an editor-like key, a body and a time), above the Table view's best so a
 * chat log opens as a transcript and still offers the table; else 0.
 */
export function transcriptScore(sample: any[]): number {
  if (!sample.length) return 0
  const typed = sample.filter((r) => r && typeof r === 'object' && STREAM_TYPES.has(r.type)).length
  const anyStream = sample.some((r) => r && typeof r === 'object' && ((r.message && typeof r.message === 'object') || typeof r.session_id === 'string' || typeof r.uuid === 'string'))
  if (typed / sample.length >= 0.6 && anyStream) return 1
  const objs = sample.filter((r) => r && typeof r === 'object' && !Array.isArray(r))
  if (objs.length < sample.length) return 0
  const msgish = objs.filter(isMessage).length
  return msgish / sample.length >= 0.7 ? 0.9 : 0
}

/** The sniff's score when the server gave one (1 for a Claude Code stream, 0.95 when it is sure, 0.5 when it only
 * offers the mode), or transcriptScore over the sample when that is higher. */
function match(_path: string, _kind: SourceKind, sample: any[], transcript?: TranscriptHint | null): number {
  return Math.max(transcript?.score ?? 0, transcriptScore(sample))
}

const def: ViewDef = { type: 'transcript', title: 'Transcript', match, component: Transcript }
export default def
