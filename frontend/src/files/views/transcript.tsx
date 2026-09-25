// The Transcript view: a Claude Code stream-json transcript as cards by record, the system records behind a toggle;
// or a message board's posts with their authors and times. While system records are hidden, a long run of them
// (HIDDEN_RUN_NOTE or more) says in one line how many it hides, so the view is never blank while the reader pages past
// them.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import type { Block, SourceKind, SourceRecord } from '../../lib/types'
import { BlockEl, Collapsible, lineCount, RecordCard, recordExcerpt, useTarget, type Target, type ViewDef, type ViewProps } from './common'

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
  const stream = props.page.records.some((rec) => isStreamRec(rec.record))
  return stream ? <StreamTranscript {...props} /> : <MessageBoard {...props} />
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

function MessageBoard({ path, page, targetRef }: ViewProps) {
  const records = page.records
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  const keys = useMemo(() => messageKeys(records.slice(0, 20).map((r) => r.record)), [records])
  return (
    <div className="reader-transcript reader-msgboard" ref={rootRef}>
      {records.map((rec) => {
        const r = rec.record ?? {}
        const author = keys.author && present(r[keys.author]) ? String(r[keys.author]) : '(unsigned)'
        const ts = keys.time ? r[keys.time] : undefined
        const ctx = keys.context ? r[keys.context] : undefined
        const body = keys.body ? r[keys.body] : undefined
        const header = [author, present(ctx) ? String(ctx) : null, present(ts) ? stamp(String(ts)) : null].filter(Boolean).join(' · ')
        // an empty body leaves the server a raw block of the whole record; the post says it is empty instead
        const empty = typeof body === 'string' && !body.trim()
        return (
          <RecordCard key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-msg" header={header} text={empty ? undefined : rec.blocks.length ? recordExcerpt(rec) : typeof body === 'string' ? body.slice(0, 500) : undefined}>
            {empty ? <div className="reader-msg-empty">(empty body)</div> : rec.blocks.length ? rec.blocks.map((b, k) => <BlockEl key={k} block={b} path={path} line={rec.line} index={k} target={target} hit={hit} />) : <BlockEl block={{ kind: 'text', text: typeof body === 'string' ? body : JSON.stringify(body ?? r) }} path={path} line={rec.line} index={0} target={target} hit={hit} />}
          </RecordCard>
        )
      })}
    </div>
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

function match(_path: string, _kind: SourceKind, sample: any[]): number {
  return transcriptScore(sample)
}

const def: ViewDef = { type: 'transcript', title: 'Transcript', match, component: Transcript }
export default def
