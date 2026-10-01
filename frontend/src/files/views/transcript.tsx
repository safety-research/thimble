// The Transcript view, for any file the server's sniff (backend transcripts.py) reads as close to a transcript: a
// Claude Code stream as cards by record, the system records behind a toggle; messages (JSON lines, a CSV or TSV file's
// rows) as posts with their authors and times; a text or markdown chat log as one card per turn, a turn's lines under
// its speaker; and a whole-file JSON transcript (a chat export, an eval log), or JSON lines in a file read as text, as
// the turns the server parses from it, a page at a time. While system records are hidden, a long run of them
// (HIDDEN_RUN_NOTE or more) says in one line how many it hides, so the view is never blank while the reader pages past
// them.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Spinner } from '../../components/Spinner'
import { api } from '../../lib/api'
import type { Block, ChatTurn, SourceKind, SourceRecord, SourceTurn, SourceTurns, TranscriptHint } from '../../lib/types'
import { BlockEl, Collapsible, errMsg, lineCount, RecordCard, recordExcerpt, targetOf, useTarget, type Target, type ViewDef, type ViewProps } from './common'
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

function ToolResult({ block, path, line, index, target, hit, isError }: { block: Block; path: string; line: number; index: number; target: Target | null; hit: boolean; isError: boolean }) {
  const forced = !!target && target.line === line && target.block === index
  return (
    <Collapsible lines={lineCount(block.text)} forced={forced}>
      <BlockEl block={block} path={path} line={line} index={index} target={target} hit={hit} className={isError ? 'reader-error' : undefined} />
    </Collapsible>
  )
}

function SysRow({ path, rec, target, hit }: { path: string; rec: SourceRecord; target: Target | null; hit: boolean }) {
  const [open, setOpen] = useState(false)
  const forced = !!target && target.line === rec.line && target.block != null
  return (
    <RecordCard path={path} line={rec.line} target={target} hit={hit} className="reader-sysrow" header="system" text={sysSummary(rec.record)}>
      <Button size="sm" className="reader-sys-summary mono" aria-expanded={open || forced} onClick={() => setOpen((o) => !o)}>
        {sysSummary(rec.record)}
      </Button>
      {(open || forced) && rec.blocks.map((b, k) => <BlockEl key={k} block={b} path={path} line={rec.line} index={k} target={target} hit={hit} />)}
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

export function Transcript(props: ViewProps) {
  const hint = props.transcript
  if (hint && (hint.format === 'json' || hint.format === 'conversations' || hint.lines)) return <TurnsTranscript {...props} />
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

/** A record's value at a key, dotted for a nested one (`message.author`). */
export function pick(r: unknown, key: string | undefined): unknown {
  if (!key) return undefined
  let v: unknown = r
  for (const part of key.split('.')) {
    if (!v || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[part]
  }
  return v
}

/** Who a speaker value names: a string, or a person object's name. */
export function nameOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['name', 'display_name', 'username', 'real_name', 'role', 'id']) {
      const got = nameOf((v as Record<string, unknown>)[k])
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

function MessageBoard({ path, page, targetRef, transcript }: ViewProps) {
  return <Posts path={path} records={page.records} targetRef={targetRef} hint={transcript} />
}

/** A CSV or TSV file's rows as posts, under the columns the sniff named. The words are the row's cell, so a span label
 * of the file's line does not mark them. */
function DelimitedTranscript({ workspace, path, page, targetRef, transcript }: ViewProps) {
  const rows = useDelimited(workspace, path, page.records)
  return <Posts path={path} records={rows} targetRef={targetRef} hint={transcript} derived />
}

/** Records as posts: author, context and time in the head, the body under it. A body the server's blocks hold is shown
 * as those blocks (span labels mark them); a body only the record holds (`derived`, or blocks that are the raw record)
 * as its text. */
function Posts({ path, records, targetRef, hint, derived }: { path: string; records: SourceRecord[]; targetRef?: string; hint?: TranscriptHint | null; derived?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  const keys = useMemo(() => keysFor(hint, records.slice(0, 20).map((r) => r.record)), [hint, records])
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
        // an empty body leaves the server a raw block of the whole record; the post says it is empty instead
        const empty = typeof body === 'string' && !body.trim()
        const own = !derived && rec.blocks.length > 0 && !rec.blocks.every((b) => b.kind === 'raw' && body != null)
        return (
          <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-msg" header={header} text={empty ? undefined : own ? recordExcerpt(rec) : body?.slice(0, 500)}>
            {empty ? (
              <div className="reader-msg-empty">(empty body)</div>
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
 * turn marks it there. */
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
      {turns.map(({ line, turn, recs }) => {
        const header = turn ? [turn.speaker, turn.time ? stamp(turn.time) : null].filter(Boolean).join(' · ') : undefined
        const lines = shownLines(recs, turn)
        const text = lines.map((r, i) => (i === 0 && turn ? lineText(r).slice(turn.at) : lineText(r))).join('\n').trim()
        return (
          <RecordCard key={line} path={path} line={line} target={target} hit={hit} className={turn ? 'reader-msg' : 'reader-msg reader-chat-lead'} header={header} text={text.slice(0, 500)}>
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

const TURNS_PAGE = 200
/** turns kept in memory; past it, the ones at the far end from the reader's move are let go */
const TURNS_CAP = 2000

/** A whole-file JSON transcript (a chat export, an eval log, conversations one per line), or JSON lines in a file the
 * server reads as text, as the turns the server parses from it (GET /source/turns): a page at a time from the start, or
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
    const g = t.group != null ? data.groups[String(t.group)] : undefined
    if (titled && g && (k === 0 || turns[k - 1].group !== t.group))
      out.push(
        <div key={`g${t.i}`} className="reader-session">
          <span>{g.title || `Conversation ${t.group! + 1}`}</span>
        </div>,
      )
    out.push(<TurnCard key={t.i} path={path} turn={t} target={holder?.i === t.i ? target : null} hit={hit} />)
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

function TurnCard({ path, turn, target, hit }: { path: string; turn: SourceTurn; target: Target | null; hit: boolean }) {
  const header = [turn.speaker || turn.role, turn.time ? timeOf(turn.time) : null].filter(Boolean).join(' · ')
  const block: Block = { kind: 'text', text: turn.text }
  return (
    <RecordCard path={path} line={turn.line} target={target} hit={hit} className={`reader-msg reader-turn-${turn.role}`} header={header} text={turn.text.slice(0, 500)}>
      {turn.text.trim() ? <BlockEl block={block} line={turn.line} index={0} target={null} hit={false} /> : <div className="reader-msg-empty">(empty)</div>}
      {turn.cut != null && <div className="reader-msg-empty">Cut at {turn.text.length.toLocaleString()} of {turn.cut.toLocaleString()} characters. Raw shows all of it.</div>}
    </RecordCard>
  )
}

function StreamTranscript({ path, page, targetRef }: ViewProps) {
  const records = page.records
  const [showSystem, setShowSystem] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records, showSystem])
  useEffect(() => {
    if (!target || showSystem) return
    const rec = records.find((r) => r.line === target.line)
    if (rec && !CONVERSATIONAL.has(rec.record?.type)) setShowSystem(true)
  }, [target, records, showSystem])

  const runs = useMemo(
    () =>
      hiddenRuns(
        records.map((r) => r.record?.type),
        records.map((r) => r.line),
      ),
    [records],
  )
  const out: ReactNode[] = []
  let prevSession: string | undefined
  let sessionNo = 1
  records.forEach((rec, i) => {
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
      if (showSystem) out.push(<SysRow key={rec.line} path={path} rec={rec} target={target} hit={hit} />)
      else if (runs.has(rec.line)) out.push(<HiddenRun key={`h${rec.line}`} count={runs.get(rec.line)!} onShow={() => setShowSystem(true)} />)
      return
    }
    const ts = rec.meta?.timestamp ?? r.timestamp
    const errorBlocks = errorBlockIndexes(r)
    const header = [type, ts ? stamp(String(ts)) : null].filter(Boolean).join(' · ')
    out.push(
      <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className={`reader-rec-${type}`} header={header} text={recordExcerpt(rec)}>
        {rec.blocks.map((b, k) => (b.kind === 'tool_result' ? <ToolResult key={k} block={b} path={path} line={rec.line} index={k} target={target} hit={hit} isError={errorBlocks.has(k)} /> : <BlockEl key={k} block={b} path={path} line={rec.line} index={k} target={target} hit={hit} />))}
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
