// Shared pieces for the file views: the record row, the line row, the verbatim block with the texts a span label marks,
// ref targets and the scroll-and-highlight hook. Rows carry `data-anchor="<path>#L<n>"` and the class `reader-card`;
// a marked text carries its own span anchor (`<path>#L<n>.b<k>:c<a>-<b>`), so ⌘ picks records and spans alike.
import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Button } from '../../components/Button'
import { Tipped } from '../../components/Tooltip'
import { parseRef } from '../../lib/refs'
import type { Block, SourceKind, SourcePage, SourceRecord, TranscriptHint } from '../../lib/types'
import { UNFOLD_EVENT } from '../find'
import { cellFill, markSegments, type LaneCell, type LaneTag, type RecordMarks, type Segment, type SpanMark } from '../labels'
import { useMarksAt } from '../marks'
import { LabelMark } from '../LabelMark'

export interface ViewProps {
  workspace: string
  path: string
  kind: SourceKind
  page: SourcePage
  loadMore: (dir: 'earlier' | 'later') => void
  /** scroll to and highlight when it changes: a ref pointing into `path` */
  targetRef?: string
  /** the server's sniff, when the file reads as a transcript */
  transcript?: TranscriptHint | null
}

export interface ViewDef {
  type: string
  title: string
  /** 0..1 how well the view fits: the path, the kind, up to 20 sample records, the server's transcript sniff */
  match: (path: string, kind: SourceKind, sample: any[], transcript?: TranscriptHint | null) => number
  component: ComponentType<ViewProps>
}

export interface Target {
  line: number
  endLine?: number
  block?: number
  start?: number
  end?: number
}

export function targetOf(ref: string | undefined, path: string): Target | null {
  const p = ref ? parseRef(ref) : null
  if (!p || !('path' in p) || p.path !== path) return null
  switch (p.kind) {
    case 'record':
      return { line: p.line }
    case 'range':
      return { line: p.line, endLine: p.endLine }
    case 'block':
      return { line: p.line, block: p.block }
    case 'span':
      return { line: p.line, block: p.block, start: p.start, end: p.end }
    default:
      return null
  }
}

export function isTargetLine(t: Target | null, line: number): boolean {
  return !!t && line >= t.line && line <= (t.endLine ?? t.line)
}

export function compact(v: unknown, max = 160): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function errMsg(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}

/** Whether the backend parses the file's lines as JSON records. */
export function isJsonlFile(path: string, kind: SourceKind): boolean {
  return kind === 'agent' || kind === 'board' || kind === 'events' || /\.jsonl$/i.test(path)
}

export function recordExcerpt(rec: SourceRecord): string {
  const first = rec.blocks?.[0]?.text
  const text = first ?? (typeof rec.record === 'string' ? rec.record : JSON.stringify(rec.record) ?? '')
  return text.slice(0, 500)
}

/** How long a followed ref's record keeps its highlight (.reader-hit in files.css fades over the same time). */
export const HIT_MS = 1500

/** Scroll to and highlight the target once its card exists under `rootRef`. */
export function useTarget(targetRef: string | undefined, path: string, rootRef: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  const target = useMemo(() => targetOf(targetRef, path), [targetRef, path])
  const [hit, setHit] = useState(false)
  const done = useRef<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!target || done.current === targetRef) return
    const root = rootRef.current
    if (!root) return
    const card = root.querySelector<HTMLElement>(`.reader-card[data-line="${target.line}"]`)
    if (!card) return
    const blockEl = target.block != null ? card.querySelector<HTMLElement>(`.reader-block[data-block="${target.block}"]`) : null
    // centre a span's highlight rather than its block, which may be much taller than the view; a view that draws no
        // blocks (Raw) marks the span in the record's line itself
    const place = () => ((blockEl ?? card).querySelector<HTMLElement>('.hl') ?? blockEl ?? card).scrollIntoView({ block: 'center' })
    place()
    // a record drawn again after the scroll (a long line's syntax colours arriving) moves the place: it is centred again
    // while the highlight lasts
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => card.isConnected && place())
      ro.observe(card)
      window.setTimeout(() => ro.disconnect(), HIT_MS)
    }
    done.current = targetRef
    setHit(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setHit(false), HIT_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, target, rootRef, ...deps])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return { target, hit }
}

interface RecordProps {
  path: string
  line: number
  target: Target | null
  hit: boolean
  className?: string
  header?: ReactNode
  /** the record's text for a thread's anchor_text (data-anchor-text), so a ⌘-click quotes the record, not its head */
  text?: string
  children?: ReactNode
}

/** The tint of a highlighted value with nothing to mark, as style. */
function markStyle(marks: RecordMarks): CSSProperties | undefined {
  return marks.tint ? ({ '--tint': marks.tint.colour } as CSSProperties) : undefined
}

/** What a gutter cell's hover says: the label's name and the record's class of it. */
export const cellTitle = (c: LaneCell): string => `${c.name}${c.values.length ? `: ${c.values.map((v) => v.value).join(', ')}` : ''}`

/** A record's label gutter at its left edge: a thin column per label that is on, in the order they were turned on,
 * filled with the record's class of that label, empty where it has none. */
export function LaneGutter({ cells }: { cells: readonly LaneCell[] }) {
  if (!cells.length) return null
  return (
    <span className="reader-gutter">
      {cells.map((c) => (
        <span key={c.id} className={'reader-gutter-cell' + (c.values.length ? ' is-lit' : '')} style={c.values.length ? { background: cellFill(c.values) } : undefined} title={cellTitle(c)} />
      ))}
    </span>
  )
}

/** The head of the records' label gutters, held at the top of the reader as it scrolls: each label's mark over its
 * column (a multi-class label's with its number), its name on hover. */
export function LaneHead({ tags }: { tags: readonly LaneTag[] }) {
  if (!tags.length) return null
  return (
    <div className="reader-lanehead">
      <div className="reader-lanehead-tags">
        {tags.map((t) => (
          <Tipped key={t.id} text={t.name} className="reader-lanehead-tag">
            <LabelMark multi={t.multi} colour={t.colour} on glyph={LANE_GLYPH_PX} n={t.n} />
          </Tipped>
        ))}
      </div>
    </div>
  )
}

/** px, a multi-class label's glyph over a gutter column or a Table dot column, one column's pitch (files.css
 * --lane-pitch) wide */
export const LANE_GLYPH_PX = 13

/** One record as a row: the label gutter, the line number, the head in mono, the blocks under it; a highlighted value
 * with nothing to mark as a tint behind the text. */
export function RecordCard({ path, line, target, hit, className, header, text, children }: RecordProps) {
  const isT = isTargetLine(target, line)
  const marks = useMarksAt(path, line)
  const cls = ['reader-card', 'reader-record', className, isT && 'reader-target', isT && hit && 'reader-hit', marks.cells.length && 'has-gutter', marks.tint && 'has-tint'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-line={line} data-anchor={`${path}#L${line}`} data-anchor-text={text || undefined} style={markStyle(marks)}>
      <LaneGutter cells={marks.cells} />
      <span className="reader-lineno mono">{line}</span>
      <div className="reader-record-main">
        {header != null && <div className="reader-record-head mono">{header}</div>}
        <div className="reader-record-body">{children}</div>
      </div>
    </div>
  )
}

/** One line of a line-oriented view (Raw, a text file): the label gutter, the line number, the text beside it, with
 * the same tint as a record. */
export function LineRow({ path, line, target, hit, className, children }: RecordProps) {
  const isT = isTargetLine(target, line)
  const marks = useMarksAt(path, line)
  const cls = ['reader-card', 'reader-line', className, isT && 'reader-target', isT && hit && 'reader-hit', marks.cells.length && 'has-gutter', marks.tint && 'has-tint'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-line={line} data-anchor={`${path}#L${line}`} style={markStyle(marks)}>
      <LaneGutter cells={marks.cells} />
      <span className="reader-lineno mono">{line}</span>
      <div className="reader-card-body">{children}</div>
    </div>
  )
}

interface Seg {
  text: string
  cls?: string
  /** a span label's mark on this piece */
  mark?: SpanMark
  /** where the piece starts in the block's text */
  start: number
}

/** Block text split into styled segments whose concatenation is the block text: the tool name, the ref's span
 * (`hl`), and the texts the labels that are on mark (`marks`). */
export function segmentsFor(block: Block, hl: [number, number] | null, marks: readonly SpanMark[] = [], find?: (span: string) => string[]): Seg[] {
  const text = block.text
  const cuts = new Set<number>([0, text.length])
  let toolEnd = -1
  if (block.kind === 'tool_use') {
    const i = text.indexOf('\n')
    toolEnd = i < 0 ? text.length : i
    cuts.add(toolEnd)
  }
  if (hl) {
    cuts.add(Math.max(0, Math.min(text.length, hl[0])))
    cuts.add(Math.max(0, Math.min(text.length, hl[1])))
  }
  const labelled = marks.length ? markSegments(text, marks, find) : [{ text, start: 0 } as Segment]
  for (const g of labelled) cuts.add(g.start)
  const points = [...cuts].sort((a, b) => a - b)
  const out: Seg[] = []
  let g = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (a === b) continue
    while (g < labelled.length - 1 && labelled[g + 1].start <= a) g++
    const cls = [toolEnd >= 0 && a < toolEnd ? 'reader-tool-name' : undefined, hl && a >= hl[0] && b <= hl[1] ? 'hl' : undefined].filter(Boolean).join(' ')
    out.push({ text: text.slice(a, b), cls: cls || undefined, mark: labelled[g].mark, start: a })
  }
  return out.length ? out : [{ text, start: 0 }]
}

/** The segments from offset `from` on: those before it dropped, the one it falls in cut at it. Pure. */
export function segmentsFrom(segs: Seg[], from: number): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    const end = s.start + s.text.length
    if (end <= from) continue
    out.push(s.start >= from ? s : { ...s, text: s.text.slice(from - s.start), start: from })
  }
  return out
}

interface BlockElProps {
  block: Block
  path?: string
  line: number
  index: number
  target: Target | null
  hit: boolean
  className?: string
  /** show the text from this offset on (a chat line's words after its speaker); anchors keep the whole text's offsets */
  from?: number
}

/** A piece of text a label marks: the focused label's colour at 24% behind it, another label's colour as a thin
 * underline; its own ⌘ anchor, the span. */
export function SpanEl({ seg, anchor, children }: { seg: Seg; anchor?: string; children: ReactNode }) {
  const m = seg.mark!
  return (
    <span className={'reader-span' + (m.under ? ' is-under' : '') + (seg.cls ? ` ${seg.cls}` : '')} style={{ '--c': m.colour } as CSSProperties} data-concept={m.concept} data-anchor={anchor} data-anchor-text={anchor ? seg.text : undefined}>
      {children}
    </span>
  )
}

/** One element per block, the text verbatim, with the texts the labels that are on mark highlighted. */
export function BlockEl({ block, path, line, index, target, hit, className, from = 0 }: BlockElProps) {
  const isT = !!target && target.line === line && target.block === index
  const hl: [number, number] | null = isT && target!.start != null && target!.end != null ? [target!.start, target!.end] : null
  const marks = useMarksAt(path ?? '', path ? line : 0)
  const segs = from > 0 ? segmentsFrom(segmentsFor(block, hl, path ? marks.spans : []), from) : segmentsFor(block, hl, path ? marks.spans : [])
  const cls = ['reader-block', `reader-${block.kind}`, className, isT && 'reader-target', isT && hit && 'reader-hit'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-line={line} data-block={index}>
      {segs.map((s, i) =>
        s.mark ? (
          <SpanEl key={i} seg={s} anchor={path ? `${path}#L${line}.b${index}:c${s.start}-${s.start + s.text.length}` : undefined}>
            {s.text}
          </SpanEl>
        ) : s.cls ? (
          <span key={i} className={s.cls}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </div>
  )
}

export const COLLAPSE_LINES = 6

/** A block folded to COLLAPSE_LINES lines while it is longer, with Expand and Collapse. It opens on UNFOLD_EVENT, which
 * the reader's find sends when its current match is inside. */
export function Collapsible({ lines, forced, children }: { lines: number; forced?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const unfold = () => setOpen(true)
    el.addEventListener(UNFOLD_EVENT, unfold)
    return () => el.removeEventListener(UNFOLD_EVENT, unfold)
  }, [])
  const long = lines > COLLAPSE_LINES
  const expanded = open || !!forced || !long
  return (
    <div ref={box} className={'reader-collapse' + (expanded ? '' : ' reader-collapsed')}>
      {children}
      {long && (
        <Button size="sm" className="reader-expand" onClick={() => setOpen((o) => !o)}>
          {expanded ? 'Collapse' : 'Expand'}
          {!expanded && <span className="dim">{lines} lines</span>}
        </Button>
      )}
    </div>
  )
}

export const lineCount = (s: string) => s.split('\n').length
