// The Raw view: the file verbatim, one monospace line per record, syntax-coloured when its language is known
// (files/highlight.ts: a code file highlighted over the lines loaded, a JSON lines file a record at a time), and the
// texts a span label marks highlighted where the line holds them (JSON-escaped in a JSON line), over the colours. The
// floor every file has.
import { Fragment, useMemo, useRef, type ReactNode } from 'react'
import type { SourceKind, SourceRecord } from '../../lib/types'
import { highlightLines, languageOf, MAX_LINE, piecesOf, renderTokens, useHljs, type Hljs, type Piece, type Token } from '../highlight'
import { jsonNeedles, markSegments, type Segment } from '../labels'
import { useMarksAt } from '../marks'
import { isJsonlFile, LineRow, SpanEl, useTarget, type Target, type ViewDef, type ViewProps } from './common'

// a terminal's escape sequences: CSI (`ESC [ … m`, colours and cursor moves), OSC (`ESC ] … BEL`, a window title), and the
// two-character ones (`ESC 7`, `ESC (B`); then the control characters left, but for the tab
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_0-9=>]/g
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/

/** A line of a terminal's log as it reads: its escape sequences and control characters gone (a tmux capture's colours,
 * cursor moves and title), so the words show rather than `ESC[?25h`. */
export function terminalText(line: string): string {
  return HAS_CONTROL.test(line) ? line.replace(ESCAPES, '').replace(CONTROLS, '') : line
}

/** A terminal's escape sequences alone taken out, for telling a log of them from a binary file (Reader looksBinary). */
export const withoutEscapes = (text: string): string => text.replace(ESCAPES, '')

export function rawLine(rec: SourceRecord, jsonl: boolean): string {
  const r = rec.record
  if (typeof r === 'string') return jsonl ? r : terminalText(r)
  if (!jsonl && r && typeof r === 'object' && typeof r.text === 'string') return terminalText(r.text)
  if (r && typeof r === 'object') {
    try {
      return JSON.stringify(r)
    } catch {
      return String(r)
    }
  }
  return String(r ?? '')
}

/** A JSON string's body as a file may write it: as JSON.stringify escapes it, and with every character past ASCII as a
 * `\uXXXX` escape besides (Python's json.dumps). */
function jsonForms(text: string): string[] {
  const plain = JSON.stringify(text).slice(1, -1)
  const ascii = plain.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return [...new Set([plain, ascii])]
}

/** Where a span ref's quoted characters sit in a record's raw line: at the block's own offsets when the block's text is
 * the line itself (a line of a text file, a JSON document on one line), else the first place the line holds the quote,
 * as written or, in a JSON line, as JSON escapes it. Null for another line, a ref with no characters, or a line that
 * does not hold the quote. Pure. */
export function rawSpan(rec: SourceRecord, text: string, target: Target | null, jsonl: boolean): [number, number] | null {
  if (!target || target.line !== rec.line || target.start == null || target.end == null || target.end <= target.start) return null
  const block = rec.blocks?.[target.block ?? 0]?.text
  if (block == null) return null
  if (block === text) return [target.start, Math.min(target.end, text.length)]
  const quote = block.slice(target.start, target.end)
  if (!quote.trim()) return null
  for (const form of jsonl ? [quote, ...jsonForms(quote)] : [quote]) {
    const i = text.indexOf(form)
    if (i >= 0) return [i, i + form.length]
  }
  return null
}

type RawSeg = Segment & { hl?: boolean }

/** A line's label segments cut again where the target's highlight starts and ends, those inside it flagged `hl`. Pure. */
export function withHighlight(segs: readonly Segment[], hl: [number, number] | null): RawSeg[] {
  if (!hl) return [...segs]
  const out: RawSeg[] = []
  for (const g of segs) {
    const end = g.start + g.text.length
    const cuts = [g.start, ...hl.filter((c) => c > g.start && c < end), end]
    for (let i = 0; i < cuts.length - 1; i++) {
      out.push({ text: g.text.slice(cuts[i] - g.start, cuts[i + 1] - g.start), mark: g.mark, start: cuts[i], hl: cuts[i] >= hl[0] && cuts[i + 1] <= hl[1] })
    }
  }
  return out
}

interface RawTextProps {
  path: string
  line: number
  text: string
  jsonl: boolean
  /** the line's tokens when the file was highlighted whole */
  tokens?: Token[] | null
  /** the highlighter, for a JSON line to highlight itself */
  hl: Hljs | null
  /** the characters a followed ref quotes, highlighted as a span target's are (.hl) */
  quoted?: [number, number] | null
}

function RawText({ path, line, text, jsonl, tokens, hl, quoted = null }: RawTextProps) {
  const marks = useMarksAt(path, line)
  const own = useMemo(() => (jsonl && hl ? highlightLines(hl, text, 'json', MAX_LINE)?.[0] ?? null : null), [jsonl, hl, text])
  const segs = withHighlight(markSegments(text, marks.spans, jsonl ? jsonNeedles : undefined), quoted)
  const toks = tokens ?? own
  const quote = (g: RawSeg, i: number, inner: ReactNode) =>
    g.hl ? (
      <span key={i} className="hl">
        {inner}
      </span>
    ) : (
      <Fragment key={i}>{inner}</Fragment>
    )
  if (!toks) {
    return <pre className="reader-rawview-pre">{segs.map((g, i) => quote(g, i, g.mark ? <SpanEl seg={g}>{g.text}</SpanEl> : g.text))}</pre>
  }
  // the colours cut at the label's segments, so a marked text keeps its syntax colours inside its highlight
  const groups: { seg: number; pieces: Piece[] }[] = []
  for (const p of piecesOf(toks, segs.map((g) => g.start))) {
    const last = groups[groups.length - 1]
    if (last && last.seg === p.seg) last.pieces.push(p)
    else groups.push({ seg: p.seg, pieces: [p] })
  }
  return (
    <pre className="reader-rawview-pre reader-code">
      {groups.map((g, i) => quote(segs[g.seg], i, segs[g.seg]?.mark ? <SpanEl seg={segs[g.seg]}>{renderTokens(g.pieces)}</SpanEl> : renderTokens(g.pieces)))}
    </pre>
  )
}

export function Raw({ path, kind, page, targetRef }: ViewProps) {
  const records = page.records
  const jsonl = isJsonlFile(path, kind)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  const texts = useMemo(() => records.map((rec) => rawLine(rec, jsonl)), [records, jsonl])
  // a script with no extension is known by its #! line, when the first line is loaded
  const lang = jsonl ? 'json' : languageOf(path, records[0]?.line === 1 ? texts[0] : undefined)
  const hl = useHljs(lang != null)
  // a code file is highlighted over every line loaded at once, so a docstring or a block comment keeps its colour on
  // each of its lines; a view that opens mid-file starts from the first line it loaded
  const whole = useMemo(() => {
    if (!hl || !lang || jsonl) return null
    const lines = highlightLines(hl, texts.join('\n'), lang)
    return lines && lines.length === texts.length ? lines : null
  }, [hl, lang, jsonl, texts])
  return (
    <div className="reader-rawview" ref={rootRef}>
      {records.map((rec, i) => (
        <LineRow key={rec.line} path={path} line={rec.line} target={target} hit={hit} className="reader-rawview-line">
          <RawText path={path} line={rec.line} text={texts[i]} jsonl={jsonl} tokens={whole?.[i]} hl={jsonl ? hl : null} quoted={rawSpan(rec, texts[i], target, jsonl)} />
        </LineRow>
      ))}
    </div>
  )
}

function match(_path: string, _kind: SourceKind): number {
  return 0.1
}

const def: ViewDef = { type: 'raw', title: 'Raw', match, component: Raw }
export default def
