// Renders kernel mime bundles: per bundle exactly one representation, chosen by PRIORITY. Vega-Lite charts reflow to
// their container, composites get fixed view widths from `fitWidth`, and a chart mounts only once its container has a
// box. thimble.diagram/timeline drawings are laid out by canvas/DataViz; a table card's DataFrame is drawn by
// canvas/FrameTable; a matplotlib SVG is inlined in the page's fonts and colours (lib/svg). A body that draws after it
// mounts says `data-settled` on its `data-body` root once drawn, which the card harness waits for.
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Fragment, memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Cell, Concept, MimeBundle, OutputTruncation } from '../lib/types'
import { frameStyle, frameTokens, useFrameFonts, withFrameStyle } from '../lib/frame'
import { useTheme } from '../lib/theme'
import { token } from '../lib/vizTheme'
import { useVisibleSize } from '../lib/visibleSize'
import { rehypeNumericCells } from '../lib/markdownCells'
import { tidyTable } from '../lib/tables'
import type { LabelClassColour } from '../lib/chartDefaults'
import { classesOf, colourToken } from '../files/labels'
import { DatasetView } from '../canvas/DataViz'
import { FrameTable } from '../canvas/FrameTable'
import { FRAME_MIME, asFrame } from '../lib/dataFrame'
import { inlineSvg } from '../lib/svg'
import { purifyHtml } from '../lib/sanitize'
import { specObject } from '../lib/vegaLoader'
import { drawChart, refitChart, type DrawnChart } from '../lib/vegaDraw'
import { failureText, loadChunk } from '../lib/chunkRecovery'
import { MdImage } from './MdImage'

// the chart drawing (lib/vegaDraw), which the view kit's charts share, named here too for what imports it from here
export {
  applyRefit,
  currentSchema,
  designedWidth,
  fitComposite,
  fixScaleBindings,
  hasLegend,
  hasScaleBinding,
  hiddenXLabels,
  labelTooltips,
  legendWrap,
  measureOverrun,
  MIN_X_LABEL_FONT,
  onPaper,
  refitChart,
  responsive,
  scaleWidths,
  unroundClippedBars,
  usesContainerWidth,
  wrapTitle,
  wrapTitleText,
  xLabelsFit,
} from '../lib/vegaDraw'
export type { HiddenX, Overrun, Refit, RefitView, XLabels } from '../lib/vegaDraw'

export const ERROR_MIME = 'application/vnd.thimble.error+json'
export const isVegaLite = (mime: string) => /^application\/vnd\.vegalite\.v[456][+.]json$/.test(mime)
/** The drawings the canvas makes from a card's code, by the card kind that shows each (backend tools.DRAWING_MIMES). */
export const DRAWING_MIMES: Record<string, 'diagram' | 'timeline'> = {
  'application/vnd.thimble.diagram+json': 'diagram',
  'application/vnd.thimble.timeline+json': 'timeline',
}
export const isDrawing = (mime: string) => Object.prototype.hasOwnProperty.call(DRAWING_MIMES, mime)
/** A card type's graphic (backend cardtypes.py), which a card draws in the type's frame (canvas/TypeCard) and any other
 * place shows as its listing. */
export const CARD_MIME = 'application/vnd.thimble.card+json'
// raster images: a PNG, and a JPEG, GIF or WebP a card displays as it is (IPython's Image of a photo or a screen grab)
const RASTER = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const PRIORITY: (string | ((mime: string) => boolean))[] = [isDrawing, FRAME_MIME, 'image/svg+xml', ...RASTER, isVegaLite, 'text/html', 'text/markdown', 'application/json', 'text/plain']

export function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('')
  if (v == null) return ''
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
export const stripAnsi = (s: string) => s.replace(ANSI, '')

/** The first `max` lines of `s`; a trailing "…" line marks a cut. */
export function capLines(s: string, max: number): string {
  const lines = s.replace(/\n$/, '').split('\n')
  if (lines.length <= max) return s
  return lines.slice(0, max).join('\n') + '\n…'
}

/** The line of the complete output that line `i` (from 0) of a stored text stands for, from 1, as `@out<i>#L<n>` refs
 * number them (backend refs._resolve_cell): its place, or for a bounded stream (notebook._bound_stream) past the marker
 * the line it kept from the end; null for the marker itself. Pure. */
export function storedLineNumber(i: number, truncated?: OutputTruncation | null): number | null {
  if (!truncated || i < truncated.kept_head) return i + 1
  if (i === truncated.kept_head) return null
  return truncated.total_lines - truncated.kept_tail + (i - truncated.kept_head)
}

/** Whether a bounded stream left line `line` out of its stored text, so only its complete text has it. Pure. */
export const lineOmitted = (truncated: OutputTruncation | null | undefined, line: number): boolean =>
  !!truncated && line > truncated.kept_head && line <= truncated.total_lines - truncated.kept_tail

/**
 * An output's text as it prints, each line in a span that carries the output line it stands for (`data-line`,
 * storedLineNumber), where a citation of the line finds it (lib/tableCell revealLines). `max` shows the first lines
 * only, with a trailing "…" line, as capLines does.
 */
export const OutputText = memo(function OutputText({ text, max, truncated }: { text: string; max?: number; truncated?: OutputTruncation | null }) {
  const end = text.endsWith('\n')
  const lines = (end ? text.slice(0, -1) : text).split('\n')
  const capped = !!max && lines.length > max
  const shown = capped ? lines.slice(0, max) : lines
  return (
    <>
      {shown.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          <span data-line={storedLineNumber(i, truncated) ?? undefined}>{l}</span>
        </Fragment>
      ))}
      {capped ? '\n…' : end ? '\n' : null}
    </>
  )
})

export const isStream = (b: MimeBundle) => !!b && typeof b === 'object' && '_stream' in b
export const isError = (b: MimeBundle) => !!b && typeof b === 'object' && ERROR_MIME in b

/** The one bundle a collapsed cell shows: the last display result, else the last stream, else the last error. */
export function primaryOutput(outputs: MimeBundle[]): MimeBundle | null {
  const list = (outputs ?? []).filter((b) => b && typeof b === 'object')
  const last = (pred: (b: MimeBundle) => boolean) => {
    for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i]
    return null
  }
  return last((b) => !isStream(b) && !isError(b)) ?? last(isStream) ?? last(isError)
}

export function pickMime(b: MimeBundle): string | null {
  if (!b || typeof b !== 'object') return null
  if (ERROR_MIME in b) return ERROR_MIME
  const keys = Object.keys(b)
  for (const p of PRIORITY) {
    const hit = typeof p === 'string' ? (p in b ? p : undefined) : keys.find((k) => p(k))
    if (hit !== undefined) return hit
  }
  return null
}

type ArtifactKind = 'chart' | 'table' | 'error' | 'shell' | 'other'
const isChart = (b: MimeBundle) => {
  const m = pickMime(b)
  return (!!m && (m.startsWith('image/') || isVegaLite(m) || isDrawing(m))) || (!!b && typeof b === 'object' && CARD_MIME in b)
}
const isTable = (b: MimeBundle) => pickMime(b) === FRAME_MIME || (pickMime(b) === 'text/html' && /<table\b/i.test(asText(b['text/html'])))

/** The one bundle a card shows: a chart, else a table, else an error, else the last shell stream, else the primary output. */
export function primaryArtifact(outputs: MimeBundle[] | undefined): { bundle: MimeBundle; kind: ArtifactKind } | null {
  const list = (outputs ?? []).filter((b) => b && typeof b === 'object')
  const chart = list.find(isChart)
  if (chart) return { bundle: chart, kind: 'chart' }
  const table = list.find(isTable)
  if (table) return { bundle: table, kind: 'table' }
  const error = list.find(isError)
  if (error) return { bundle: error, kind: 'error' }
  const shell = [...list].reverse().find(isStream)
  if (shell) return { bundle: shell, kind: 'shell' }
  const other = primaryOutput(list)
  return other ? { bundle: other, kind: 'other' } : null
}

/** What a card draws that a document can show as a figure (backend material.figure_kind). */
export type FigureKind = 'chart' | 'table' | 'timeline' | 'diagram' | 'custom'

/** What a card draws that a document can show as a figure: a timeline or a diagram, from its code's drawing or from its
 * dataset; a chart (an image, a Vega-Lite spec or a card type's graphic); a table; a custom card's page. Null for a card
 * that draws none: a note, an example, a label, or code that only printed (backend material.figure_kind). */
export function figureKind(cell: Pick<Cell, 'kind' | 'code' | 'payload' | 'outputs'>): FigureKind | null {
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  if ((cell.kind === 'timeline' || cell.kind === 'diagram') && !cell.code && payload.dataset != null) return cell.kind
  if (cell.kind === 'custom') return typeof payload.html === 'string' && payload.html.trim() ? 'custom' : null
  const art = primaryArtifact(cell.outputs)
  if (art?.kind === 'chart') {
    const mime = pickMime(art.bundle)
    return mime && isDrawing(mime) ? DRAWING_MIMES[mime] : 'chart'
  }
  return art?.kind === 'table' ? 'table' : null
}

/** The `@out<i>` index a card's output answers to in a ref: its `_out` when it carries one, else its place among the
 * card's outputs (backend cite.output_index). */
export const outIndex = (outputs: MimeBundle[] | undefined, bundle: MimeBundle): number => (typeof bundle._out === 'number' && bundle._out >= 0 ? bundle._out : (outputs ?? []).indexOf(bundle))

const MD_REHYPE = [rehypeNumericCells]
// a markdown output loads no image from another host (components/MdImage)
const MD_COMPONENTS: Components = { img: MdImage }

export function Outputs({ outputs }: { outputs: MimeBundle[] }) {
  if (!outputs?.length) return null
  return (
    <div className="outputs">
      {outputs.map((b, i) => (
        <Output key={i} bundle={b} />
      ))}
    </div>
  )
}

export default Outputs

/** The labels a card uses, as a chart reads their classes' colours (lib/chartDefaults labelColours). */
export type ChartLabels = readonly Pick<Concept, 'labels' | 'classes'>[]

/** The labels `ids` names that `concepts` holds, in order. */
export const chartLabels = (ids: readonly string[] | undefined, concepts: ReadonlyMap<string, Pick<Concept, 'labels' | 'classes'>>): ChartLabels =>
  (ids ?? []).flatMap((id) => (concepts.has(id) ? [concepts.get(id)!] : []))

/**
 * One bundle. `maxLines` caps text; `maxRows` caps an html table behind "Show all"; `fitWidth` is the room a chart has;
 * `card` drops a chart's own title under a card's question; `labels` colour a chart's classes by label.
 */
export function Output({ bundle, maxLines, maxRows, fitWidth, card, labels }: { bundle: MimeBundle; maxLines?: number; maxRows?: number; fitWidth?: number; card?: boolean; labels?: ChartLabels }) {
  const cap = (s: string) => (maxLines ? capLines(s, maxLines) : s)
  const mime = pickMime(bundle)
  if (mime === ERROR_MIME) return <ErrorOut err={bundle[ERROR_MIME]} maxLines={maxLines} />
  if (mime === null) {
    const keys = Object.keys(bundle ?? {}).filter((k) => !k.startsWith('_'))
    if (!keys.length) return null
    return (
      <pre className="outputs-text outputs-unknown" title={keys.join(', ')}>
        {cap(JSON.stringify(bundle, null, 2).slice(0, 2000))}
      </pre>
    )
  }
  const data = bundle[mime]
  if (isDrawing(mime)) return <DatasetView kind={DRAWING_MIMES[mime]} dataset={data} fitWidth={fitWidth} />
  if (mime === FRAME_MIME) {
    const frame = asFrame(data)
    return frame ? <FrameTable frame={frame} /> : <pre className="outputs-text">{cap(asText(bundle['text/plain']))}</pre>
  }
  switch (mime) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return <Raster src={`data:${mime};base64,${asText(data).replace(/\s+/g, '')}`} />
    case 'image/svg+xml':
      return <InlineSvg svg={asText(data)} />
    case 'text/html':
      return <Html html={asText(data)} maxRows={maxRows} />
    case 'text/markdown':
      return (
        <div className="outputs-md">
          <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} rehypePlugins={MD_REHYPE} components={MD_COMPONENTS}>
            {asText(data)}
          </ReactMarkdown>
        </div>
      )
    case 'application/json':
      return <pre className="outputs-text outputs-json">{cap(typeof data === 'string' ? data : JSON.stringify(data, null, 2))}</pre>
    case 'text/plain': {
      const stream = bundle._stream
      const cls = stream ? `outputs-text outputs-stream${stream === 'stderr' ? ' outputs-stderr' : ''}` : 'outputs-text'
      return (
        <pre className={cls}>
          <OutputText text={asText(data)} max={maxLines} truncated={bundle.truncated} />
        </pre>
      )
    }
    default:
      return isVegaLite(mime) ? <Vega spec={data} fitWidth={fitWidth} card={card} labels={labels} /> : null
  }
}

/** Rows of the first html table's body. */
export function tableRowCount(html: string): number {
  if (!/<table\b/i.test(html)) return 0
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(html)
  if (body) return (body[1].match(/<tr\b/gi) ?? []).length
  const all = (html.match(/<tr\b/gi) ?? []).length
  const head = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(html)
  return Math.max(0, all - (head ? (head[1].match(/<tr\b/gi) ?? []).length : 0))
}

export const CAP_SLACK = 5
export const rowsCapped = (rows: number, maxRows: number | undefined): boolean => !!maxRows && maxRows > 0 && rows >= maxRows + CAP_SLACK

/** A cell whose text is a number (a count, a share, a signed value): it reads right-aligned. */
const NUM_CELL = /^[-+\u2212]?(?=.*\d)[\d,.\s]*%?$/
export const isNumericCell = (text: string): boolean => NUM_CELL.test(text.trim())

/**
 * Html with script runs in a sandboxed iframe (HtmlFrame); any other is sanitized (lib/sanitize) and inlined, a long
 * table capped at `maxRows`. Tables are tidied (lib/tables), numeric cells right-aligned, and a table wider than its
 * room scrolls sideways with a fade at the right.
 */
function Html({ html, maxRows }: { html: string; maxRows?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [more, setMore] = useState(false)
  const scripted = /<script\b/i.test(html)
  const safe = useMemo(() => (scripted ? '' : purifyHtml(html)), [html, scripted])
  const inner = useMemo(() => ({ __html: safe }), [safe])
  const rows = tableRowCount(safe)
  const capped = rowsCapped(rows, maxRows) && !expanded
  const cap = maxRows ?? 0
  useLayoutEffect(() => {
    const el = box.current
    if (!el || scripted) return
    if (rows) {
      el.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr, i) => {
        tr.hidden = capped && i >= cap
      })
      el.querySelectorAll<HTMLTableCellElement>('tbody td').forEach((td) => td.classList.toggle('outputs-num', isNumericCell(td.getAttribute('data-raw') ?? td.textContent ?? '')))
      el.querySelectorAll<HTMLTableElement>('table').forEach(tidyTable)
    }
    const check = () => setMore(el.scrollWidth - el.scrollLeft > el.clientWidth + 1)
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', check)
      ro?.disconnect()
    }
  }, [safe, capped, cap, rows, scripted])
  if (scripted) return <HtmlFrame html={html} />
  const table = rows > 0 || /<table\b/i.test(safe)
  const cls = `outputs-html${table ? ' outputs-html-table' : ''}${capped ? ' outputs-html-capped' : ''}`
  return (
    <>
      <div className={`outputs-html-wrap${more ? ' outputs-html-more' : ''}`}>
        <div className={cls} ref={box} dangerouslySetInnerHTML={inner} />
      </div>
      {rowsCapped(rows, maxRows) && (
        <div className="outputs-rows-more">
          <button type="button" className="outputs-showall" onClick={() => setExpanded((v) => !v)}>
            {capped ? `Show all ${rows.toLocaleString()} rows` : `Show the first ${cap.toLocaleString()} rows`}
          </button>
        </div>
      )}
    </>
  )
}

/** A raster image as it is, at most its own size; drawn once it has loaded. */
function Raster({ src }: { src: string }) {
  const [done, setDone] = useState(false)
  return <img className="outputs-img" alt="" src={src} data-body="" data-settled={done ? 'true' : 'false'} onLoad={() => setDone(true)} onError={() => setDone(true)} />
}

/**
 * A figure's SVG inlined (lib/svg: made safe, its ids its own, its text in the page's faces and its colours the
 * theme's), as wide as the room up to its own width. A document that does not parse is shown as an image.
 */
function InlineSvg({ svg }: { svg: string }) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const fig = useMemo(() => inlineSvg(svg, `f${id}-`), [svg, id])
  if (!fig) return <Raster src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />
  return <div className="outputs-svg" style={fig.width ? { maxWidth: fig.width } : undefined} data-body="" data-settled="true" dangerouslySetInnerHTML={{ __html: fig.markup }} />
}

/** What the canvas keeps of a chart it drew: the drawing (lib/vegaDraw), and what it was drawn from, so a resize with
 * nothing else changed only refits it. */
type Embedded = DrawnChart & { spec: unknown; fitWidth: number | undefined; theme: string; colours: string }

/** One chart: embeds once its container has a box, drawn as lib/vegaDraw draws every chart (a card's defaults, fitted
 * to its box, on the paper of what shows it, measured and refitted); re-fits when the box changes and re-embeds when
 * the theme or label colours change. */
function Vega({ spec, fitWidth, card, labels }: { spec: unknown; fitWidth?: number; card?: boolean; labels?: ChartLabels }) {
  const ref = useRef<HTMLDivElement>(null)
  // the labels' classes as a string, so a new list of the same labels embeds nothing again and a changed colour does
  const colours = JSON.stringify((labels ?? []).map((k) => classesOf(k).map((c) => [c.name, c.color ?? 0])))
  const [error, setError] = useState<string | null>(null)
  // drawn: the embed and its refits are done, for the card harness (module note)
  const [drawn, setDrawn] = useState(false)
  const { width } = useVisibleSize(ref)
  const { key: theme } = useTheme()
  const live = useRef<Embedded | null>(null)
  // a spec that is no plain object is refused before vega-embed sees it (lib/vegaLoader specObject)
  const plain = useMemo(() => specObject(spec), [spec])
  useEffect(() => {
    const el = ref.current
    if (!el || width <= 0 || !plain) return
    const cur = live.current
    if (cur && cur.spec === spec && cur.fitWidth === fitWidth && cur.theme === theme && cur.colours === colours) {
      refitChart(cur.view, el, cur.container)
      return
    }
    let alive = true
    setError(null)
    setDrawn(false)
    // the label colours are read per theme
    const classes = (JSON.parse(colours) as [string, number][][]).map((k): LabelClassColour[] => k.map(([name, n]) => ({ name, colour: token(colourToken(n)), none: !n })))
    drawChart(el, plain, () => loadChunk(() => import('vega-embed')), {
      fitWidth,
      card,
      labels: classes,
      alive: () => alive,
      replace: () => {
        live.current?.finalize()
        live.current = null
      },
      drawn: (d) => {
        live.current = { ...d, spec, fitWidth, theme, colours }
      },
    })
      .then(() => alive && setDrawn(true))
      .catch((e) => {
        if (!alive) return
        setError(failureText(e))
        setDrawn(true)
      })
    return () => {
      alive = false
    }
  }, [spec, plain, fitWidth, width, theme, card, colours])
  useEffect(
    () => () => {
      live.current?.finalize()
      live.current = null
    },
    [],
  )
  return (
    <div className="outputs-vega-wrap" data-body="" data-settled={drawn || !plain ? 'true' : 'false'}>
      <div className="outputs-vega" ref={ref} />
      {!plain && <pre className="outputs-text outputs-error">Chart failed: the chart spec is not a JSON object</pre>}
      {plain && error && <pre className="outputs-text outputs-error">Chart failed: {error}</pre>}
    </div>
  )
}

function ErrorOut({ err, maxLines }: { err: any; maxLines?: number }) {
  const ename = String(err?.ename ?? 'Error')
  const evalue = String(err?.evalue ?? '')
  let tb: string[] = Array.isArray(err?.traceback) ? err.traceback.map((l: unknown) => stripAnsi(asText(l))) : []
  if (maxLines) {
    const body = capLines(tb.join('\n'), Math.max(1, maxLines - 1))
    tb = body ? [body] : []
  }
  return (
    <pre className="outputs-text outputs-error">
      <span className="outputs-error-head">
        {ename}
        {evalue ? `: ${evalue}` : ''}
      </span>
      {tb.length ? '\n' + tb.join('\n') : ''}
    </pre>
  )
}

/** A scripted html output in a sandboxed frame, painted on the card in the page's theme. */
function HtmlFrame({ html }: { html: string }) {
  const { resolved, key } = useTheme()
  const fonts = useFrameFonts()
  // key: the tokens are read again when the paper or the accent changes; the frame waits for the page's faces
  const doc = useMemo(() => (fonts == null ? null : withFrameStyle(html, frameStyle(resolved, frameTokens(), fonts))), [html, resolved, key, fonts])
  const [loaded, setLoaded] = useState(false)
  return doc == null ? null : <iframe className="outputs-iframe" sandbox="allow-scripts" srcDoc={doc} title="html output" data-body="" data-settled={loaded ? 'true' : 'false'} onLoad={() => setLoaded(true)} />
}
