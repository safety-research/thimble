// What a chart is given in a figure style (lib/theme FigureStyle) before it is drawn (lib/vegaDraw drawChart), after a
// card's defaults (lib/chartDefaults): the changes the style's config (lib/vizTheme vegaConfig) cannot make alone. It
// is keyed on the style, so a style switch redraws every chart without running a card again. Pure.
//
// Blog (blogpost-figure's labels, not legends): a bar carries its value at its end, in its series color (a darker tone
// of a pale one) and semibold, past the end of its interval when it has one; a bar chart's category axis has no title,
// since its names say what it is; the lines of a line chart are named in one column at the plot's right edge, each at
// its last value's height, moved apart so no two names overlap (blogpost-figure's right_labels), in their colors and in
// place of a legend, and a single line carries its last value there; a legend that stays is a row over the chart,
// untitled, its names in their colors; a horizontal bar chart's gridlines run down from its x axis; a heatmap's cells
// carry their values in place of a color bar, white on a dark cell and ink on a light one. Paper (paper-figure's): the
// lines of a line chart differ by dash (PAPER_DASHES) and, while each has few enough values for dots (LINE_DOTS), by
// their dots' shape, as well as by color.
// The changes read a chart's shape from its spec, whoever wrote it: thimble.chart's charts, and a card's own Altair
// chart of one view (bars alone, side by side or stacked; lines with a color field). A value or a name needs the
// chart's rows, inline in the spec (`data.values`, or a dataset `data.name` names). Of a chart of more views (layers,
// panels) only thimble.chart's are changed: they hold their rows inline and give their marks a tooltip of every column.
// Any other chart, and one with selections, takes the style's config alone, as does a spec the changes cannot read.
import { FOLD_FIELD } from './chartDefaults'
import { BLOG_TYPE } from './vizTheme'
import type { FigureStyle } from './theme'

type Spec = Record<string, unknown>
const obj = (v: unknown): Spec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Spec) : null)

export interface FigureSpecOptions {
  /** the room the chart has, px */
  width?: number
  /** the series colors in order (lib/vizTheme VIZ_SERIES, read per theme): the first is a single series' */
  palette?: readonly string[]
}

/** the room a value over a bar takes across, px: bars standing side by side carry their values while each has this */
export const VALUE_ROOM = 36
/** the most rows of a horizontal bar chart whose bars carry their values */
export const VALUE_ROWS = 40
/** the most lines named at their ends; past it a line chart keeps its legend */
export const END_LINES = 7
/** the room between the middles of two lines' names, px: more than a name's line height, as blogpost-figure's
 * right_labels keeps (1.55 times the names' size) */
export const NAME_ROOM = Math.round(BLOG_TYPE.label * 1.55)
/** the room between a plot's right edge and the column of names past it, px */
const NAME_PAD = 8
/** a line has dots while it has at most this many values (backend kernel_thimble LINE_DOTS_MAX) */
export const LINE_DOTS = 30
/** Paper's dashes, one per line in order, each as long as reads at a card's width and on a figure 2.5 in wide: solid,
 * dashed, dotted, dash-dot, long dash, long dash-dot, dash-dot-dot (px, at a line's 1.5 px) */
export const PAPER_DASHES: readonly (readonly number[])[] = [[1, 0], [6, 3], [2, 2.5], [8, 3, 2, 3], [14, 4], [14, 4, 2, 4], [8, 3, 2, 3, 2, 3]]
/** the length of a Paper line's swatch in its legend, px: a whole period of the longest dash */
const PAPER_SWATCH = 24
/** the luminance from which a bar's color is pale, and the share of its lightness a value over a pale bar keeps
 * (blogpost-figure writes a pale tint bar's value in a mid tone of its hue) */
const PALE_BAR = 0.35
const DARKER_TONE = 0.77
/** the most cells of a heatmap that carry their values */
export const CELL_VALUES = 80
/** the luminance of a cell's color above which its value is in ink, under it white; the ink, blogpost-figure's, on a
 * light cell on either paper */
const LIGHT_CELL = 0.4
const CELL_INK = '#1f1f1e'
/** the field a bar's value is placed at, past the end of its interval */
export const LABEL_AT = '__thimble_label_at'
/** the field a line's name is read from */
export const LABEL_TEXT = '__thimble_label'
/** the field of a line's name that gives its place in the column of names, from the bottom up */
export const LABEL_RANK = '__thimble_label_rank'
/** the start of the names of the signals that place the names (nameParams) */
const NAME_SIGNAL = 'thimble_name'

const DISCRETE = new Set(['nominal', 'ordinal'])
const markType = (mark: unknown): string => (typeof mark === 'string' ? mark : String(obj(mark)?.type ?? ''))
const discrete = (def: Spec | null): def is Spec => !!def && typeof def.field === 'string' && DISCRETE.has(String(def.type ?? 'nominal'))
const quantitative = (def: Spec | null): def is Spec => !!def && typeof def.field === 'string' && def.type === 'quantitative'
/** A bar's length: a quantitative field, or a count of rows (Altair's `count()`, which names no field). */
const amount = (def: Spec | null): def is Spec => !!def && def.type === 'quantitative' && (typeof def.field === 'string' || def.aggregate === 'count')
const continuous = (def: Spec | null): def is Spec => !!def && typeof def.field === 'string' && (def.type === 'quantitative' || def.type === 'temporal')
/** A field name as a row holds it: thimble.chart escapes a name's dots and brackets for Vega-Lite (kernel_thimble _field). */
const unescaped = (field: unknown): string => String(field).replace(/\\(.)/g, '$1')
/** An expression reading a row's field. */
const read = (field: unknown): string => `datum[${JSON.stringify(unescaped(field))}]`
const titleOf = (def: Spec): unknown => ('title' in def ? def.title : def.field)

/** Whether a unit is thimble.chart's (module note): its rows are the chart's inline rows and its marks carry a tooltip of
 * every column. */
function ownChart(unit: Spec, rows: unknown[] | null): boolean {
  return !!rows && Array.isArray(obj(unit.encoding)?.tooltip)
}

/** Whether a transform of the view's or of the chart's makes the rows the view draws other than the spec's rows. */
const transformed = (...views: Spec[]): boolean => views.some((v) => Array.isArray(v.transform) && v.transform.length > 0)

/**
 * The spec as the figure style draws it (module note); a spec of thimble's own style, or any other spec, comes back as
 * it is.
 */
export function figureSpec(spec: unknown, style: FigureStyle, opts: FigureSpecOptions = {}): unknown {
  const s = obj(spec)
  if (style === 'thimble' || !s || !(typeof s.$schema === 'string' && s.$schema.includes('vega-lite'))) return spec
  try {
    return withUnit(s, (unit, siblings, rows, root, own) =>
      style === 'blog'
        ? (blogBars(unit, siblings, rows, root, own, opts) ?? blogLines(unit, rows, root, own, opts) ?? (own ? blogCells(unit, rows, opts) : null))
        : paperLines(unit, rows, root, own),
    )
  } catch {
    // a spec whose parts are not what the changes read is drawn as it is
    return spec
  }
}

/** What a change makes of a unit: the unit, layers to draw over the chart's, and params the chart takes for them. */
type Changed = { unit: Spec; over: Spec[]; params?: Spec[] }
/** `own`: the unit is thimble.chart's (ownChart). */
type Change = (unit: Spec, siblings: readonly Spec[], rows: unknown[] | null, root: Spec, own: boolean) => Changed | null

/** The rows of a chart of one view, when its spec holds them: its inline rows, or the dataset its data names. */
function rowsOf(view: Spec): unknown[] | null {
  const data = obj(view.data)
  if (Array.isArray(data?.values)) return data.values
  const named = typeof data?.name === 'string' ? obj(view.datasets)?.[data.name] : null
  return Array.isArray(named) ? named : null
}

/** The chart with `change` made to its first unit that it changes: a chart of one view, whoever made it (which becomes
 * a layer when the change draws over it), or of thimble.chart's charts a layer, or a layer of a facet's panel. A view
 * with its own panels (a row channel) or selections is left as it is, since a layer cannot hold them. */
function withUnit(s: Spec, change: Change): Spec {
  const inline = (v: unknown): unknown[] | null => (Array.isArray(obj(obj(v)?.data)?.values) ? (obj(obj(v)!.data)!.values as unknown[]) : null)
  const withParams = (host: Spec, params: Spec[] | undefined): Spec => (params?.length ? { ...host, params: [...(Array.isArray(host.params) ? host.params : []), ...params] } : host)
  if (obj(s.encoding) && s.mark != null) {
    const enc = obj(s.encoding)!
    if (enc.row || enc.column || enc.facet || s.params || s.selection) return s
    const got = change(s, [], rowsOf(s), s, ownChart(s, inline(s)))
    if (!got) return s
    if (!got.over.length) return got.unit
    const { mark, encoding, ...rest } = got.unit
    return withParams({ ...rest, layer: [{ mark, encoding }, ...got.over] }, got.params)
  }
  const layered = (host: Spec, rows: unknown[] | null): Spec | null => {
    const layers = Array.isArray(host.layer) ? (host.layer as unknown[]) : null
    if (!layers) return null
    for (let i = 0; i < layers.length; i++) {
      const l = obj(layers[i])
      if (!l || !obj(l.encoding) || l.params || !ownChart(l, inline(l) ?? rows)) continue
      const got = change(l, layers.filter((_, j) => j !== i).map((x) => obj(x) ?? {}), inline(l) ?? rows, s, true)
      if (!got) continue
      return withParams({ ...host, layer: [...layers.slice(0, i), got.unit, ...layers.slice(i + 1), ...got.over] }, got.params)
    }
    return null
  }
  const top = layered(s, inline(s))
  if (top) return top
  const inner = obj(s.spec)
  if (obj(s.facet) && inner) {
    const changed = layered(inner, inline(inner) ?? inline(s))
    if (changed) return { ...s, spec: changed }
  }
  return s
}

/** The distinct values of `field` among the rows. */
const distinct = (rows: readonly unknown[], field: unknown): number => new Set(rows.map((r) => JSON.stringify(obj(r)?.[unescaped(field)] ?? null))).size

/** the most decimals a value over a mark is written with */
const MAX_DECIMALS = 6

/** The format the values over a chart's marks are written in, all with the same decimals: their axis's own (a
 * whole-number axis's, lib/chartDefaults), else as many decimals as give the largest three significant digits, and no
 * more than any value has. */
export function valueFormat(def: Spec, rows: readonly unknown[]): string {
  const axis = obj(def.axis)
  if (typeof axis?.format === 'string' && !axis.formatType) return axis.format
  let most = 0
  let has = 0
  for (const r of rows) {
    const v = obj(r)?.[unescaped(def.field)]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    most = Math.max(most, Math.abs(v))
    has = Math.max(has, (/\.(\d+)$/.exec(String(v))?.[1] ?? '').length)
  }
  const needs = most > 0 ? 2 - Math.floor(Math.log10(most)) : 0
  return `,.${Math.min(MAX_DECIMALS, Math.max(0, needs), has)}f`
}

/** The expression of the color a value over a bar is written in, from `of`, an expression of the bar's color: the bar's
 * own, or a darker tone of its hue when the bar is pale. */
export const valueTone = (of: string): string => `luminance(${of}) > ${PALE_BAR} ? hsl(hsl(${of}).h, hsl(${of}).s, hsl(${of}).l * ${DARKER_TONE}) : ${of}`

/** A color channel's legend as Blog draws one that stays: a row over the chart, untitled, square swatches, each name in
 * its color (a darker tone of a pale one, valueTone) at the size of a direct label; what the spec names itself stands. */
function legendRow(color: Spec): Spec {
  if (color.legend === null) return color
  const row = { title: null, orient: 'top', direction: 'horizontal', symbolType: 'square', labelFontSize: BLOG_TYPE.label, labelFontWeight: 500, labelColor: { expr: valueTone("scale('color', datum.value)") } }
  return { ...color, legend: { ...row, ...(obj(color.legend) ?? {}) } }
}

/** The channels whose groups split a bar into segments, stacked or drawn over each other, when their field is neither
 * the category's nor the offset's. */
const SEGMENTS = ['color', 'fill', 'opacity', 'fillOpacity', 'detail']

/**
 * Blog's bars (module note) of a bar chart whose categories stand on one axis and values on the other (no histogram, no
 * bars over time): the category axis untitled, a horizontal chart's gridlines turned to run down from its x axis, a
 * legend turned into a row (none when the colors repeat the categories), and the values over the bars when the rows say
 * each bar's value (one row a bar) and each bar has room (VALUE_ROOM, VALUE_ROWS), in their bars' colors; a stack's
 * segments carry none. Null for any other unit.
 */
function blogBars(unit: Spec, siblings: readonly Spec[], rows: unknown[] | null, root: Spec, own: boolean, opts: FigureSpecOptions): Changed | null {
  if (markType(unit.mark) !== 'bar') return null
  const enc = obj(unit.encoding)!
  const x = obj(enc.x)
  const y = obj(enc.y)
  const horizontal = amount(x) && discrete(y)
  if (!horizontal && !(amount(y) && discrete(x))) return null
  const [v, c, off] = horizontal ? (['x', 'y', 'yOffset'] as const) : (['y', 'x', 'xOffset'] as const)
  const value = obj(enc[v])!
  const cat = obj(enc[c])!
  const offset = obj(enc[off])
  const color = obj(enc.color)
  // the category axis names each bar, so it needs no title
  const next: Spec = { ...enc, [c]: { ...cat, title: null } }
  if (horizontal && !('grid' in (obj(value.axis) ?? {})) && value.axis !== null) next[v] = { ...value, axis: { ...(obj(value.axis) ?? {}), grid: true } }
  if (typeof color?.field === 'string') next.color = color.field !== cat.field ? legendRow(color) : 'legend' in color ? color : { ...color, legend: null }
  const out: Spec = { ...unit, encoding: next }
  const none = { unit: out, over: [] }
  const segmented = SEGMENTS.some((ch) => {
    const f = obj(enc[ch])?.field
    return typeof f === 'string' && f !== cat.field && f !== offset?.field
  })
  // the rows say each bar's value when each bar is one row of them, its value a plain field
  const drawn = (own || !transformed(unit, root)) && typeof value.field === 'string' && !value.aggregate && !value.bin ? rows : null
  const keys = drawn?.map((r) => JSON.stringify([obj(r)?.[unescaped(cat.field)] ?? null, offset ? (obj(r)?.[unescaped(offset.field)] ?? null) : null]))
  if (!drawn || !keys || new Set(keys).size !== keys.length || segmented || enc[horizontal ? 'xOffset' : 'yOffset'] || color?.condition) return none
  const bars = distinct(drawn, cat.field) * (offset ? distinct(drawn, offset.field) : 1)
  const room = horizontal ? bars <= VALUE_ROWS : bars * VALUE_ROOM <= (opts.width ?? 0)
  if (value.stack === 'normalize' || value.stack === 'center' || color?.field === FOLD_FIELD || !room || siblings.some(labelsRows)) return none
  // a bar with an interval (a rule over the same rows, from its low end to its high end) has its value past the end
  const rule = siblings.find((l) => markType(l.mark) === 'rule' && !l.data && obj(obj(l.encoding)?.[`${v}2`]))
  const lo = rule ? obj(obj(rule.encoding)![v])?.field : null
  const hi = rule ? obj(obj(rule.encoding)![`${v}2`])?.field : null
  const below = `${read(value.field)} < 0`
  const transform = lo != null && hi != null ? [{ calculate: `${below} ? min(${read(value.field)}, ${read(lo)}) : max(${read(value.field)}, ${read(hi)})`, as: LABEL_AT }] : null
  const place = horizontal
    ? { align: { expr: `${below} ? 'right' : 'left'` }, baseline: 'middle', dx: { expr: `${below} ? -5 : 5` } }
    : { align: 'center', baseline: { expr: `${below} ? 'top' : 'bottom'` }, dy: { expr: `${below} ? 5 : -5` } }
  // each value in its bar's color, from the bars' scale (so it adds no legend of its own), else in the bars' one color
  const fixed = typeof color?.value === 'string' ? color.value : barColor(unit.mark) ?? opts.palette?.[0]
  const of = typeof color?.field === 'string' ? `scale('color', ${read(color.field)})` : fixed ? JSON.stringify(fixed) : null
  const label: Spec = {
    mark: { type: 'text', ...place, fontSize: BLOG_TYPE.value, fontWeight: 600, ...(of ? { color: { expr: valueTone(of) } } : {}) },
    encoding: {
      [c]: next[c],
      // the value's channel as the bars have it (its axis, scale and title), so the layers share one axis
      [v]: { ...obj(next[v])!, field: transform ? LABEL_AT : value.field },
      text: { field: value.field, type: 'quantitative', format: valueFormat(value, drawn) },
      ...(offset ? { [off]: offset } : {}),
    },
    ...(transform ? { transform } : {}),
  }
  return { unit: out, over: [label] }
}

/** The one color a mark names for all it draws, when it names one. */
function barColor(mark: unknown): string | null {
  const m = obj(mark)
  return typeof m?.color === 'string' ? m.color : typeof m?.fill === 'string' ? m.fill : null
}

/** Whether a layer writes text over the chart's own rows (a card's value labels): such a chart gets no more. */
const labelsRows = (l: Spec): boolean => markType(l.mark) === 'text' && !l.data

/** The params that place the names of `ends.length` lines in one column, as signals Vega computes once the y scale
 * is known: `ends`, an expression of each line's end in px (down the plot from its top), the lines from the bottom of
 * the plot up. Each name is moved up past the one under it, then from the plot's top down each is moved under the one
 * above it, so no two come closer than `gap` px and none stands over the plot's top (blogpost-figure's right_labels).
 * The k-th name's place is the signal `${NAME_SIGNAL}_k`. Pure. */
export function nameParams(ends: readonly string[], gap: number): Spec[] {
  const up = (k: number) => `${NAME_SIGNAL}_up_${k}`
  const at = (k: number) => `${NAME_SIGNAL}_${k}`
  const last = ends.length - 1
  const ups = ends.map((end, k) => ({ name: up(k), expr: k ? `min(${end}, ${up(k - 1)} - ${gap})` : end }))
  const ats = ends.map((_, j) => last - j).map((k) => ({ name: at(k), expr: k < last ? `max(${up(k)}, ${at(k + 1)} + ${gap})` : `max(${up(k)}, 0)` }))
  return [...ups, ...ats]
}

/**
 * Blog's lines (module note) of a line chart: each line's name in one column at the plot's right edge, at its last
 * value's height and moved up or down only as far as it must to clear the others (nameParams), in its color and in
 * place of the legend; a single line's last value there. A chart whose rows do not say where its lines end, or of more
 * lines than END_LINES, keeps its legend, as a row. Null for any other unit, and in a facet's panels, which their
 * headers name.
 */
function blogLines(unit: Spec, rows: unknown[] | null, root: Spec, own: boolean, opts: FigureSpecOptions): Changed | null {
  if (markType(unit.mark) !== 'line' || obj(root.facet)) return null
  const enc = obj(unit.encoding)!
  const x = obj(enc.x)
  const y = obj(enc.y)
  const color = obj(enc.color)
  if (!continuous(x) || !quantitative(y) || (color && !discrete(color))) return null
  const kept: Changed = { unit: color ? { ...unit, encoding: { ...enc, color: legendRow(color) } } : unit, over: [] }
  // where each line ends, from the rows the chart draws as they are: no transform, aggregate, bin or stack between them,
  // and a y scale of the chart's own, which the names are placed on
  const plain = !x.aggregate && !x.bin && !x.timeUnit && !y.aggregate && (y.stack == null || y.stack === false) && obj(obj(root.resolve)?.scale)?.y !== 'independent'
  const drawn = plain && (own || !transformed(unit, root)) && color?.field !== FOLD_FIELD ? rows : null
  if (!drawn) return kept
  const [xf, yf, sf] = [unescaped(x.field), unescaped(y.field), color ? unescaped(color.field) : null]
  const at = (r: Spec): number => {
    const v = r[xf]
    return typeof v === 'number' ? v : x.type === 'temporal' && typeof v === 'string' ? Date.parse(v) : NaN
  }
  // each line's last point: its greatest x that has a y
  const ends = new Map<string, { row: Spec; x: number; y: number }>()
  for (const r of drawn) {
    const o = obj(r)
    const yv = o?.[yf]
    if (!o || typeof yv !== 'number' || !Number.isFinite(yv) || !Number.isFinite(at(o))) continue
    const key = sf ? JSON.stringify(o[sf] ?? null) : ''
    const end = ends.get(key)
    if (!end || at(o) >= end.x) ends.set(key, { row: o, x: at(o), y: yv })
  }
  // a log scale has no place for an end at zero or under it, so such a chart keeps its legend
  const log = obj(y.scale)?.type === 'log'
  if (!ends.size || ends.size > END_LINES || (log && [...ends.values()].some((e) => e.y <= 0))) return kept
  // the names from the bottom of the plot up: by their ends' values, or the other way on a y axis turned upside down
  const down = (obj(y.scale)?.reverse === true) !== (y.sort === 'descending')
  const list = [...ends.values()].sort((a, b) => (down ? b.y - a.y : a.y - b.y))
  const single = !color
  const values = list.map((e, k) => ({ [yf]: e.y, [LABEL_RANK]: k, ...(sf ? { [sf]: e.row[sf] } : {}), [LABEL_TEXT]: sf ? String(e.row[sf] ?? '') : e.y }))
  const params = nameParams(list.map((e) => `scale('y', ${JSON.stringify(e.y)})`), NAME_ROOM)
  const placed = `[${list.map((_, k) => `${NAME_SIGNAL}_${k}`).join(', ')}][${read(LABEL_RANK)}] - scale('y', ${read(yf)})`
  const tone = barColor(unit.mark) ?? opts.palette?.[0]
  const label: Spec = {
    data: { values },
    mark: { type: 'text', align: 'left', baseline: 'middle', dx: NAME_PAD, dy: { expr: placed }, fontSize: BLOG_TYPE.label, fontWeight: single ? 600 : 500, ...(single && tone ? { color: tone } : {}) },
    // at the plot's right edge; on the line's own y channel, each end under the line's field, so the layers share one
    // axis, and in the line's color
    encoding: {
      x: { value: 'width' },
      y,
      text: single ? { field: LABEL_TEXT, type: 'quantitative', format: valueFormat(y, drawn) } : { field: LABEL_TEXT, type: 'nominal' },
      ...(color ? { color: { ...color, legend: null } } : {}),
    },
  }
  return { unit: color ? { ...unit, encoding: { ...enc, color: { ...color, legend: null } } } : unit, over: [label], params }
}

/**
 * Blog's heatmap (module note) of thimble.chart's: each cell's value over it, semibold, white on a dark cell and in ink
 * on a light one by the luminance of the cell's color, so on either paper; the color bar goes. Null for any other unit,
 * and for a heatmap of more cells than CELL_VALUES or of columns too narrow for a value (VALUE_ROOM).
 */
function blogCells(unit: Spec, rows: unknown[] | null, opts: FigureSpecOptions): Changed | null {
  if (markType(unit.mark) !== 'rect' || !rows) return null
  const enc = obj(unit.encoding)!
  const [x, y, color] = [obj(enc.x), obj(enc.y), obj(enc.color)]
  if (!discrete(x) || !discrete(y) || !quantitative(color) || rows.length > CELL_VALUES || distinct(rows, x.field) * VALUE_ROOM > (opts.width ?? 0)) return null
  const at = read(color.field)
  const label: Spec = {
    mark: { type: 'text', fontSize: BLOG_TYPE.label, fontWeight: 600, color: { expr: `luminance(scale('color', ${at})) > ${LIGHT_CELL} ? '${CELL_INK}' : '#ffffff'` } },
    encoding: { x, y, text: { field: color.field, type: 'quantitative', format: valueFormat(color, rows) } },
    transform: [{ filter: `isValid(${at}) && isFinite(${at})` }],
  }
  return { unit: { ...unit, encoding: { ...enc, color: { ...color, legend: null } } }, over: [label] }
}

/** Paper's lines (module note) of a line chart with several lines: each line's dash by its line (PAPER_DASHES), and its
 * dots' shape while each line has at most LINE_DOTS values (none past that; a chart whose rows do not say keeps its own
 * dots), named by the color's legend, with which they merge; lines without dots have swatches there long enough to show
 * their dashes. Null for any other unit. */
function paperLines(unit: Spec, rows: unknown[] | null, root: Spec, own: boolean): Changed | null {
  if (markType(unit.mark) !== 'line') return null
  const enc = obj(unit.encoding)!
  const color = obj(enc.color)
  if (!discrete(color) || color.field === FOLD_FIELD || enc.strokeDash || enc.shape) return null
  const domain = obj(color.scale)?.domain
  const by: Spec = { field: color.field, type: color.type ?? 'nominal', title: titleOf(color), ...('sort' in color ? { sort: color.sort } : {}), ...(color.legend === null ? { legend: null } : {}) }
  const dash: Spec = { ...by, scale: { ...(Array.isArray(domain) ? { domain } : {}), range: PAPER_DASHES } }
  // the most values a line has, from the rows the chart draws as they are
  const drawn = own || !transformed(unit, root) ? rows : null
  const counts = new Map<string, number>()
  for (const r of drawn ?? []) {
    const key = JSON.stringify(obj(r)?.[unescaped(color.field)] ?? null)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const mark = obj(unit.mark) ?? { type: 'line' }
  const dots = drawn ? Math.max(0, ...counts.values()) <= LINE_DOTS : !!mark.point && mark.point !== 'transparent'
  const point = drawn ? (dots ? (obj(mark.point) ?? true) : false) : mark.point
  const shape: Spec = { ...by, ...(Array.isArray(domain) ? { scale: { domain } } : {}) }
  // a stroke swatch is as long as the root of its size; a legend of the channel's own would show a legend the chart's
  // config turns off (a Paper figure's, figures/figure paperSpec), so such a chart is given none
  const legends = obj(obj(root.config)?.legend)?.disable !== true
  const keyed = !dots && legends && color.legend !== null ? { ...color, legend: { symbolSize: PAPER_SWATCH ** 2, ...(obj(color.legend) ?? {}) } } : color
  return { unit: { ...unit, mark: point === undefined ? unit.mark : { ...mark, point }, encoding: { ...enc, color: keyed, strokeDash: dash, ...(dots ? { shape } : {}) } }, over: [] }
}
