// A card as a figure (figures/Figure.tsx), for a document that leaves the workbench: its parts that need no page. Pure.
//
// A Blog figure (blogpost-figure's) is a white panel FIGURE_W px wide: an accent bar, the first sentence of the card's
// takeaway as its headline in plain text (takeawayHeadline), the card's question under it as the gray subtitle, then
// the card's chart at the panel's inner width; an export or a report may give the headline and the subtitle instead. A
// Paper figure (paper-figure's) is the chart alone at one column's size or two columns' (paperSize), with no title and
// no legend in it (paperSpec), and the legend as a figure of its own; in a report its caption goes under it
// (captionParts).
import { isVegaLite } from '../components/Outputs'
import { chartDefaults } from '../lib/chartDefaults'
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
/** the most categories along an axis a one-column Paper figure holds */
export const PAPER_CATEGORIES = 6
/** the characters of the longest category name down the y axis (a horizontal bar chart's) from which a Paper figure
 * takes two columns: the names' column would leave a one-column plot too narrow to read */
export const PAPER_NAME = 10
/** the width over the height from which a drawn figure takes two columns: a matplotlib figure of thimble's size (7.2 in
 * by 4, backend matplotlibrc) does */
const WIDE_DRAWING = 1.75

// a citation as a takeaway writes it: a value cited, [[value|ref]], or a bare ref, [[ref]] (backend report.plain_text)
const MARKUP = /\[\[([^[\]|]*)\|[^[\]]*\]\]|\[\[[^[\]]*\]\]/g
// a space a bare ref left before punctuation, but not before a period that starts a word (".gov.uk")
const BEFORE_PUNCT = /\s+([,;:!?)]|\.(?!\w))/g
// a headline's period at its end, not an ellipsis's
const END_PERIOD = /(?<!\.)\.$/
// where a sentence may end: its stop (a period, a question or exclamation mark, an ellipsis) and any closing quotes or
// brackets after it, then a space and the next word
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s+(\S+))/gu
// a word whose period ends no sentence, as in "e.g. Python", "14 vs. 7" or "Fig. 2"
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|cf|approx|ca|fig|figs|eq|eqs|no|nos|al|vol|pp?|dr|mrs?|prof|st|jr|sr|incl|resp|esp)\.$/i
// a word in lowercase that may still start a sentence: a name from the data, which holds an underscore, a digit or a
// capital (emergent_prs, run3)
const LOWER_NAME = /^\p{Ll}\S*[_\d\p{Lu}]/u
/** the words a first sentence has at the least: a shorter one ("Yes.") takes the next sentence with it */
const SENTENCE_WORDS = 3

/** A takeaway as a figure's headline writes it: each cited value its words, each bare ref gone, the markdown its words
 * (report/diffModel plainInline). Pure. */
export function figureText(text: string | null | undefined): string {
  return plainInline(String(text ?? '').replace(MARKUP, (_, value?: string) => value ?? '')).replace(BEFORE_PUNCT, '$1')
}

/** A text as a Blog figure's headline writes it: its plain text (figureText) with no period at its end, as
 * blogpost-figure's titles have none. Pure. */
export function headline(text: string | null | undefined): string {
  return figureText(text).replace(END_PERIOD, '')
}

/** The first sentence of a plain text, or all of it when it is one sentence. A sentence ends at a stop followed by a
 * space and a word that does not start in lowercase, or does as a name from the data (LOWER_NAME); the period of a
 * number (2.5) or of an abbreviation (e.g., vs.) ends none, and a sentence of fewer than SENTENCE_WORDS words goes on
 * into the next. Pure. */
export function firstSentence(text: string): string {
  const s = text.trim()
  for (const m of s.matchAll(SENTENCE_END)) {
    const head = s.slice(0, (m.index ?? 0) + m[0].length)
    const next = m[1] ?? ''
    if (ABBREVIATION.test(head) || (/^\p{Ll}/u.test(next) && !LOWER_NAME.test(next))) continue
    if ((head.match(/\S+/g) ?? []).length >= SENTENCE_WORDS) return head
  }
  return s
}

/** A card's takeaway as a Blog figure's headline when none is given for it: its first sentence (firstSentence) in plain
 * words, with no period at its end, so the figure opens with one line of finding rather than the whole answer. Pure. */
export function takeawayHeadline(takeaway: string | null | undefined): string {
  return firstSentence(figureText(takeaway)).replace(END_PERIOD, '')
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

/** The rows a view draws: its data's own values, or the dataset of the chart's it names (as Altair writes a chart), else
 * the rows of the view around it; null for rows the spec does not hold (a URL's). */
function rowsOf(s: Spec, root: Spec, inherited: unknown[] | null): unknown[] | null {
  const data = obj(s.data)
  if (!data) return inherited
  if (Array.isArray(data.values)) return data.values
  const named = typeof data.name === 'string' ? obj(root.datasets)?.[data.name] : null
  return Array.isArray(named) ? named : null
}

/** The categories a chart sets along an axis: the distinct values of a discrete field on it among its rows (its own, or
 * a layer's), how many, and the characters of the longest; none for an axis that is not discrete. */
function categories(s: Spec, axis: 'x' | 'y', root: Spec = s, inherited: unknown[] | null = null): { count: number; longest: number } {
  const rows = rowsOf(s, root, inherited)
  const def = obj(obj(s.encoding)?.[axis])
  let count = 0
  let longest = 0
  if (def && typeof def.field === 'string' && (def.type === 'nominal' || def.type === 'ordinal') && rows) {
    const field = def.field.replace(/\\(.)/g, '$1')
    const names = new Map(rows.map((r) => [JSON.stringify(obj(r)?.[field] ?? null), obj(r)?.[field] ?? null]))
    count = names.size
    for (const v of names.values()) longest = Math.max(longest, v == null ? 0 : String(v).length)
  }
  for (const l of Array.isArray(s.layer) ? s.layer : []) {
    if (!obj(l)) continue
    const got = categories(obj(l)!, axis, root, rows)
    count = Math.max(count, got.count)
    longest = Math.max(longest, got.longest)
  }
  return { count, longest }
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

/** The size a Paper figure of this chart takes: two columns' for a chart faceted or set side by side with others, for
 * one with more than PAPER_CATEGORIES categories along either axis, and for one whose category names down its y axis
 * run to PAPER_NAME characters (a horizontal bar chart's); else one column's. The chart is read as a card draws it
 * (lib/chartDefaults), which lays a bar chart of long names on its side. A drawing (an SVG figure) takes two columns
 * when it is wide (WIDE_DRAWING) and keeps its own height for the width. Pure. */
export function paperSize(cell: Pick<Cell, 'outputs'>): { width: number; height: number } {
  const chart = chartOf(cell)
  if (chart) {
    if (isComposite(chart.spec)) return PAPER_TWO
    const drawn = obj(chartDefaults(chart.spec)) ?? chart.spec
    const [across, down] = [categories(drawn, 'x'), categories(drawn, 'y')]
    return Math.max(across.count, down.count) > PAPER_CATEGORIES || down.longest >= PAPER_NAME ? PAPER_TWO : PAPER_ONE
  }
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
 * caption) ending in one period, or in its own question or exclamation mark, and the question. Pure. */
export function captionParts(n: number, takeaway: string | null | undefined, question: string | null | undefined): { lead: string; takeaway: string; question: string } {
  const said = figureText(takeaway).replace(/[.\s]+$/, '')
  return { lead: `Figure ${n}.`, takeaway: !said ? '' : /[?!…]$/.test(said) ? said : `${said}.`, question: figureText(question) }
}
