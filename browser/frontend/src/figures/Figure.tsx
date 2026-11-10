// A card as a figure for a document that leaves the workbench, in a figure style (lib/theme FigureStyle): what the card
// harness draws for an export or a report when its request names a figure (render.tsx, backend render.render_figure).
// Blog: a white panel with an accent bar, the takeaway as its headline, the question as the gray subtitle and the chart
// under them, none of the card's chrome. Paper: the chart alone at one column's size or two columns', with no title and
// no legend; the legend as a figure of its own (part 'legend'), its swatches as the chart draws them, a line's dash and
// marker included; a caption under the chart in a report (`caption`, the figure's number). thimble: the card face, as
// the canvas draws it. The chart takes the figure style the page is in, which the harness sets for the request (the
// pure parts are figures/figure.ts).
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { CardBody } from '../canvas/bodies'
import { CardFace } from '../canvas/CardFace'
import { CARD_PAD_X } from '../canvas/Cell'
import type { ConceptDetailState } from '../canvas/concepts'
import { CanvasContext } from '../canvas/context'
import { CARD_W, kindOf } from '../canvas/layout'
import { chartLabels } from '../components/Outputs'
import { classesOf, colourToken } from '../files/labels'
import { loadChunk } from '../lib/chunkRecovery'
import type { FigureStyle } from '../lib/theme'
import type { Cell } from '../lib/types'
import { drawChart, type DrawnChart } from '../lib/vegaDraw'
import { token } from '../lib/vizTheme'
import { BLOG_CHART_W, captionParts, chartOf, figureCell, figureText, headline, paperSize, paperSpec } from './figure'
import './figure.css'

export type FigurePart = 'figure' | 'legend'

export interface FigureProps {
  cell: Cell
  style: FigureStyle
  /** the chart (the default), or a Paper figure's legend alone */
  part?: FigurePart
  /** the columns a Paper legend's entries stand in; all in one row when not given */
  columns?: number
  /** a Paper figure's number in its report, for the caption under it (`Figure N. Takeaway. Question`) */
  caption?: number
  /** the card's label, for a label card's face */
  label: ConceptDetailState
}

export function Figure({ cell, style, part = 'figure', columns, caption, label }: FigureProps) {
  if (style === 'blog') return <BlogFigure cell={cell} label={label} />
  if (style === 'paper') return part === 'legend' ? <PaperLegend cell={cell} columns={columns} /> : <PaperFigure cell={cell} caption={caption} label={label} />
  return (
    <div className={`figure figure-thimble bcell bcell-kind-${kindOf(cell)}`} data-figure="thimble" style={{ position: 'relative', width: CARD_W }}>
      <CardFace cell={cell} width={CARD_W - CARD_PAD_X} label={label} />
    </div>
  )
}

/** Blog's figure (module note): the headline is the takeaway, or the question when the card has none. */
function BlogFigure({ cell, label }: { cell: Cell; label: ConceptDetailState }) {
  const takeaway = headline(cell.takeaway)
  const question = figureText(cell.title)
  const shown = useMemo(() => figureCell(cell), [cell])
  return (
    <div className="figure figure-blog" data-figure="blog">
      <h1 className="figure-title">{takeaway || question}</h1>
      {takeaway && question ? <p className="figure-sub">{question}</p> : null}
      <div className="figure-chart">
        <CardBody cell={shown} width={BLOG_CHART_W} label={label} />
      </div>
    </div>
  )
}

/** Paper's figure (module note): the chart fitted to its size (figure.ts paperSpec), the caption under it in a report. */
function PaperFigure({ cell, caption, label }: { cell: Cell; caption?: number; label: ConceptDetailState }) {
  const size = paperSize(cell)
  const shown = useMemo(() => figureCell(cell, (spec) => paperSpec(spec, size)), [cell, size])
  const parts = caption != null ? captionParts(caption, cell.takeaway, cell.title) : null
  return (
    <figure className="figure figure-paper" data-figure="paper" style={{ width: size.width }}>
      <div className="figure-chart">
        <CardBody cell={shown} width={size.width} label={label} />
      </div>
      {parts ? (
        <figcaption className="figure-caption">
          {parts.lead} {parts.takeaway ? <b>{parts.takeaway}</b> : null} {parts.question}
        </figcaption>
      ) : null}
    </figure>
  )
}

/** One entry of a Paper legend: its name, and its swatch as the chart draws it. */
export interface LegendEntry {
  label: string
  color: string
  /** a line's dash (Vega's strokeDash), null for a solid line or a mark that is no line */
  dash: number[] | null
  /** a dot's shape (Vega's), null for none */
  shape: string | null
}

/** A legend of amounts (a heatmap's): its title, its colors from the lowest amount to the highest, and its ends' amounts. */
export interface LegendRamp {
  title: string
  stops: string[]
  low: string
  high: string
}

/** A Paper legend as the chart's view drew its colors: entries for groups, or a ramp for amounts; empty for neither. */
type Legend = { entries: LegendEntry[]; ramp: LegendRamp | null }

type Scale = ((v: unknown) => unknown) & { domain: () => unknown[]; type?: string }
type Mark = 'line' | 'point' | 'square'
/** the colors a legend of amounts is drawn through, evenly spread between its ends */
const RAMP_STOPS = 11

/** The unit of the chart whose marks its colors name, and that mark: a line's, a dot's, or a filled square for any other
 * (a bar, an area, a cell). */
function colored(spec: Record<string, unknown>): { mark: Mark; color: Record<string, unknown> | null } {
  const visit = (s: Record<string, unknown>): { mark: Mark; color: Record<string, unknown> | null } | null => {
    const enc = s.encoding as Record<string, unknown> | undefined
    const type = typeof s.mark === 'string' ? s.mark : String((s.mark as { type?: unknown } | undefined)?.type ?? '')
    const color = (enc?.color ?? enc?.stroke ?? enc?.fill) as Record<string, unknown> | undefined
    if (color && typeof color === 'object') return { mark: type === 'line' ? 'line' : ['point', 'circle', 'square'].includes(type) ? 'point' : 'square', color }
    for (const l of Array.isArray(s.layer) ? s.layer : []) {
      const got = l && typeof l === 'object' ? visit(l as Record<string, unknown>) : null
      if (got) return got
    }
    return s.spec && typeof s.spec === 'object' ? visit(s.spec as Record<string, unknown>) : null
  }
  return visit(spec) ?? { mark: 'square', color: null }
}

/** An amount at a legend's end, with no more than three significant digits. */
const amount = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(3)).toLocaleString('en-US') : String(v))

/** A chart's legend of colors as its view drew them: for a scale of groups, each group with its color, and its dash and
 * its shape when the chart sets them by the same groups; for a scale of amounts, its colors from end to end. */
function legendOf(view: unknown, spec: Record<string, unknown>): Legend {
  const scale = (name: string): Scale | null => {
    try {
      const s = (view as { scale: (n: string) => unknown }).scale(name)
      return typeof s === 'function' ? (s as Scale) : null
    } catch {
      return null
    }
  }
  const color = scale('color') ?? scale('stroke') ?? scale('fill')
  const { mark, color: def } = colored(spec)
  if (!color) return { entries: [], ramp: null }
  if (color.type !== 'ordinal') {
    const [lo, hi] = color.domain() as number[]
    if (typeof lo !== 'number' || typeof hi !== 'number') return { entries: [], ramp: null }
    const stops = Array.from({ length: RAMP_STOPS }, (_, i) => String(color(lo + ((hi - lo) * i) / (RAMP_STOPS - 1))))
    const title = def ? String('title' in def ? (def.title ?? '') : (def.field ?? '')) : ''
    return { entries: [], ramp: { title, stops, low: amount(lo), high: amount(hi) } }
  }
  const dash = mark === 'line' ? scale('strokeDash') : null
  const shape = mark === 'square' ? null : scale('shape')
  const entries = color.domain().map((v) => {
    const d = dash ? dash(v) : null
    return {
      label: String(v),
      color: String(color(v)),
      dash: Array.isArray(d) && d.some((x, i) => i % 2 === 1 && x > 0) ? (d as number[]) : null,
      shape: shape ? String(shape(v)) : mark === 'point' ? 'circle' : null,
    }
  })
  return { entries, ramp: null }
}

/** A dot of Vega's shape, centred on 0, about 7 px across. */
function Dot({ shape, color }: { shape: string; color: string }) {
  const paths: Record<string, string> = {
    square: 'M-3,-3H3V3H-3Z',
    diamond: 'M0,-4L4,0L0,4L-4,0Z',
    cross: 'M-1.2,-3.6H1.2V-1.2H3.6V1.2H1.2V3.6H-1.2V1.2H-3.6V-1.2H-1.2Z',
    'triangle-up': 'M0,-3.6L3.6,3L-3.6,3Z',
    triangle: 'M0,-3.6L3.6,3L-3.6,3Z',
    'triangle-down': 'M0,3.6L3.6,-3L-3.6,-3Z',
    'triangle-left': 'M-3.6,0L3,-3.6L3,3.6Z',
    'triangle-right': 'M3.6,0L-3,-3.6L-3,3.6Z',
  }
  return paths[shape] ? <path d={paths[shape]} fill={color} /> : <circle r={3.3} fill={color} />
}

/** A legend entry's swatch: a line with its dash and its dot, a dot, or a filled square. */
function Swatch({ entry, mark }: { entry: LegendEntry; mark: Mark }) {
  if (mark === 'line')
    return (
      <svg className="figure-swatch" width={26} height={10} viewBox="0 0 26 10" aria-hidden="true">
        <line x1={1} x2={25} y1={5} y2={5} stroke={entry.color} strokeWidth={1.5} strokeDasharray={entry.dash?.join(' ')} />
        {entry.shape ? (
          <g transform="translate(13 5)">
            <Dot shape={entry.shape} color={entry.color} />
          </g>
        ) : null}
      </svg>
    )
  return (
    <svg className="figure-swatch" width={10} height={10} viewBox="-5 -5 10 10" aria-hidden="true">
      {mark === 'point' ? <Dot shape={entry.shape ?? 'circle'} color={entry.color} /> : <rect x={-5} y={-5} width={10} height={10} fill={entry.color} />}
    </svg>
  )
}

/** Paper's legend alone (module note), in `columns` columns, all in one row when not given, or a heatmap's ramp: the
 * chart is drawn out of sight at the figure's size and its scales read, so each swatch is as the chart draws it. A card
 * with no legend of colors draws an empty legend (`data-empty`). */
function PaperLegend({ cell, columns }: { cell: Cell; columns?: number }) {
  const { concepts } = useContext(CanvasContext)
  const chart = useMemo(() => chartOf(cell), [cell])
  const size = paperSize(cell)
  const hidden = useRef<HTMLDivElement>(null)
  const [legend, setLegend] = useState<Legend | null>(null)
  // the labels' classes as a string, as the canvas's charts read them (components/Outputs Vega)
  const colours = JSON.stringify(chartLabels(cell.labels, concepts).map((k) => classesOf(k).map((c) => [c.name, c.color ?? 0])))
  useEffect(() => {
    const el = hidden.current
    if (!el || !chart) {
      setLegend({ entries: [], ramp: null })
      return
    }
    let alive = true
    let drawn: DrawnChart | null = null
    const labels = (JSON.parse(colours) as [string, number][][]).map((k) => k.map(([name, n]) => ({ name, colour: token(colourToken(n)), none: !n })))
    drawChart(el, paperSpec(chart.spec, size), () => loadChunk(() => import('vega-embed')), {
      fitWidth: size.width,
      card: true,
      labels,
      alive: () => alive,
      replace: () => drawn?.finalize(),
      drawn: (d) => (drawn = d),
    })
      .then((d) => alive && setLegend(d ? legendOf(d.view, chart.spec) : { entries: [], ramp: null }))
      .catch(() => alive && setLegend({ entries: [], ramp: null }))
      .finally(() => drawn?.finalize())
    return () => {
      alive = false
    }
  }, [chart, size, colours])
  const mark = chart ? colored(chart.spec).mark : 'square'
  const entries = legend?.entries ?? []
  const ramp = legend?.ramp ?? null
  const across = Math.max(1, Math.min(columns && columns > 0 ? columns : Infinity, entries.length || 1))
  return (
    <div className="figure figure-legend" data-figure="paper" data-body="" data-settled={legend ? 'true' : 'false'} data-empty={legend && !entries.length && !ramp ? '' : undefined}>
      {/* out of sight, around the element vega-embed draws in, which its own sheet sets in the flow */}
      <div className="figure-legend-chart" aria-hidden="true">
        <div ref={hidden} style={{ width: size.width }} />
      </div>
      {entries.length ? (
        <ul className="figure-legend-entries" style={{ gridTemplateColumns: `repeat(${across}, auto)` }}>
          {entries.map((e) => (
            <li key={e.label} className="figure-legend-entry">
              <Swatch entry={e} mark={mark} />
              <span>{e.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {ramp ? (
        <div className="figure-legend-ramp">
          {ramp.title ? <div className="figure-legend-title">{ramp.title}</div> : null}
          <div className="figure-legend-bar" style={{ background: `linear-gradient(to right, ${ramp.stops.join(', ')})` }} />
          <div className="figure-legend-ends">
            <span>{ramp.low}</span>
            <span>{ramp.high}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
