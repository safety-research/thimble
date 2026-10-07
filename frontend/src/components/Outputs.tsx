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
import { inkPair, token, vegaConfig, VIZ_NEUTRAL, VIZ_SERIES } from '../lib/vizTheme'
import { useVisibleSize } from '../lib/visibleSize'
import { rehypeNumericCells } from '../lib/markdownCells'
import { tidyTable } from '../lib/tables'
import { chartDefaults, legendAtRight, type LabelClassColour } from '../lib/chartDefaults'
import { classesOf, colourToken } from '../files/labels'
import { DatasetView } from '../canvas/DataViz'
import { FrameTable } from '../canvas/FrameTable'
import { FRAME_MIME, asFrame } from '../lib/dataFrame'
import { inlineSvg } from '../lib/svg'
import { purifyHtml } from '../lib/sanitize'
import { dataOnly, specObject, withoutEmbedOptions } from '../lib/vegaLoader'
import { failureText, loadChunk } from '../lib/chunkRecovery'
import { MdImage } from './MdImage'

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

type Spec = Record<string, unknown>
const obj = (v: unknown): Spec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Spec) : null)

function isComposite(s: Spec): boolean {
  const enc = obj(s.encoding) ?? {}
  return 'facet' in s || 'hconcat' in s || 'vconcat' in s || 'concat' in s || 'repeat' in s || 'facet' in enc || 'column' in enc || 'row' in enc
}

/** An older Vega-Lite `$schema` (v4, v5) names the current major, which compiles it the same, so vega-embed does not
 * warn about the version on every render. */
export function currentSchema(schema: string): string {
  return schema.replace(/\/vega-lite\/v[45](?:\.[\d.]+)?\.json$/, '/vega-lite/v6.json')
}

/** Make a Vega-Lite spec fill the room it is shown in; other specs are untouched. `minView` is the narrowest view a
 * composite's views may take (the refit after a measured overflow goes below the default). */
export function responsive(spec: unknown, fitWidth?: number, minView: number = MIN_VIEW): unknown {
  const s0 = obj(spec)
  if (!s0) return spec
  const isVL = typeof s0.$schema === 'string' && s0.$schema.includes('vega-lite')
  if (!isVL) return spec
  const s = unroundClippedBars(fixScaleBindings(wrapTitle({ ...s0, $schema: currentSchema(s0.$schema as string) }, fitWidth)))
  if (!isComposite(s)) return { ...s, width: 'container', autosize: s.autosize ?? { type: 'fit-x', contains: 'padding' } }
  return fitWidth && fitWidth > 0 ? fitComposite(s, fitWidth, s, minView) : s
}

/** A chart sits on the paper of whatever shows it: a background the spec sets goes transparent and a fill of the plot's
 * view is dropped. vegaConfig's transparent background alone is not enough, since a spec's own setting wins over the
 * config vega-embed is handed. */
export function onPaper(spec: unknown): unknown {
  const s = obj(spec)
  if (!s) return spec
  const config = obj(s.config)
  const view = config ? obj(config.view) : null
  let nextConfig = config
  if (config) {
    nextConfig = { ...config, background: 'transparent' }
    if (view && 'fill' in view) {
      const { fill: _fill, ...rest } = view
      nextConfig.view = rest
    }
  }
  return { ...s, background: 'transparent', ...(nextConfig ? { config: nextConfig } : {}) }
}

const COLOR_CHANNELS = ['color', 'fill', 'stroke']

/**
 * One or two nominal groups take the ink ramp, not colour (`ramp`); the nominal hues are for three or more. A spec
 * that names its own range or scheme, or whose cardinality cannot be read, is left alone.
 */
export function inkSmallNominal(spec: unknown, ramp: readonly string[]): unknown {
  const s = obj(spec)
  const enc = s ? obj(s.encoding) : null
  if (!s || !enc) return spec
  for (const ch of COLOR_CHANNELS) {
    const def = obj(enc[ch])
    if (!def || typeof def.field !== 'string' || (def.type ?? 'nominal') !== 'nominal') continue
    const scale = obj(def.scale) ?? {}
    if ('range' in scale || 'scheme' in scale || scale.domain != null) continue
    const n = cardinality(def, s, s)
    if (n == null || n > ramp.length) continue
    return { ...s, encoding: { ...enc, [ch]: { ...def, scale: { ...scale, range: ramp.slice(0, n) } } } }
  }
  return spec
}

const CORNER_PROPS = ['cornerRadius', 'cornerRadiusEnd', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomLeft', 'cornerRadiusBottomRight']

export function hasScaleBinding(s: Spec): boolean {
  const params = Array.isArray(s.params) ? s.params : []
  if (params.some((p) => obj(p)?.bind === 'scales')) return true
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    const list = s[key]
    if (Array.isArray(list) && list.some((c) => { const cs = obj(c); return !!cs && hasScaleBinding(cs) })) return true
  }
  const inner = obj(s.spec)
  return !!inner && hasScaleBinding(inner)
}

/** A clipped bar mark loses the theme's rounded ends, which Vega-Lite would otherwise clip to nothing. */
export function unroundClippedBars(s: Spec, bound: boolean = hasScaleBinding(s)): Spec {
  let out = s
  const m = typeof s.mark === 'string' ? { type: s.mark } : obj(s.mark)
  if (m && m.type === 'bar' && (m.clip === true || (bound && m.clip !== false)) && !CORNER_PROPS.some((k) => k in m)) {
    out = { ...out, mark: { ...m, cornerRadiusEnd: 0 } }
  }
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    const list = s[key]
    if (!Array.isArray(list)) continue
    const mapped = list.map((c) => { const cs = obj(c); return cs ? unroundClippedBars(cs, bound) : c })
    if (mapped.some((c, i) => c !== list[i])) out = { ...out, [key]: mapped }
  }
  const inner = obj(s.spec)
  if (inner) {
    const fixed = unroundClippedBars(inner, bound)
    if (fixed !== inner) out = { ...out, spec: fixed }
  }
  return out
}

const CONTINUOUS = new Set(['quantitative', 'temporal'])

function channelType(s: Spec, channel: string): string | undefined {
  const own = obj(obj(s.encoding)?.[channel])
  if (own) return typeof own.type === 'string' ? own.type : own.timeUnit ? 'temporal' : own.bin ? 'binned' : undefined
  const layers = Array.isArray(s.layer) ? s.layer : []
  for (const l of layers) {
    const ls = obj(l)
    const t = ls ? channelType(ls, channel) : undefined
    if (t) return t
  }
  return undefined
}

/** A scale binding on a discrete channel keeps only its continuous channels, so the chart still draws. */
export function fixScaleBindings(s: Spec): Spec {
  const params = Array.isArray(s.params) ? s.params : null
  if (!params) return s
  let changed = false
  const out: unknown[] = []
  for (const p of params) {
    const ps = obj(p)
    const sel = ps ? obj(ps.select) : null
    if (!ps || !sel || ps.bind !== 'scales' || sel.type !== 'interval') {
      out.push(p)
      continue
    }
    const wanted = Array.isArray(sel.encodings) ? sel.encodings.filter((c): c is string => typeof c === 'string') : ['x', 'y']
    const known = wanted.filter((c) => channelType(s, c) !== undefined)
    const keep = known.filter((c) => CONTINUOUS.has(channelType(s, c) ?? ''))
    if (known.length === 0 || keep.length === known.length) {
      out.push(p)
      continue
    }
    changed = true
    if (keep.length) out.push({ ...ps, select: { ...sel, encodings: keep } })
  }
  return changed ? { ...s, params: out } : s
}

const TITLE_CHAR_PX = 8
const TITLE_DEFAULT_CHARS = 90

export function wrapTitleText(text: string, chars: number): string[] {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > chars) {
      lines.push(cur)
      cur = w
    } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push(cur)
  return lines
}

export function wrapTitle(s: Spec, fitWidth?: number): Spec {
  const chars = fitWidth && fitWidth > 0 ? Math.max(24, Math.floor(fitWidth / TITLE_CHAR_PX)) : TITLE_DEFAULT_CHARS
  const wrap = (v: unknown): unknown => (typeof v === 'string' && v.length > chars ? wrapTitleText(v, chars) : v)
  const t = s.title
  if (typeof t === 'string') {
    const lines = wrap(t)
    return Array.isArray(lines) ? { ...s, title: { text: lines, frame: 'bounds' } } : s
  }
  const to = obj(t)
  if (to && (typeof to.text === 'string' || typeof to.subtitle === 'string')) {
    const text = wrap(to.text)
    const subtitle = wrap(to.subtitle)
    if (text !== to.text || subtitle !== to.subtitle) {
      return { ...s, title: { frame: 'bounds', ...to, ...(text !== to.text ? { text } : {}), ...(subtitle !== to.subtitle ? { subtitle } : {}) } }
    }
  }
  return s
}

const MIN_VIEW = 160
const CHROME = 120
/** the room a part of a composite takes for its own axis */
const CHROME_NESTED = 56
/** a composite laid out narrower than the room grows to fill it, up to this many times its own width */
const MAX_UPSCALE = 2
const LEGEND_ROOM = 130
const VIEW_GAP = 20
const DEFAULT_COLS = 3
/** the narrowest view the refit after a measured overflow may give a composite's views */
const MIN_VIEW_REFIT = 40
const perView = (w: number, cols: number, chrome: number = CHROME, min: number = MIN_VIEW) => Math.max(min, Math.floor((w - chrome) / Math.max(1, cols)) - VIEW_GAP)
const LEGEND_CHANNELS = ['color', 'fill', 'stroke', 'shape', 'size', 'opacity', 'strokeDash', 'strokeWidth']

export function hasLegend(s: Spec): boolean {
  const enc = obj(s.encoding)
  if (enc)
    for (const ch of LEGEND_CHANNELS) {
      const def = obj(enc[ch])
      if (def && (typeof def.field === 'string' || def.aggregate != null) && def.legend !== null) return true
    }
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    const list = s[key]
    if (Array.isArray(list) && list.some((c) => { const cs = obj(c); return !!cs && hasLegend(cs) })) return true
  }
  const inner = obj(s.spec)
  return !!inner && hasLegend(inner)
}

/** A composite's width as its spec lays it out, when every view in it names its width: the views side by side summed
 * with their gaps, the views one over another at the widest, a facet's view times its columns; and the y axes that sit
 * side by side in it. Null when a view leaves its width to the default. */
export function designedWidth(s: Spec, root: Spec): { natural: number; axes: number } | null {
  const { hconcat, vconcat } = s
  if (Array.isArray(hconcat)) {
    const parts = hconcat.map((c) => (obj(c) ? designedWidth(obj(c)!, root) : null))
    if (parts.some((p) => !p)) return null
    return { natural: parts.reduce((a, p) => a + p!.natural, 0) + (parts.length - 1) * VIEW_GAP, axes: parts.reduce((a, p) => a + p!.axes, 0) }
  }
  if (Array.isArray(vconcat)) {
    const parts = vconcat.map((c) => (obj(c) ? designedWidth(obj(c)!, root) : null))
    if (parts.some((p) => !p)) return null
    return { natural: Math.max(...parts.map((p) => p!.natural)), axes: Math.max(...parts.map((p) => p!.axes)) }
  }
  if ('concat' in s || 'repeat' in s) return null
  const inner = obj(s.spec)
  if (inner) {
    const one = designedWidth(inner, root)
    if (!one) return null
    const cols = layoutColumns(s, root)
    return { natural: one.natural * cols + (cols - 1) * VIEW_GAP, axes: one.axes }
  }
  if (typeof s.width !== 'number' || s.width <= 0) return null
  const enc = obj(s.encoding) ?? {}
  const cols = enc.column != null || enc.facet != null ? layoutColumns(s, root) : 1
  return { natural: s.width * cols + (cols - 1) * VIEW_GAP, axes: 1 }
}

/** Every view width in a composite times `k` (none under `min`), a facet's column headers cut to their view, and a
 * part's own title wrapped to its view (a title wider than its view widens the part, which scaling the views does not
 * undo). */
export function scaleWidths(s: Spec, k: number, min: number): Spec {
  const out: Spec = { ...s }
  for (const key of ['hconcat', 'vconcat']) {
    const list = s[key]
    if (Array.isArray(list)) out[key] = list.map((c) => (obj(c) ? scaleWidths(obj(c)!, k, min) : c))
  }
  const inner = obj(s.spec)
  if (inner) out.spec = scaleWidths(inner, k, min)
  if (typeof s.width === 'number') Object.assign(out, withViewWidth(out, Math.max(min, Math.floor(s.width * k))))
  const view = (inner && typeof out.spec === 'object' ? (out.spec as Spec).width : out.width) as number | undefined
  if (typeof view === 'number' && typeof s.title === 'string') {
    const lines = wrapTitleText(s.title, Math.max(12, Math.floor(view / TITLE_CHAR_PX)))
    if (lines.length > 1) out.title = { text: lines, frame: 'bounds' }
  }
  const facet = obj(s.facet)
  const col = facet ? obj(facet.column) : null
  if (facet && col && typeof view === 'number') out.facet = { ...facet, column: { ...col, header: { labelLimit: view, ...(obj(col.header) ?? {}) } } }
  const enc = obj(s.encoding)
  const ecol = enc ? obj(enc.column) : null
  if (enc && ecol && typeof view === 'number') out.encoding = { ...enc, column: { ...ecol, header: { labelLimit: view, ...(obj(ecol.header) ?? {}) } } }
  return out
}

const POSITION_X = ['x', 'x2']

/** A view at `width` px wide, with every x position it or its layers name in px (`x: {value: 640}`, as a label at the
 * designed right edge) scaled with it, so a mark at the old right edge stays at the new one. */
function withViewWidth(s: Spec, width: number): Spec {
  const from = typeof s.width === 'number' && s.width > 0 ? s.width : null
  const out: Spec = { ...s, width }
  return from && from !== width ? scaleXValues(out, width / from) : out
}

function scaleXValues(s: Spec, k: number): Spec {
  const out: Spec = { ...s }
  const enc = obj(s.encoding)
  if (enc) {
    let next: Spec | null = null
    for (const ch of POSITION_X) {
      const def = obj(enc[ch])
      if (def && typeof def.value === 'number') (next ??= { ...enc })[ch] = { ...def, value: Math.round(def.value * k) }
    }
    if (next) out.encoding = next
  }
  const mark = obj(s.mark)
  if (mark && POSITION_X.some((ch) => typeof mark[ch] === 'number')) {
    const m: Spec = { ...mark }
    for (const ch of POSITION_X) if (typeof mark[ch] === 'number') m[ch] = Math.round((mark[ch] as number) * k)
    out.mark = m
  }
  if (Array.isArray(s.layer)) out.layer = s.layer.map((l) => (obj(l) ? scaleXValues(obj(l)!, k) : l))
  return out
}

/** Fixed view widths for a composite spec so its views together fill `w`. A spec that names every view's width is
 * scaled as a whole, keeping its proportions; otherwise each view takes an equal share, none narrower than `min`. */
export function fitComposite(s: Spec, w: number, root: Spec, min: number = MIN_VIEW): Spec {
  const legendRoom = hasLegend(root) && legendAtRight(root) ? LEGEND_ROOM : 0
  if (s === root) {
    const designed = designedWidth(s, root)
    if (designed && designed.natural > 0) {
      const k = (w - designed.axes * CHROME_NESTED - legendRoom - VIEW_GAP) / designed.natural
      if (k > 0) return scaleWidths(s, Math.min(k, MAX_UPSCALE), Math.min(min, MIN_VIEW_REFIT))
    }
  }
  const child = (c: unknown, width: number): unknown => {
    const cs = obj(c)
    if (!cs) return c
    return isComposite(cs) ? fitComposite(cs, width, root, min) : withViewWidth(cs, width)
  }
  const chrome = (s === root ? CHROME : CHROME_NESTED) + (s === root ? legendRoom : 0)
  const { hconcat, vconcat, concat } = s
  if (Array.isArray(hconcat)) return { ...s, hconcat: hconcat.map((c) => child(c, perView(w, hconcat.length, chrome, min))) }
  if (Array.isArray(vconcat)) return { ...s, vconcat: vconcat.map((c) => child(c, perView(w, 1, chrome, min))) }
  if (Array.isArray(concat)) return { ...s, concat: concat.map((c) => child(c, perView(w, wrapAt(s.columns, concat.length) ?? concat.length, chrome, min))) }
  const inner = obj(s.spec)
  const per = perView(w, layoutColumns(s, root), chrome, min)
  if (inner) return { ...s, spec: child(inner, per) }
  return { ...s, width: per }
}

/** The panels a wrapped layout puts on one row, `columns`, at most as many as it has (`n`, when known). */
const wrapAt = (columns: unknown, n: number | null): number | null => (typeof columns === 'number' && columns > 0 ? Math.min(columns, n ?? columns) : null)

/** The views a composite lays out side by side in its widest row: a repeat's or facet's columns, at most `columns` for
 * a wrapped layout (a 4-panel chart with `columns: 2` is sized as two columns). */
function layoutColumns(s: Spec, root: Spec): number {
  const rep = s.repeat
  if (Array.isArray(rep)) return wrapAt(s.columns, rep.length) ?? rep.length
  const repObj = obj(rep)
  if (repObj) return Array.isArray(repObj.column) ? repObj.column.length : Array.isArray(repObj.row) ? 1 : DEFAULT_COLS
  const facet = obj(s.facet) ?? obj(s.encoding) ?? {}
  const single = typeof facet.field === 'string' ? facet : obj(facet.facet)
  const colDef = obj(facet.column) ?? (facet.column == null && facet.row == null ? single : null)
  if (colDef) {
    const n = cardinality(colDef, s, root)
    const wrapped = colDef === single ? wrapAt(s.columns ?? single?.columns, n) : null
    return wrapped ?? n ?? DEFAULT_COLS
  }
  return facet.row != null ? 1 : DEFAULT_COLS
}

function cardinality(def: Spec, s: Spec, root: Spec): number | null {
  if (typeof def.field !== 'string' || def.bin || def.timeUnit) return null
  const data = obj(s.data) ?? obj(root.data)
  let rows: unknown = data?.values
  if (!Array.isArray(rows) && typeof data?.name === 'string') rows = obj(root.datasets)?.[data.name]
  if (!Array.isArray(rows)) return null
  const seen = new Set<unknown>()
  for (const r of rows) if (r && typeof r === 'object') seen.add((r as Spec)[def.field])
  return seen.size || null
}

export const usesContainerWidth = (spec: unknown): boolean => obj(spec)?.width === 'container'
export type RefitView = { signal: (name: string, value?: unknown) => unknown; runAsync: () => Promise<unknown> }

/** Re-read the container into a container-sized view's `width` signal when it differs. */
export function refitChart(view: RefitView, el: { clientWidth: number }, container: boolean): boolean {
  if (!container) return false
  const want = el.clientWidth
  if (want <= 0) return false
  let have: unknown
  try {
    have = view.signal('width')
  } catch {
    return false
  }
  if (have === want) return false
  view.signal('width', want)
  void view.runAsync()
  return true
}

/**
 * What of a drawn chart runs past its box at the right, in px: `svg`, the svg wider than the box; `drawn`, the drawing
 * past the svg's own edge (a label Vega measured narrower than it draws); `legend`, a horizontal legend row running past
 * the edge, with its entries per row, width and room.
 */
export interface Overrun {
  svg: number
  drawn: number
  /** the drawing past the svg's left edge */
  left: number
  legend: { perRow: number; width: number; room: number } | null
}

export function measureOverrun(el: HTMLElement): Overrun | null {
  const svg = el.querySelector('svg')
  if (!svg) return null
  const box = el.clientWidth
  const w = svg.width.baseVal.value
  // in the svg's own px: on the canvas the board's zoom scales what the page measures
  const sr = svg.getBoundingClientRect()
  const k = sr.width > 0 && w > 0 ? sr.width / w : 1
  const edge = Math.min(w, box)
  let legend: Overrun['legend'] = null
  for (const g of Array.from(svg.querySelectorAll('g.role-legend'))) {
    const r = g.getBoundingClientRect()
    const left = (r.left - sr.left) / k
    if ((r.right - sr.left) / k <= edge + 1) continue
    const labels = Array.from(g.querySelectorAll('.role-legend-label text'))
    const rows = new Set(labels.map((t) => Math.round(t.getBoundingClientRect().top / k))).size
    const perRow = rows ? Math.round(labels.length / rows) : 0
    if (perRow > 1 && edge - left > 0) {
      legend = { perRow, width: r.width / k, room: edge - left }
      break
    }
  }
  const d = shownExtent(svg)
  const left = d ? (d.left - sr.left) / k : 0
  const right = d ? (d.right - sr.left) / k : w
  return { svg: Math.ceil(w - box), drawn: Math.ceil(right - w), left: Math.ceil(-left), legend }
}

/** The left and right of what an svg draws, on the page, leaving out what a clip path cuts away: a mark clipped to its
 * view (a line over a scale whose domain the spec sets) still counts in getBBox wherever its path runs. Null when it
 * draws nothing. */
function shownExtent(svg: SVGSVGElement): { left: number; right: number } | null {
  let out: { left: number; right: number } | null = null
  const walk = (el: Element) => {
    if (el.hasAttribute('clip-path') || el.tagName.toLowerCase() === 'defs') return
    if (el.querySelector('[clip-path]')) {
      for (const kid of Array.from(el.children)) walk(kid)
      return
    }
    const r = el.getBoundingClientRect()
    if (r.width <= 0 && r.height <= 0) return
    out = out ? { left: Math.min(out.left, r.left), right: Math.max(out.right, r.right) } : { left: r.left, right: r.right }
  }
  for (const kid of Array.from(svg.children)) walk(kid)
  return out
}

/** the room a legend entry takes besides its label: the symbol and its offset */
const LEGEND_SYMBOL_ROOM = 14
const MIN_LABEL = 40
/** below this share of its box a container-sized chart's plot is squeezed by its labels (a long y axis, a legend at
 * the right), which are then cut at AXIS_LABEL_SHARE of the box */
const MIN_PLOT_SHARE = 0.3
const AXIS_LABEL_SHARE = 0.35

/** How a chart is refitted after it was measured: its legends in columns, its labels cut shorter, its discrete x axes
 * naming every column (xLabelsFit). */
export interface Refit {
  columns?: number
  legendLabel?: number
  axisLabel?: number
  xLabels?: XLabels
}

/** How a discrete x axis names every column: its labels on end with no overlap rule, at `fontSize` when their own size
 * does not fit, and the plot at `step` px a column when even MIN_X_LABEL_FONT does not. */
export interface XLabels {
  fontSize?: number
  step?: number
}

/** the smallest a discrete x axis's labels are drawn at to fit their columns (the theme's are 11 px) */
export const MIN_X_LABEL_FONT = 8
/** the least room between two neighbouring x labels on end, px */
const X_LABEL_GAP = 1
/** the theme's label size (lib/vizTheme), for a label that names none */
const LABEL_FONT = 11

/** A discrete x axis whose labels Vega's overlap rule left off, as measured once drawn (hiddenXLabels): the pitch of
 * its columns and its labels' size, px. */
export interface HiddenX {
  pitch: number
  font: number
}

/** How a discrete x axis that left names off names them all: labels on end at their own size when the pitch leaves
 * X_LABEL_GAP; else smaller, down to MIN_X_LABEL_FONT; past that the plot widens to a step they fit and the chart
 * scrolls sideways. Pure. */
export function xLabelsFit(h: HiddenX): XLabels {
  if (h.pitch >= h.font + X_LABEL_GAP) return {}
  const least = Math.min(h.font, MIN_X_LABEL_FONT)
  if (h.pitch >= least + X_LABEL_GAP) return { fontSize: Math.floor((h.pitch - X_LABEL_GAP) * 2) / 2 }
  return { ...(least < h.font ? { fontSize: least } : {}), step: Math.ceil(least + X_LABEL_GAP) }
}

/** Whether an x encoding is discrete: nominal or ordinal, or a field with no type that Vega-Lite reads as nominal. */
function discreteX(def: Spec): boolean {
  if (def.type === 'nominal' || def.type === 'ordinal') return true
  return def.type == null && typeof def.field === 'string' && !def.bin && !def.timeUnit && def.aggregate == null
}

/** Every discrete x axis in the spec with its labels on end (±90 kept, other angles replaced), no overlap rule, and at
 * `fontSize` when given. An axis or labels turned off are left as they are. */
function labelColumns(s: Spec, x: XLabels): Spec {
  const out: Spec = { ...s }
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    const list = s[key]
    if (Array.isArray(list)) out[key] = list.map((c) => (obj(c) ? labelColumns(obj(c)!, x) : c))
  }
  const inner = obj(s.spec)
  if (inner) out.spec = labelColumns(inner, x)
  const enc = obj(s.encoding)
  const def = obj(enc?.x)
  if (!enc || !def || !discreteX(def) || def.axis === null || obj(def.axis)?.labels === false) return out
  const own = obj(def.axis) ?? {}
  const { labelAlign: _align, labelBaseline: _baseline, ...rest } = own
  const onEnd = own.labelAngle === 90 || own.labelAngle === -90 || own.labelAngle === 270
  const axis = { ...(onEnd ? own : { ...rest, labelAngle: -90 }), labelOverlap: false, ...(x.fontSize ? { labelFontSize: x.fontSize } : {}) }
  out.encoding = { ...enc, x: { ...def, axis } }
  return out
}

/** The discrete x axis whose labels Vega's overlap rule left off (drawn at opacity 0) with the least pitch between
 * neighbouring labels, in the svg's own px, or null when every discrete x axis names every column. An axis is known by
 * the aria label Vega writes for it ("X-axis … for a discrete scale …"). */
export function hiddenXLabels(el: HTMLElement): HiddenX | null {
  const svg = el.querySelector('svg')
  if (!svg) return null
  const w = svg.width.baseVal.value
  const sr = svg.getBoundingClientRect()
  const k = sr.width > 0 && w > 0 ? sr.width / w : 1
  let found: HiddenX | null = null
  for (const g of Array.from(svg.querySelectorAll('g.role-axis'))) {
    const aria = g.getAttribute('aria-label') ?? ''
    if (!aria.startsWith('X-axis') || !aria.includes('discrete scale')) continue
    const texts = Array.from(g.querySelectorAll('g.role-axis-label text'))
    if (texts.length < 2 || !texts.some((t) => t.getAttribute('opacity') === '0')) continue
    const xs = texts.map((t) => t.getBoundingClientRect()).map((r) => (r.left + r.width / 2 - sr.left) / k).sort((a, b) => a - b)
    let pitch = Infinity
    for (let i = 1; i < xs.length; i++) pitch = Math.min(pitch, xs[i] - xs[i - 1])
    const font = parseFloat(texts[0].getAttribute('font-size') ?? '') || LABEL_FONT
    if (!found || pitch < found.pitch) found = { pitch, font }
  }
  return found
}

/** A legend that ran past the chart's edge, wrapped: the columns its entries' average width fits in its room (a row
 * still too wide is measured again and loses a column), and in one column the label width that fits. */
export function legendWrap(legend: NonNullable<Overrun['legend']>): Refit {
  const columns = Math.max(1, Math.min(legend.perRow - 1, Math.floor((legend.perRow * legend.room) / legend.width)))
  return columns > 1 ? { columns } : { columns, legendLabel: Math.max(MIN_LABEL, Math.floor(legend.room) - LEGEND_SYMBOL_ROOM) }
}

/** The spec with a refit applied: legends in `columns`, legend and y-axis labels cut at their limits (a lower limit in
 * the spec stands), and every discrete x axis naming each column (labelColumns), with the column step when given. */
export function applyRefit(spec: unknown, fit: Refit): unknown {
  let s = obj(spec)
  if (!s) return spec
  if (fit.xLabels) {
    s = labelColumns(s, fit.xLabels)
    if (fit.xLabels.step && s.width === 'container') s = { ...s, width: { step: fit.xLabels.step }, autosize: { type: 'pad' } }
  }
  const config = obj(s.config) ?? {}
  const lower = (cur: unknown, lim: number | undefined) => (lim == null ? cur : typeof cur === 'number' ? Math.min(cur, lim) : lim)
  const legend = obj(config.legend) ?? {}
  const axisY = obj(config.axisY) ?? {}
  const next: Spec = { ...config }
  if (fit.columns != null || fit.legendLabel != null) next.legend = { ...legend, ...(fit.columns != null ? { columns: fit.columns } : {}), labelLimit: lower(legend.labelLimit, fit.legendLabel) }
  if (fit.axisLabel != null) next.axisY = { ...axisY, labelLimit: lower(axisY.labelLimit, fit.axisLabel) }
  return { ...s, config: next }
}

/** how many times a chart is embedded again to fit its box */
const FIT_TRIES = 4

type FitView = RefitView & { padding: (p?: { left: number; right: number; top: number; bottom: number }) => unknown; resize: () => unknown }
type Embedded = { view: FitView; finalize: () => void; spec: unknown; fitWidth: number | undefined; container: boolean; theme: string; colours: string }
/** how long a chart waits for the page's faces to be declared (their stylesheet arrives on its own) before it is
 * measured in whatever face there is */
const FACES_WAIT_MS = 3000

/** The first family a font token names, without its quotes. */
const firstFamily = (stack: string): string => stack.split(',')[0].trim().replace(/^["']|["']$/g, '')

/** The fonts a chart is measured in, declared and loaded before it is embedded: Vega caches each label width it
 * measures, so a label measured in the fallback font keeps that width after the real font arrives. `document.fonts.load`
 * does nothing for an undeclared font, so the chart first waits up to FACES_WAIT_MS for the fonts to be declared. */
const fontsReady = async (): Promise<unknown> => {
  if (typeof document === 'undefined' || !document.fonts) return
  const families = [firstFamily(token('--font-mono')), firstFamily(token('--font-body'))]
  const declared = () => families.every((fam) => Array.from(document.fonts).some((f) => f.family.replace(/["']/g, '') === fam))
  for (const t0 = Date.now(); !declared() && Date.now() - t0 < FACES_WAIT_MS; ) await new Promise((r) => setTimeout(r, 50))
  const faces = [`11px ${token('--font-mono')}`, `11px ${token('--font-body')}`, `500 13px ${token('--font-body')}`]
  await Promise.all(faces.map((f) => document.fonts.load(f, 'Aa0').catch(() => [])))
  return document.fonts.ready
}

/** A container-sized chart whose drawing runs past its svg's edge takes that much more padding on that side, so Vega
 * narrows the plot and the label lands inside (Vega's fit does not count all of a value label's width). */
async function padOverhang(view: FitView, el: HTMLElement): Promise<void> {
  const over = measureOverrun(el)
  if (!over || (over.drawn <= 0 && over.left <= 0)) return
  const pad = view.padding() as { left: number; right: number; top: number; bottom: number }
  view.padding({ ...pad, left: pad.left + Math.max(0, over.left), right: pad.right + (over.drawn > 0 ? over.drawn + 1 : 0) })
  view.resize()
  await view.runAsync()
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

/**
 * The compiled Vega with every axis and legend label able to show its whole text in a tooltip (vega-embed's `patch`,
 * since Vega-Lite's schema has no `encode` for an axis): a label cut at the config's labelLimit still reads in full on
 * hover. Pure over the Vega spec.
 */
export function labelTooltips(vg: Record<string, unknown>): Record<string, unknown> {
  const guide = (g: unknown): unknown => {
    const o = obj(g)
    if (!o) return g
    const encode = obj(o.encode) ?? {}
    const labels = obj(encode.labels) ?? {}
    const update = obj(labels.update) ?? {}
    return { ...o, encode: { ...encode, labels: { ...labels, interactive: true, update: { ...update, tooltip: { signal: 'datum.label' } } } } }
  }
  const walkMarks = (s: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...s }
    if (Array.isArray(s.axes)) out.axes = s.axes.map(guide)
    if (Array.isArray(s.legends)) out.legends = s.legends.map(guide)
    if (Array.isArray(s.marks)) out.marks = s.marks.map((m) => (obj(m) && (obj(m)!.type === 'group' || 'marks' in obj(m)!) ? walkMarks(obj(m)!) : m))
    return out
  }
  return walkMarks(vg)
}

/** One chart: embeds once its container has a box, with a card's defaults (lib/chartDefaults) on the paper of what
 * shows it (onPaper); re-fits when the box changes and re-embeds when the theme or label colours change. Once drawn it
 * is measured against its box (measureOverrun) and refitted: wide legends wrap into columns, wide composites narrow,
 * squeezed plots get shorter labels, dense x axes get labels on end (xLabelsFit), and overflowing labels get padding. */
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
    // `step`: the width and the overflow of the embed before a composite was narrowed, so the next narrowing can go as
    // far as the last one's effect says it must (a part's legend or title that does not narrow with its view)
    const embed = async (w: number | undefined, fit: Refit, tries: number, step?: { w: number; over: number }): Promise<void> => {
      // the palette is read per theme, so a folded group's grey and the kept groups' colours are the theme's
      const classes = (JSON.parse(colours) as [string, number][][]).map((k): LabelClassColour[] => k.map(([name, n]) => ({ name, colour: token(colourToken(n)), none: !n })))
      const shown = chartDefaults(plain, { width: fitWidth ?? el.clientWidth, card, palette: VIZ_SERIES.map(token), other: token('--viz-ink-3'), labels: classes, neutral: VIZ_NEUTRAL.map(token) })
      const sized = onPaper(applyRefit(inkSmallNominal(responsive(shown, w, w === fitWidth ? undefined : MIN_VIEW_REFIT), inkPair()), fit))
      const m = await loadChunk(() => import('vega-embed'))
      if (!alive) return
      live.current?.finalize()
      live.current = null
      // the spec's embed options are dropped and Vega fetches no URL but a data: one (lib/vegaLoader)
      const r = await m.default(el, withoutEmbedOptions(sized) as any, { actions: false, config: vegaConfig() as any, patch: labelTooltips as any, loader: dataOnly(m.vega.loader()) })
      if (!alive) return r.finalize()
      const container = usesContainerWidth(sized)
      live.current = { view: r.view as unknown as FitView, finalize: r.finalize, spec, fitWidth, container, theme, colours }
      const over = measureOverrun(el)
      const box = el.clientWidth
      const cut = Math.max(MIN_LABEL, Math.round(box * AXIS_LABEL_SHARE))
      const cutLabels: Refit = { axisLabel: cut, legendLabel: Math.min(fit.legendLabel ?? cut, cut) }
      if (over && tries > 0) {
        if (over.legend) return embed(w, { ...fit, ...legendWrap(over.legend) }, tries - 1)
        // a composite whose drawing runs past its svg's right edge (the last tick label of its last view) is embedded
        // again that much narrower, so the label lands inside; never at 0 or less, which would draw the composite at the
        // widths its spec names
        const inside = (w ?? box) - over.drawn - 2
        if (!container && over.svg <= 0 && over.drawn > 0 && inside > 0) return embed(inside, fit, tries - 1)
        // (not one widened on purpose so its x labels fit their columns)
        if (!container && over.svg > 0 && !fit.xLabels?.step) {
          // a composite too wide: its views narrower; when narrowing did nothing, its labels take the room, so they are cut and
          // the views start again from the box. A narrowing that did less than its share is followed by a larger one
          const cur = w ?? box + over.svg
          const gained = step ? step.over - over.svg : 0
          if (step && gained < 1 && fit.axisLabel == null) return embed(fitWidth, { ...fit, ...cutLabels }, tries - 1)
          const gain = step && step.w > cur && gained >= 1 ? Math.min(4, Math.max(1, (step.w - cur) / gained)) : 1
          const next = Math.round(cur - over.svg * gain)
          if (next > 0) return embed(next, fit, tries - 1, { w: cur, over: over.svg })
        }
        const plot = container ? Number((r.view as { width: () => unknown }).width()) : NaN
        if (fit.axisLabel == null && plot < box * MIN_PLOT_SHARE) return embed(w, { ...fit, ...cutLabels }, tries - 1)
      }
      // a discrete x axis that left names off is refitted once, after the refits above have settled its width, so every
      // column is named (xLabelsFit); a composite that needs a wider step is fitted to a width that much wider
      const hidden = fit.xLabels ? null : hiddenXLabels(el)
      if (hidden) {
        const xLabels = xLabelsFit(hidden)
        const wider = xLabels.step && !container ? Math.ceil((w ?? box) * (xLabels.step / Math.max(1, hidden.pitch))) : w
        return embed(wider, { ...fit, xLabels }, Math.max(0, tries - 1))
      }
      if (container) await padOverhang(live.current.view, el)
    }
    fontsReady()
      .then(() => embed(fitWidth, {}, FIT_TRIES))
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
