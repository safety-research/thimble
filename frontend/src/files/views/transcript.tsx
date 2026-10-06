// The Transcript view, for any file the server's sniff (backend transcripts.py) reads as close to a transcript: a
// Claude Code stream as cards by record, the system records behind a toggle (a stream each record nests under one key,
// as the Agent SDK's messages kept in a database row, shows the nested records); messages (JSON lines, a CSV or TSV file's
// rows) as posts with their authors and times; JSON lines that each hold a whole conversation as one card per line,
// its turns inside; a text or markdown chat log as one card per turn, a turn's lines under its speaker; and a
// whole-file JSON transcript (a chat export, an eval log) as the turns the server parses from it, a page at a time.
// JSON lines in a file the server pages as text are parsed here, line by line. While system records are hidden, a long
// run of them (HIDDEN_RUN_NOTE or more) says in one line how many it hides, so the view is never blank while the reader
// pages past them. A record with no words to show (a turn that holds only redacted thinking, a post with an empty body)
// gets no row, unless a citation points at it; Raw shows every line. A citation of words marks them wherever the view
// shows them, in a field or a turn that then shows whole. An author named only by id shows the name the corpus gives
// that id (an agents.jsonl beside the file), else the id shortened, the whole id on hover.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Spinner } from '../../components/Spinner'
import { api } from '../../lib/api'
import { findQuote } from '../../lib/quoteFind'
import { cleanTerminal, needsClean } from '../../lib/terminal'
import type { Block, ChatTurn, SourceKind, SourceRecord, SourceTurn, SourceTurns, TranscriptHint } from '../../lib/types'
import { BlockEl, citedQuote, Collapsible, compact, errMsg, isTargetLine, lineCount, quoteTarget, RecordCard, recordExcerpt, targetOf, useTarget, type Target, type ViewDef, type ViewProps } from './common'
import { UNFOLD_EVENT } from '../find'
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

/** A tool result, its terminal output cleaned for reading (lib/terminal): a redrawn line reads as the line it ended on,
 * ANSI escapes and counter markers gone. Raw shows the stored bytes. The cleaned text is not the stored block, so it is
 * drawn with no path (a span ref's offsets do not apply, and a citation of it is of the record); a citation into the
 * block, whose offsets are the stored text's, opens it Raw so they land. A result with nothing to clean is the block
 * itself, drawn as before. */
function ToolResult({ block, path, line, index, target, hit, isError }: { block: Block; path?: string; line: number; index: number; target: Target | null; hit: boolean; isError: boolean }) {
  const forced = !!target && target.line === line && target.block === index
  const dirty = needsClean(block.text)
  const [raw, setRaw] = useState(false)
  const showRaw = raw || forced || !dirty
  const shown = showRaw ? block.text : cleanTerminal(block.text)
  return (
    <Collapsible lines={lineCount(shown)} forced={forced}>
      <BlockEl block={{ ...block, text: shown }} path={showRaw ? path : undefined} line={line} index={index} target={showRaw ? target : null} hit={hit} className={isError ? 'reader-error' : undefined} />
      {dirty && (
        <Button size="sm" className="reader-raw-toggle" aria-pressed={showRaw} onClick={() => setRaw((o) => !o)}>
          {showRaw ? 'Cleaned' : 'Raw'}
        </Button>
      )}
    </Collapsible>
  )
}

/** `quote`: the words a span ref of the record quotes, found in its blocks when they are made here (no `blockPath`). */
function SysRow({ path, blockPath, rec, target, hit, quote }: { path: string; blockPath?: string; rec: SourceRecord; target: Target | null; hit: boolean; quote: string | null }) {
  const [open, setOpen] = useState(false)
  const forced = !!target && target.line === rec.line && target.block != null
  return (
    <RecordCard path={path} line={rec.line} target={target} hit={hit} className="reader-sysrow" header="system" text={sysSummary(rec.record)}>
      <Button size="sm" className="reader-sys-summary mono" aria-expanded={open || forced} onClick={() => setOpen((o) => !o)}>
        {sysSummary(rec.record)}
      </Button>
      {(open || forced) && rec.blocks.map((b, k) => <BlockEl key={k} block={b} path={blockPath} line={rec.line} index={k} target={blockPath ? target : quoteTarget(target, rec.line, k, b.text, quote)} hit={hit} />)}
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
  if (hint?.tools && !hint.lines) return <AgentTranscript {...props} />
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

function MessageBoard({ workspace, path, page, targetRef, transcript }: ViewProps) {
  const lines = !!transcript?.lines
  const records = useMemo(() => (lines ? parsedLines(page.records) : page.records), [lines, page.records])
  const quote = useMemo(() => citedQuote(page.records, targetOf(targetRef, path)), [page.records, targetRef, path])
  return <Posts workspace={workspace} path={path} records={records} targetRef={targetRef} hint={transcript} derived={lines} quote={quote} />
}

/** A CSV or TSV file's rows as posts, under the columns the sniff named. The words are the row's cell, so a span label
 * of the file's line does not mark them. */
function DelimitedTranscript({ workspace, path, page, targetRef, transcript }: ViewProps) {
  const rows = useDelimited(workspace, path, page.records)
  const quote = useMemo(() => citedQuote(page.records, targetOf(targetRef, path)), [page.records, targetRef, path])
  return <Posts workspace={workspace} path={path} records={rows} targetRef={targetRef} hint={transcript} derived quote={quote} />
}

/** characters of one field a post with no words shows */
const FIELD_MAX = 300

/** The other fields of a record that holds no words (an agent's action among a village's talk): those of the record
 * that would hold them, but for who speaks and the time, each value as a line, nested ones compacted. The first field
 * that holds `quote` (the words a citation quotes) comes whole, a nested one as indented JSON, with the words' place in
 * it. Pure. */
export function restFields(r: unknown, keys: MessageKeys, quote: string | null = null): ([string, string] | [string, string, [number, number]])[] {
  const dot = keys.body?.lastIndexOf('.') ?? -1
  const prefix = dot > 0 ? keys.body!.slice(0, dot) : ''
  const box = prefix ? pick(r, prefix) : r
  if (!box || typeof box !== 'object' || Array.isArray(box)) return []
  const own = (k: string) => (prefix && k.startsWith(`${prefix}.`) ? k.slice(prefix.length + 1) : k)
  const skip = new Set([...(keys.author ?? '').split('|'), keys.time ?? ''].map(own))
  let found = !quote
  return Object.entries(box as Record<string, unknown>)
    .filter(([k, v]) => !skip.has(k) && v != null && v !== '')
    .map(([k, v]) => {
      if (!found) {
        const whole = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? ''
        const at = findQuote(whole, quote!)
        if (at) {
          found = true
          return [k, whole, at]
        }
      }
      return [k, typeof v === 'string' ? (v.length > FIELD_MAX ? `${v.slice(0, FIELD_MAX)}…` : v) : compact(v, FIELD_MAX)]
    })
}

const ID_SHAPE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i
const keyWords = (k: string) =>
  k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** Whether every key a speaker key names holds an id (`agent_speaker_id|user_speaker_id`, `data.agentId`). Pure. */
export function idKey(key: string | undefined): boolean {
  return (
    !!key &&
    key.split('|').every((alt) => {
      const w = keyWords(alt.split('.').pop() ?? '')
      return w.length > 0 && (w[w.length - 1] === 'id' || w[w.length - 1] === 'uuid')
    })
  )
}

/** The speaker values of the records that are ids: all of them under a key that holds ids, else those shaped as a uuid
 * or a long hex id. Pure. */
export function speakerIds(records: readonly SourceRecord[], key: string | undefined): string[] {
  if (!key) return []
  const byKey = idKey(key)
  const out = new Set<string>()
  for (const rec of records) {
    const v = pick(rec.record, key)
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
    if (s && (byKey || ID_SHAPE.test(s))) out.add(s)
  }
  return [...out]
}

/** An id as a post's head shows it when the corpus gives it no name: its first 8 characters when it is longer than 12. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

/** the names the server found for speaker ids, per workspace, file and key: null for an id it has none for or not yet */
const speakerNames = new Map<string, Map<string, string | null>>()
/** ids one request asks names for, under the server's NAMES_IDS_MAX */
const NAMES_BATCH = 100

/** The names the corpus gives the speaker ids (GET /source/speakers), asked once per id; an id is missing or null until
 * its answer comes. */
function useSpeakerNames(workspace: string, path: string, key: string | undefined, ids: string[]): Map<string, string | null> {
  const scope = `${workspace}\n${path}\n${key ?? ''}`
  const [, setAnswered] = useState(0)
  let known = speakerNames.get(scope)
  if (!known) {
    known = new Map()
    speakerNames.set(scope, known)
  }
  const want = ids.filter((id) => !known.has(id))
  const wantKey = want.join(',')
  useEffect(() => {
    if (!key || !want.length) return
    let alive = true
    const cache = speakerNames.get(scope)!
    for (const id of want) cache.set(id, null)
    const asks: Promise<void>[] = []
    for (let i = 0; i < want.length; i += NAMES_BATCH) {
      asks.push(
        api
          .speakerNames(workspace, path, key, want.slice(i, i + NAMES_BATCH).join(','))
          .then((r) => {
            for (const [id, name] of Object.entries(r.names ?? {})) cache.set(id, name)
          })
          .catch(() => undefined),
      )
    }
    void Promise.all(asks).then(() => alive && setAnswered((n) => n + 1))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, wantKey])
  return known
}

/** Who speaks, as a post's head shows it: an id's name when the corpus gives one, else the id shortened, the whole id
 * on hover. */
function Speaker({ who, isId, names }: { who: string; isId: boolean; names: Map<string, string | null> }) {
  if (!isId) return <>{who}</>
  const shown = names.get(who) ?? shortId(who)
  return shown === who ? <>{who}</> : <span title={who}>{shown}</span>
}

/** Records as posts: author, context and time in the head, the body under it. A body the server's blocks hold is shown
 * as those blocks (span labels mark them); a body only the record holds (`derived`, or blocks that are the raw record)
 * as its text; a record with no body, whose blocks are the raw record, as its other fields on one line. */
function Posts({ workspace, path, records, targetRef, hint, derived, quote }: { workspace: string; path: string; records: SourceRecord[]; targetRef?: string; hint?: TranscriptHint | null; derived?: boolean; quote: string | null }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  const keys = useMemo(() => keysFor(hint, records.slice(0, 20).map((r) => r.record)), [hint, records])
  const ids = useMemo(() => speakerIds(records, keys.author), [records, keys.author])
  const idSet = useMemo(() => new Set(ids), [ids])
  const names = useSpeakerNames(workspace, path, keys.author, ids)
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
        const rest = [present(ctx) && typeof ctx !== 'object' ? String(ctx) : null, ts].filter(Boolean)
        const header = (
          <>
            <Speaker who={author} isId={idSet.has(author)} names={names} />
            {rest.map((x) => ` · ${x}`).join('')}
          </>
        )
        const cite = target && rec.line === target.line ? quote : null
        // an empty body leaves the server a raw block of the whole record: the post has no row, or, when a citation
        // points at it, says it is empty
        const empty = typeof body === 'string' && !body.trim()
        if (empty && rec.line !== asked) return null
        const fields = value == null && rec.blocks.every((b) => b.kind === 'raw') ? restFields(r, keys, cite) : null
        const own = !derived && rec.blocks.length > 0 && !rec.blocks.every((b) => b.kind === 'raw' && body != null)
        return (
          <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-msg" header={header} text={empty ? undefined : own ? recordExcerpt(rec) : body?.slice(0, 500)}>
            {empty ? (
              <div className="reader-msg-empty">(empty body)</div>
            ) : fields?.length ? (
              <div className="reader-msg-fields">
                {fields.map(([k, v, at]) => (
                  <span key={k} className={at ? 'reader-msg-field-open' : undefined}>
                    <span className="reader-msg-field mono">{k}</span>{' '}
                    {at ? (
                      <>
                        {v.slice(0, at[0])}
                        <span className="hl">{v.slice(at[0], at[1])}</span>
                        {v.slice(at[1])}
                      </>
                    ) : (
                      v
                    )}
                  </span>
                ))}
              </div>
            ) : own ? (
              rec.blocks.map((b, k) => <BlockEl key={k} block={b} path={path} line={rec.line} index={k} target={target} hit={hit} />)
            ) : (
              <PostText text={body ?? JSON.stringify(value ?? r)} line={rec.line} target={target} hit={hit} quote={cite} />
            )}
          </RecordCard>
        )
      })}
    </div>
  )
}

function PostText({ text, line, target, hit, quote }: { text: string; line: number; target: Target | null; hit: boolean; quote: string | null }) {
  return <BlockEl block={{ kind: 'text', text }} line={line} index={0} target={quoteTarget(target, line, 0, text, quote)} hit={hit} />
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
  const quote = useMemo(() => citedQuote(page.records, targetOf(targetRef, path)), [page.records, targetRef, path])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  return (
    <div className="reader-transcript reader-convs" ref={rootRef}>
      {records.map((rec) => {
        const r = rec.record ?? {}
        // a turn with no words gets no row
        const turns = conversationTurns(r, transcript)?.filter((t) => t.text.trim())
        const ctx = CONTEXT_KEYS.map((key) => r[key]).find((v) => present(v) && typeof v !== 'object')
        const first = turns?.[0]?.text ?? ''
        const cite = target && rec.line === target.line ? quote : null
        // the first turn that holds the quoted words, and their place in it
        let cited: { k: number; at: [number, number] } | null = null
        for (let k = 0; cite && turns && !cited && k < turns.length; k++) {
          const at = findQuote(turns[k].text, cite)
          if (at) cited = { k, at }
        }
        return (
          <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-msg reader-conv" header={ctx != null ? String(ctx) : undefined} text={first.slice(0, 500) || undefined}>
            {turns && !turns.length ? (
              <div className="reader-msg-empty">(empty)</div>
            ) : turns ? (
              turns.map((t, k) => {
                const at = cited?.k === k ? cited.at : null
                // a turn whose quoted words lie past the cut shows whole
                const shown = at && at[1] > TURN_TEXT_MAX ? t.text : t.text.slice(0, TURN_TEXT_MAX)
                return (
                  <div key={k} className="reader-conv-turn">
                    <div className="reader-conv-speaker mono">{[t.speaker, t.time].filter(Boolean).join(' · ') || '(unsigned)'}</div>
                    <BlockEl block={{ kind: 'text', text: shown }} line={rec.line} index={k} target={at ? { line: rec.line, block: k, start: at[0], end: at[1] } : null} hit={hit} />
                    {t.text.length > shown.length && <div className="reader-msg-empty">Cut at {TURN_TEXT_MAX.toLocaleString()} of {t.text.length.toLocaleString()} characters. Raw shows all of it.</div>}
                  </div>
                )
              })
            ) : (
              <PostText text={typeof r.text === 'string' ? r.text : JSON.stringify(r)} line={rec.line} target={target} hit={hit} quote={cite} />
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
 * span labels do not mark. A citation of words opens at the turn the server finds holding them (`cited`), where they
 * are highlighted, among however many turns share its line. */
function TurnsTranscript({ workspace, path, targetRef }: ViewProps) {
  const asked = useMemo(() => targetOf(targetRef, path), [targetRef, path])
  const [data, setData] = useState<SourceTurns | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loading = useRef(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const askedLine = asked?.line
  const askedBlock = asked?.block
  const askedStart = asked?.start
  const askedEnd = asked?.end
  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    const span = askedStart != null && askedEnd != null ? { block: askedBlock ?? 0, start: askedStart, end: askedEnd } : undefined
    api
      .sourceTurns(workspace, path, 0, TURNS_PAGE, askedLine, span)
      .then((p) => alive && setData(p))
      .catch((e) => alive && setError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [workspace, path, askedLine, askedBlock, askedStart, askedEnd])
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
            if (dir === 'earlier') return { ...p, cited: cur.cited, groups, turns: [...p.turns, ...cur.turns].slice(0, TURNS_CAP) }
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
  const cited = data?.cited
  // a citation scrolls to the turn holding the words it quotes, else to the first turn standing on its line, else the
  // last before it
  const holder = !asked ? null : cited ? (turns.find((t) => t.i === cited.i) ?? null) : lineHolder(turns, asked.line)
  // the citation itself when the turn stands on its line, so another span of that line scrolls again
  const cardRef = !holder ? undefined : holder.line === asked!.line ? targetRef : `${path}#L${holder.line}`
  const { target, hit } = useTarget(cardRef, path, rootRef, [data])
  if (error) return <div className="reader-error-text">{error}</div>
  if (!data)
    return (
      <div className="reader-more">
        <Spinner size={14} label="Loading" />
      </div>
    )
  const titled = data.n_groups > 1 || Object.values(data.groups).some((g) => g.title)
  const out: ReactNode[] = []
  // a turn with no words gets no card, unless a citation points at it; the card before it shows its lines' labels
  const shown = turns.filter((t) => t.text.trim() || holder?.i === t.i)
  const last = turns[turns.length - 1]
  shown.forEach((t, k) => {
    const g = t.group != null ? data.groups[String(t.group)] : undefined
    if (titled && g && (k === 0 || shown[k - 1].group !== t.group))
      out.push(
        <div key={`g${t.i}`} className="reader-session">
          <span>{g.title || `Conversation ${t.group! + 1}`}</span>
        </div>,
      )
    const next = shown[k + 1]?.line ?? (last.i !== t.i ? last.line + 1 : t.line)
    out.push(<TurnCard key={t.i} path={path} turn={t} end={Math.max(t.line, next - 1)} target={holder?.i === t.i ? target : null} hit={hit} quote={cited?.i === t.i ? cited.quote : null} />)
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

/** The turn a citation of `line` opens at when no quoted words pick one: the first standing on it, else the last before
 * it. Pure. */
function lineHolder(turns: readonly SourceTurn[], line: number): SourceTurn | null {
  return turns.find((t) => t.line === line) ?? turns.reduce<SourceTurn | null>((best, t) => (t.line < line ? t : best), null)
}

/** One turn of a whole-file JSON transcript, whose gutter shows the labels of its line and of the lines up to the next
 * turn's (`end`), and the words a citation quotes (`quote`) highlighted. */
function TurnCard({ path, turn, end, target, hit, quote }: { path: string; turn: SourceTurn; end: number; target: Target | null; hit: boolean; quote: string | null }) {
  const header = [turn.speaker || turn.role, turn.time ? timeOf(turn.time) : null].filter(Boolean).join(' · ')
  const block: Block = { kind: 'text', text: turn.text }
  return (
    <RecordCard path={path} line={turn.line} end={end} target={target} hit={hit} className={`reader-msg reader-turn-${turn.role}`} header={header} text={turn.text.slice(0, 500)}>
      {turn.text.trim() ? <BlockEl block={block} line={turn.line} index={0} target={quoteTarget(target, turn.line, 0, turn.text, quote)} hit={hit} /> : <div className="reader-msg-empty">(empty)</div>}
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

// ---------------------------------------------------------------------- an agent transcript with tool records

// a tool record ({tool_name, tool_call, tool_result}), mirroring backend transcripts.is_tool_record
const TOOL_NAME_KEYS = ['tool_name', 'tool']
const TOOL_CALL_KEYS = ['tool_call', 'tool_input', 'tool_args', 'arguments', 'function_call']
const TOOL_RESULT_KEYS = ['tool_result', 'tool_response', 'observation']
// the keys of a call whose value glosses it on one line (a command, a path, a query), most telling first
const GLOSS_KEYS = ['command', 'text', 'cmd', 'input', 'path', 'file', 'query', 'url', 'pattern', 'name', 'session_name']

const firstVal = (r: any, keys: readonly string[]): unknown => {
  for (const k of keys) {
    const v = r?.[k]
    if (v != null && v !== '') return v
  }
  return undefined
}

const firstLine = (s: string): string => {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  return line.length > 200 ? line.slice(0, 200) + '…' : line
}

/** A record's tool name, its call and its result when it logs one tool call ({tool_name, tool_call, tool_result}); null
 * for any other record. A null call or result is read as absent (a redacted call). Pure. */
export function toolParts(r: any): { name: string; call: unknown; result: unknown } | null {
  if (!r || typeof r !== 'object') return null
  const name = TOOL_NAME_KEYS.map((k) => r[k]).find((v) => typeof v === 'string' && v) as string | undefined
  if (!name) return null
  const call = firstVal(r, TOOL_CALL_KEYS)
  const result = firstVal(r, TOOL_RESULT_KEYS)
  if (call == null && result == null) return null
  return { name, call, result }
}

/** The `<thinking>…</thinking>` a reply opens with, and the reply after it; the whole text as the reply when it has
 * none. Pure. */
export function splitThinking(text: string): { thinking: string | null; reply: string } {
  const m = /^\s*<thinking>([\s\S]*?)<\/thinking>\s*/.exec(text)
  return m ? { thinking: m[1].trim(), reply: text.slice(m[0].length) } : { thinking: null, reply: text }
}

/** A tool call on one line for the overview: the first telling string it holds (a command, a path), else its keys, else
 * the call as written. Pure. */
export function callGloss(call: unknown): string {
  if (call == null) return ''
  if (typeof call === 'string') return firstLine(call)
  if (typeof call === 'object' && !Array.isArray(call)) {
    const v = firstVal(call, GLOSS_KEYS)
    if (typeof v === 'string') return firstLine(v)
    const keys = Object.keys(call as object)
    if (keys.length) return keys.join(', ')
  }
  return firstLine(compact(call, 200))
}

const callText = (call: unknown): string => (typeof call === 'string' ? call : JSON.stringify(call, null, 2) ?? '')

export interface AgentBlock {
  kind: Block['kind']
  text: string
  /** the stored bytes, when `text` is cleaned terminal output: Raw shows them */
  raw?: string
}

export interface AgentMsg {
  kind: 'tool' | 'text' | 'system' | 'other'
  toolName?: string
  blocks: AgentBlock[]
  /** the one line the overview shows for the message */
  summary: string
}

/** A record as the agent view shows it: a tool call and its cleaned result as blocks, a reply's leading `<thinking>` as
 * a quiet block before its words, a system record or plain message as its words; with the one line the overview shows.
 * `keys` names where the record keeps who speaks, the words and the time. Pure (clean-up aside). */
export function agentDisplay(r: any, keys: MessageKeys): AgentMsg {
  const tool = toolParts(r)
  if (tool) {
    const blocks: AgentBlock[] = [{ kind: 'tool_use', text: tool.name + (tool.call != null ? '\n' + callText(tool.call) : '') }]
    if (tool.result != null) {
      const stored = textOf(tool.result) ?? (typeof tool.result === 'string' ? tool.result : callText(tool.result))
      blocks.push({ kind: 'tool_result', text: cleanTerminal(stored), raw: needsClean(stored) ? stored : undefined })
    }
    const gloss = callGloss(tool.call)
    return { kind: 'tool', toolName: tool.name, blocks, summary: gloss ? `${tool.name}  ${gloss}` : tool.name }
  }
  const body = textOf(pick(r, keys.body))
  if (body == null) return { kind: 'other', blocks: [{ kind: 'raw', text: JSON.stringify(r, null, 2) ?? '' }], summary: compact(r, 160) }
  const role = (nameOf(pick(r, keys.author)) ?? '').toLowerCase()
  const { thinking, reply } = splitThinking(body)
  const blocks: AgentBlock[] = []
  if (thinking) blocks.push({ kind: 'thinking', text: thinking })
  if (reply.trim() || !thinking) blocks.push({ kind: 'text', text: reply })
  const summary = firstLine(reply.trim() || (thinking ? `thinking: ${thinking}` : '')) || '(empty)'
  return { kind: role === 'system' ? 'system' : 'text', blocks, summary }
}

/** A message folded to one line until it is opened. The full message stays in the DOM so a search finds its words and,
 * finding them folded (`reader-collapsed`), opens it (UNFOLD_EVENT). A citation or search keeps it open (`forced`). */
function MessageFold({ startOpen, forced, summary, children }: { startOpen: boolean; forced: boolean; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const unfold = () => setOpen(true)
    el.addEventListener(UNFOLD_EVENT, unfold)
    return () => el.removeEventListener(UNFOLD_EVENT, unfold)
  }, [])
  const expanded = open || forced
  return (
    <div ref={box} className={'reader-msgfold' + (expanded ? '' : ' reader-collapsed')}>
      {!expanded && (
        <button type="button" className="reader-msg-oneline" onClick={() => setOpen(true)}>
          {summary}
        </button>
      )}
      <div className="reader-msgfold-full" style={expanded ? undefined : { display: 'none' }}>
        {children}
      </div>
      {expanded && !forced && (
        <Button size="sm" className="reader-expand reader-msgfold-collapse" onClick={() => setOpen(false)}>
          Collapse
        </Button>
      )}
    </div>
  )
}

/** A made tool-result block: cleaned terminal output, with Raw to see the stored bytes. The block is the view's own, so
 * a citation of it highlights the words it quotes (`quote`). */
function AgentResult({ block, line, index, target, hit, quote }: { block: AgentBlock; line: number; index: number; target: Target | null; hit: boolean; quote: string | null }) {
  const [raw, setRaw] = useState(false)
  const hasRaw = block.raw != null
  const text = raw && hasRaw ? block.raw! : block.text
  const tgt = quoteTarget(target, line, index, text, quote)
  return (
    <Collapsible lines={lineCount(text)} forced={!!tgt && tgt.start != null}>
      <BlockEl block={{ kind: 'tool_result', text }} line={line} index={index} target={tgt} hit={hit} />
      {hasRaw && (
        <Button size="sm" className="reader-raw-toggle" aria-pressed={raw} onClick={() => setRaw((o) => !o)}>
          {raw ? 'Cleaned' : 'Raw'}
        </Button>
      )}
    </Collapsible>
  )
}

/** An agent transcript whose records interleave spoken turns with tool records (the sniff's `tools`): one card per
 * message, its speaker, tool name and time in the head. A spoken reply shows (its `<thinking>` a quiet block); a tool
 * call and its cleaned result, and a system record, fold to one line until opened. A citation or a search opens the
 * message it lands in. The blocks are the view's own, so the record's label gutter marks the message and a citation
 * highlights the words it quotes; a span ref into the stored record still resolves there. */
function AgentTranscript({ workspace: _workspace, path, page, targetRef, transcript }: ViewProps) {
  const records = useMemo(() => (transcript?.lines ? parsedLines(page.records) : page.records), [transcript?.lines, page.records])
  const keys = useMemo(() => keysFor(transcript, records.slice(0, 20).map((r) => r.record)), [transcript, records])
  const quote = useMemo(() => citedQuote(page.records, targetOf(targetRef, path)), [page.records, targetRef, path])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  return (
    <div className="reader-transcript reader-agent" ref={rootRef}>
      {records.map((rec) => {
        const r = rec.record ?? {}
        const msg = agentDisplay(r, keys)
        const speaker = nameOf(pick(r, keys.author)) ?? '(unsigned)'
        const ts = timeOf(pick(r, keys.time))
        const header = (
          <>
            {speaker}
            {msg.toolName ? <span className="reader-agent-toolname"> · {msg.toolName}</span> : null}
            {ts ? ` · ${ts}` : ''}
          </>
        )
        const cite = target && target.line === rec.line ? quote : null
        const forced = isTargetLine(target, rec.line)
        const startOpen = msg.kind === 'text' || msg.kind === 'other'
        return (
          <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className={`reader-msg reader-agent-${msg.kind}`} header={header} text={msg.summary}>
            <MessageFold startOpen={startOpen} forced={forced} summary={msg.summary}>
              {msg.blocks.map((b, k) =>
                b.kind === 'tool_result' ? (
                  <AgentResult key={k} block={b} line={rec.line} index={k} target={target} hit={hit} quote={cite} />
                ) : b.kind === 'thinking' || b.kind === 'tool_use' || b.kind === 'raw' ? (
                  <Collapsible key={k} lines={lineCount(b.text)} forced={!!cite && !!quoteTarget(target, rec.line, k, b.text, cite)?.start}>
                    <BlockEl block={b} line={rec.line} index={k} target={quoteTarget(target, rec.line, k, b.text, cite)} hit={hit} />
                  </Collapsible>
                ) : (
                  <BlockEl key={k} block={b} line={rec.line} index={k} target={quoteTarget(target, rec.line, k, b.text, cite)} hit={hit} />
                ),
              )}
            </MessageFold>
          </RecordCard>
        )
      })}
    </div>
  )
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
  const quote = useMemo(() => citedQuote(page.records, targetOf(targetRef, path)), [page.records, targetRef, path])
  const [showSystem, setShowSystem] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records, showSystem])
  // a made block is marked where it holds the words a span ref quotes, as its offsets are not the file's
  const blockTarget = (line: number, k: number, b: Block) => (made.has(line) ? quoteTarget(target, line, k, b.text, quote) : target)
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
      if (showSystem) out.push(<SysRow key={rec.line} path={path} blockPath={blockPathOf(rec.line)} rec={rec} target={target} hit={hit} quote={quote} />)
      else if (runs.has(rec.line)) out.push(<HiddenRun key={`h${rec.line}`} count={runs.get(rec.line)!} onShow={() => setShowSystem(true)} />)
      return
    }
    const ts = rec.meta?.timestamp ?? r.timestamp
    const errorBlocks = errorBlockIndexes(r)
    const blockPath = blockPathOf(rec.line)
    const header = [type, ts ? stamp(String(ts)) : null].filter(Boolean).join(' · ')
    out.push(
      <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className={`reader-rec-${type}`} header={header} text={recordExcerpt(rec)}>
        {rec.blocks.map((b, k) => (b.kind === 'tool_result' ? <ToolResult key={k} block={b} path={blockPath} line={rec.line} index={k} target={blockTarget(rec.line, k, b)} hit={hit} isError={errorBlocks.has(k)} /> : <BlockEl key={k} block={b} path={blockPath} line={rec.line} index={k} target={blockTarget(rec.line, k, b)} hit={hit} />))}
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
