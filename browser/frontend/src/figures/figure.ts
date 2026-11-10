// A card as a figure (figures/Figure.tsx), for a document that leaves the workbench: its parts that need no page. Pure.
//
// A Blog figure (blogpost-figure's) is a white panel FIGURE_W px wide: an accent bar, the card's takeaway as its headline
// in plain text (figureText), the card's question under it as the gray subtitle, then the card's chart at the panel's
// inner width. A Paper figure (paper-figure's) is the chart alone at one column's size or two columns' (paperSize),
// with no title and no legend in it (paperSpec), and the legend as a figure of its own; in a report its caption goes
// under it (captionParts).
import { isVegaLite } from '../components/Outputs'
import { plainInline } from '../report/diffModel'
import type { Cell, MimeBundle } from '../lib/types'

type Spec = Record<string, unknown>
const obj = (v: unknown): Spec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Spec) : null)

/** a Blog figure's panel: its width and its padding, px (blogpost-figure's figure.css), and the room its chart has */
export const BLOG_FIGURE = { width: 800, padTop: 36, padX: 40, padBottom: 32 }
export const BLOG_CHART_W = BLOG_FIGURE.width - 2 * BLOG_FIGURE.padX
/** a Paper figure's size, px at 96 per inch: 2.5 in square for one column, 5.3 in by 2.5 in for two */
export const PAPER_ONE = { width: 240, height: 240 }
export const PAPER_TWO = { width: 509, height: 240 }
/** the most categories along x a one-column Paper figure holds */
export const PAPER_CATEGORIES = 6
/** the width over the height from which a drawn figure takes two columns: a matplotlib figure of thimble's size (7.2 in
 * by 4, backend matplotlibrc) does */
const WIDE_DRAWING = 1.75

// a citation as a takeaway writes it: a value cited, [[value|ref]], or a bare ref, [[ref]] (backend report.plain_text)
const MARKUP = /\[\[([^[\]|]*)\|[^[\]]*\]\]|\[\[[^[\]]*\]\]/g
// a space a bare ref left before punctuation, but not before a period that starts a word (".gov.uk")
const BEFORE_PUNCT = /\s+([,;:!?)]|\.(?!\w))/g

/** A takeaway as a figure's headline writes it: each cited value its words, each bare ref gone, the markdown its words
 * (report/diffModel plainInline). Pure. */
export function figureText(text: string | null | undefined): string {
  return plainInline(String(text ?? '').replace(MARKUP, (_, value?: string) => value ?? '')).replace(BEFORE_PUNCT, '$1')
}

/** A takeaway as a Blog figure's headline writes it: its plain text (figureText) with no period at its end, as
 * blogpost-figure's titles have none. Pure. */
export function headline(text: string | null | undefined): string {
  return figureText(text).replace(/(?<!\.)\.$/, '')
}

/** The Vega-Lite spec a card's chart draws from, and its bundle's mime; null for a card whose chart is none. */
export function chartOf(cell: Pick<Cell, 'outputs'>): { spec: Spec; mime: string } | null {
  for (const b of cell.outputs ?? []) {
    if (!b || typeof b !== 'object') continue
    const mime = Object.keys(b).find(isVegaLite)
    const spec = mime ? obj((b as MimeBundle)[mime]) : null
    if (mime && spec) return { spec, mime }
  }
  return null
}

const COMPOSITE = ['facet', 'hconcat', 'vconcat', 'concat', 'repeat']
const isComposite = (s: Spec): boolean => COMPOSITE.some((k) => k in s) || ['row', 'column', 'facet'].some((c) => !!obj(obj(s.encoding)?.[c]))

/** The categories a chart sets along its x axis: the distinct values of a discrete x field among its rows (its own, or
 * a layer's); 0 for a chart whose x is not discrete. */
function categoriesAcross(s: Spec, inherited: unknown[] | null = null): number {
  const rows = Array.isArray(obj(s.data)?.values) ? (obj(s.data)!.values as unknown[]) : inherited
  const x = obj(obj(s.encoding)?.x)
  let n = 0
  if (x && typeof x.field === 'string' && (x.type === 'nominal' || x.type === 'ordinal') && rows) {
    const field = x.field.replace(/\\(.)/g, '$1')
    n = new Set(rows.map((r) => JSON.stringify(obj(r)?.[field] ?? null))).size
  }
  for (const l of Array.isArray(s.layer) ? s.layer : []) if (obj(l)) n = Math.max(n, categoriesAcross(obj(l)!, rows))
  return n
}

/** A drawn figure's own size, px, from its SVG's root (matplotlib writes it in pt); null for no SVG or no size. Pure. */
export function drawingSize(cell: Pick<Cell, 'outputs'>): { width: number; height: number } | null {
  const svg = (cell.outputs ?? []).map((b) => (b && typeof b === 'object' ? (b as MimeBundle)['image/svg+xml'] : null)).find((v) => typeof v === 'string')
  const root = typeof svg === 'string' ? /<svg\b[^>]*>/i.exec(svg)?.[0] : null
  const length = (name: string): number => {
    const m = root ? new RegExp(`\\s${name}="([\\d.]+)(pt|px)?"`).exec(root) : null
    return m ? (parseFloat(m[1]) * (m[2] === 'pt' ? 4 : 3)) / 3 : NaN
  }
  const [width, height] = [length('width'), length('height')]
  return width > 0 && height > 0 ? { width, height } : null
}

/** The size a Paper figure of this chart takes: two columns' for a chart faceted or set side by side with others, or with
 * more than PAPER_CATEGORIES categories along x, else one column's. A drawing (an SVG figure) takes two columns when it
 * is wide (WIDE_DRAWING) and keeps its own height for the width. Pure. */
export function paperSize(cell: Pick<Cell, 'outputs'>): { width: number; height: number } {
  const chart = chartOf(cell)
  if (chart) return isComposite(chart.spec) || categoriesAcross(chart.spec) > PAPER_CATEGORIES ? PAPER_TWO : PAPER_ONE
  const drawing = drawingSize(cell)
  return drawing && drawing.width / drawing.height >= WIDE_DRAWING ? PAPER_TWO : PAPER_ONE
}

/** A chart as a Paper figure draws it: no title, no legend (the legend is a figure of its own), and a single or layered
 * chart fitted whole, its axes included, to `size`; a composite keeps its views' heights and is fitted to the width
 * when drawn. Pure. */
export function paperSpec(spec: Spec, size: { width: number; height: number }): Spec {
  const { title: _title, ...rest } = spec
  const config = obj(rest.config) ?? {}
  const out: Spec = { ...rest, config: { ...config, legend: { ...(obj(config.legend) ?? {}), disable: true } } }
  return isComposite(spec) ? out : { ...out, width: size.width, height: size.height, autosize: { type: 'fit', contains: 'padding' } }
}

/** The card as a figure's body draws it: its chart alone (a card of code shows no code), its Vega-Lite charts through
 * `chart` when given. Pure. */
export function figureCell(cell: Cell, chart?: (spec: Spec) => Spec): Cell {
  const own = cell.kind === 'code' ? { ...cell, code: '' } : cell
  if (!chart) return own
  const outputs = (cell.outputs ?? []).map((b) => {
    if (!b || typeof b !== 'object') return b
    const mime = Object.keys(b).find(isVegaLite)
    const spec = mime ? obj((b as MimeBundle)[mime]) : null
    return mime && spec ? { ...b, [mime]: chart(spec) } : b
  })
  return { ...own, outputs }
}

/** A Paper figure's caption in a report, `Figure N. Takeaway. Question`: the number's words, the takeaway (bold in the
 * caption) ending in one period, and the question. Pure. */
export function captionParts(n: number, takeaway: string | null | undefined, question: string | null | undefined): { lead: string; takeaway: string; question: string } {
  const said = figureText(takeaway).replace(/[.\s]+$/, '')
  return { lead: `Figure ${n}.`, takeaway: said ? `${said}.` : '', question: figureText(question) }
}
