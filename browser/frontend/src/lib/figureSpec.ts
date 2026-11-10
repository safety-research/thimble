// What a chart of thimble.chart's (backend kernel_thimble CHARTS) is given in a figure style (lib/theme FigureStyle)
// before it is drawn (lib/vegaDraw drawChart), after a card's defaults (lib/chartDefaults): the changes the style's
// config (lib/vizTheme vegaConfig) cannot make alone. It is keyed on the style, so a style switch redraws every chart
// without running a card again. Pure.
//
// Blog (blogpost-figure's labels, not legends): a bar carries its value at its end, in its series color and semibold,
// past the end of its interval when it has one; the lines of a line chart are named at their right ends in their colors
// in place of a legend, and a single line carries its last value there; a bar chart's legend is a row over the chart,
// untitled, its names in their colors; a horizontal bar chart's gridlines run down from its x axis; a heatmap's cells
// carry their values in place of a color bar, white on a dark cell and ink on a light one. Paper (paper-figure's): the
// lines of a line chart differ by dash, and their dots by shape, as well as by color.
// A chart thimble.chart did not make takes the style's config alone: thimble.chart's charts hold their rows inline and
// give their marks a tooltip of every column, and a card's own Altair chart, whose rows are named, does not.
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
/** the height of a plot whose spec and config name none (Vega-Lite's), px */
const PLOT_HEIGHT = 300
/** the room a line's name keeps above and below it, px, so names of lines that end close together do not overprint */
const NAME_ROOM = 17
/** the most cells of a heatmap that carry their values */
export const CELL_VALUES = 80
/** the luminance of a cell's color above which its value is in ink, under it white; the ink, blogpost-figure's, on a
 * light cell on either paper */
const LIGHT_CELL = 0.4
const CELL_INK = '#1f1f1e'
/** the field a value or a name is placed at, past an interval's end or moved clear of another name */
export const LABEL_AT = '__thimble_label_at'
/** the field a line's name is read from */
export const LABEL_TEXT = '__thimble_label'

const DISCRETE = new Set(['nominal', 'ordinal'])
const markType = (mark: unknown): string => (typeof mark === 'string' ? mark : String(obj(mark)?.type ?? ''))
const discrete = (def: Spec | null): def is Spec => !!def && typeof def.field === 'string' && DISCRETE.has(String(def.type ?? 'nominal'))
const quantitative = (def: Spec | null): def is Spec => !!def && typeof def.field === 'string' && def.type === 'quantitative'
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

/**
 * The spec as the figure style draws it (module note); a spec of thimble's own style, or any other spec, comes back as
 * it is.
 */
export function figureSpec(spec: unknown, style: FigureStyle, opts: FigureSpecOptions = {}): unknown {
  const s = obj(spec)
  if (style === 'thimble' || !s || !(typeof s.$schema === 'string' && s.$schema.includes('vega-lite'))) return spec
  return withUnit(s, (unit, siblings, rows, root) =>
    style === 'blog' ? (blogBars(unit, siblings, rows, opts) ?? blogLines(unit, rows, root, opts) ?? blogCells(unit, rows, opts)) : paperLines(unit, rows),
  )
}

/** What a change makes of a unit: the unit, and layers to draw over the chart's. */
type Changed = { unit: Spec; over: Spec[] }
type Change = (unit: Spec, siblings: readonly Spec[], rows: unknown[] | null, root: Spec) => Changed | null

/** The chart with `change` made to its first unit that it changes: a unit chart (which becomes a layer when the change
 * draws over it), a layer of the chart's, or a layer of a facet's panel; a unit with its own panels (a row channel) is
 * left as it is, since a layer cannot hold one. */
function withUnit(s: Spec, change: Change): Spec {
  const own = (v: unknown): unknown[] | null => (Array.isArray(obj(obj(v)?.data)?.values) ? (obj(obj(v)!.data)!.values as unknown[]) : null)
  if (obj(s.encoding) && s.mark != null) {
    const enc = obj(s.encoding)!
    if (enc.row || enc.column || enc.facet || s.params) return s
    const got = change(s, [], own(s), s)
    if (!got) return s
    if (!got.over.length) return got.unit
    const { mark, encoding, ...rest } = got.unit
    return { ...rest, layer: [{ mark, encoding }, ...got.over] }
  }
  const layered = (host: Spec, rows: unknown[] | null): Spec | null => {
    const layers = Array.isArray(host.layer) ? (host.layer as unknown[]) : null
    if (!layers) return null
    for (let i = 0; i < layers.length; i++) {
      const l = obj(layers[i])
      if (!l || !obj(l.encoding) || l.params) continue
      const got = change(l, layers.filter((_, j) => j !== i).map((x) => obj(x) ?? {}), own(l) ?? rows, s)
      if (!got) continue
      return { ...host, layer: [...layers.slice(0, i), got.unit, ...layers.slice(i + 1), ...got.over] }
    }
    return null
  }
  const top = layered(s, own(s))
  if (top) return top
  const inner = obj(s.spec)
  if (obj(s.facet) && inner) {
    const changed = layered(inner, own(inner) ?? own(s))
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

/** A color channel's legend as Blog draws one that stays: a row over the chart, untitled, square swatches, each name in
 * its color at the size of a direct label; what the spec names itself stands. */
function legendRow(color: Spec): Spec {
  if (color.legend === null) return color
  const row = { title: null, orient: 'top', direction: 'horizontal', symbolType: 'square', labelFontSize: BLOG_TYPE.label, labelFontWeight: 500, labelColor: { expr: "scale('color', datum.value)" } }
  return { ...color, legend: { ...row, ...(obj(color.legend) ?? {}) } }
}

/**
 * Blog's bars (module note) of a bar chart of thimble.chart's whose categories stand on one axis and values on the other
 * (no histogram, no bars over time): a horizontal chart's gridlines turned to run down from its x axis, a legend turned
 * into a row, and the values over the bars when each has room (VALUE_ROOM, VALUE_ROWS), in their bars' colors; a stack's
 * segments carry none. Null for any other unit.
 */
function blogBars(unit: Spec, siblings: readonly Spec[], rows: unknown[] | null, opts: FigureSpecOptions): Changed | null {
  if (markType(unit.mark) !== 'bar' || !ownChart(unit, rows)) return null
  const enc = obj(unit.encoding)!
  const x = obj(enc.x)
  const y = obj(enc.y)
  const horizontal = quantitative(x) && discrete(y)
  if (!horizontal && !(quantitative(y) && discrete(x))) return null
  const [v, c, off] = horizontal ? (['x', 'y', 'yOffset'] as const) : (['y', 'x', 'xOffset'] as const)
  const value = obj(enc[v])!
  const cat = obj(enc[c])!
  const offset = obj(enc[off])
  const color = obj(enc.color)
  const next: Spec = { ...enc }
  if (horizontal && !('grid' in (obj(value.axis) ?? {})) && value.axis !== null) next[v] = { ...value, axis: { ...(obj(value.axis) ?? {}), grid: true } }
  if (color && color.field !== cat.field) next.color = legendRow(color)
  const out: Spec = { ...unit, encoding: next }
  const stacked = !!color && !offset && color.field !== cat.field
  const bars = distinct(rows!, cat.field) * (offset ? distinct(rows!, offset.field) : 1)
  const room = horizontal ? bars <= VALUE_ROWS : bars * VALUE_ROOM <= (opts.width ?? 0)
  if (stacked || value.stack === 'normalize' || color?.field === FOLD_FIELD || !room || siblings.some(labelsRows)) return { unit: out, over: [] }
  // a bar with an interval (a rule over the same rows, from its low end to its high end) has its value past the end
  const rule = siblings.find((l) => markType(l.mark) === 'rule' && !l.data && obj(obj(l.encoding)?.[`${v}2`]))
  const lo = rule ? obj(obj(rule.encoding)![v])?.field : null
  const hi = rule ? obj(obj(rule.encoding)![`${v}2`])?.field : null
  const below = `${read(value.field)} < 0`
  const transform = lo != null && hi != null ? [{ calculate: `${below} ? min(${read(value.field)}, ${read(lo)}) : max(${read(value.field)}, ${read(hi)})`, as: LABEL_AT }] : null
  const place = horizontal
    ? { align: { expr: `${below} ? 'right' : 'left'` }, baseline: 'middle', dx: { expr: `${below} ? -5 : 5` } }
    : { align: 'center', baseline: { expr: `${below} ? 'top' : 'bottom'` }, dy: { expr: `${below} ? 5 : -5` } }
  const label: Spec = {
    mark: { type: 'text', ...place, fontSize: BLOG_TYPE.value, fontWeight: 600, ...(color ? {} : { color: opts.palette?.[0] }) },
    encoding: {
      [c]: cat,
      // the value's channel as the bars have it (its axis, scale and title), so the layers share one axis
      [v]: { ...obj(next[v])!, field: transform ? LABEL_AT : value.field },
      text: { field: value.field, type: 'quantitative', format: valueFormat(value, rows!) },
      ...(offset ? { [off]: offset } : {}),
      // the bars' color as they have it, legend and all, so the two layers' legends are one
      ...(color ? { color: next.color } : {}),
    },
    ...(transform ? { transform } : {}),
  }
  return { unit: out, over: [label] }
}

/** Whether a layer writes text over the chart's own rows (a card's value labels): such a chart gets no more. */
const labelsRows = (l: Spec): boolean => markType(l.mark) === 'text' && !l.data

/** The y at which each of `ys` is named so no two names come closer than `gap`, kept inside lo to hi: each name pushed up
 * past the one under it, then from the top down, the top one at hi at most, each pushed down under the one above it
 * (blogpost-figure's right_labels). Pure. */
export function spreadNames(ys: readonly number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b])
  const at = ys.slice()
  for (let k = 1; k < order.length; k++) at[order[k]] = Math.max(at[order[k]], at[order[k - 1]] + gap)
  for (let k = order.length - 1; k >= 0; k--) at[order[k]] = Math.max(lo, Math.min(at[order[k]], k === order.length - 1 ? hi : at[order[k + 1]] - gap))
  return at
}

/**
 * Blog's lines (module note) of a line chart of thimble.chart's: each line's name at its last point, in its color and in
 * place of the legend, moved up or down only as far as it must to clear the others (spreadNames); a single line's last
 * value there. Null for any other unit, and for a chart of more lines than END_LINES, which keeps its legend.
 */
function blogLines(unit: Spec, rows: unknown[] | null, root: Spec, opts: FigureSpecOptions): Changed | null {
  if (markType(unit.mark) !== 'line' || !ownChart(unit, rows)) return null
  const enc = obj(unit.encoding)!
  const x = obj(enc.x)
  const y = obj(enc.y)
  const color = obj(enc.color)
  if (!continuous(x) || !quantitative(y) || (color && (!discrete(color) || color.field === FOLD_FIELD))) return null
  const [xf, yf, sf] = [unescaped(x.field), unescaped(y.field), color ? unescaped(color.field) : null]
  const at = (r: Spec): number => {
    const v = r[xf]
    return typeof v === 'number' ? v : x.type === 'temporal' && typeof v === 'string' ? Date.parse(v) : NaN
  }
  // each line's last point: its greatest x that has a y
  const ends = new Map<string, { row: Spec; x: number; y: number }>()
  let lo = Infinity
  let hi = -Infinity
  for (const r of rows!) {
    const o = obj(r)
    const yv = o?.[yf]
    if (!o || typeof yv !== 'number' || !Number.isFinite(yv) || !Number.isFinite(at(o))) continue
    lo = Math.min(lo, yv)
    hi = Math.max(hi, yv)
    const key = sf ? JSON.stringify(o[sf] ?? null) : ''
    const end = ends.get(key)
    if (!end || at(o) >= end.x) ends.set(key, { row: o, x: at(o), y: yv })
  }
  if (!ends.size || ends.size > END_LINES) return null
  if (obj(y.scale)?.zero !== false) [lo, hi] = [Math.min(lo, 0), Math.max(hi, 0)]
  const view = obj(obj(root.config)?.view)
  const plot = typeof root.height === 'number' ? root.height : typeof view?.continuousHeight === 'number' ? view.continuousHeight : PLOT_HEIGHT
  const list = [...ends.values()]
  const placed = spreadNames(list.map((e) => e.y), ((hi - lo) * NAME_ROOM) / plot, lo, hi)
  const single = !color
  const values = list.map((e, i) => ({ [xf]: e.row[xf], [LABEL_AT]: placed[i], ...(sf ? { [sf]: e.row[sf] } : {}), [LABEL_TEXT]: sf ? String(e.row[sf] ?? '') : e.y }))
  const label: Spec = {
    data: { values },
    mark: { type: 'text', align: 'left', baseline: 'middle', dx: 8, fontSize: BLOG_TYPE.label, fontWeight: single ? 600 : 500, ...(single ? { color: opts.palette?.[0] } : {}) },
    // the line's channels as it has them, so the layers share their axes; the names stand at their own y
    encoding: {
      x,
      y: { ...y, field: LABEL_AT },
      text: single ? { field: LABEL_TEXT, type: 'quantitative', format: valueFormat(y, rows!) } : { field: LABEL_TEXT, type: 'nominal' },
      ...(color ? { color: { ...color, legend: null } } : {}),
    },
  }
  return { unit: color ? { ...unit, encoding: { ...enc, color: { ...color, legend: null } } } : unit, over: [label] }
}

/**
 * Blog's heatmap (module note) of thimble.chart's: each cell's value over it, semibold, white on a dark cell and in ink
 * on a light one by the luminance of the cell's color, so on either paper; the color bar goes. Null for any other unit,
 * and for a heatmap of more cells than CELL_VALUES or of columns too narrow for a value (VALUE_ROOM).
 */
function blogCells(unit: Spec, rows: unknown[] | null, opts: FigureSpecOptions): Changed | null {
  if (markType(unit.mark) !== 'rect' || !ownChart(unit, rows)) return null
  const enc = obj(unit.encoding)!
  const [x, y, color] = [obj(enc.x), obj(enc.y), obj(enc.color)]
  if (!discrete(x) || !discrete(y) || !quantitative(color) || rows!.length > CELL_VALUES || distinct(rows!, x.field) * VALUE_ROOM > (opts.width ?? 0)) return null
  const at = read(color.field)
  const label: Spec = {
    mark: { type: 'text', fontSize: BLOG_TYPE.value, fontWeight: 600, color: { expr: `luminance(scale('color', ${at})) > ${LIGHT_CELL} ? '${CELL_INK}' : '#ffffff'` } },
    encoding: { x, y, text: { field: color.field, type: 'quantitative', format: valueFormat(color, rows!) } },
    transform: [{ filter: `isValid(${at}) && isFinite(${at})` }],
  }
  return { unit: { ...unit, encoding: { ...enc, color: { ...color, legend: null } } }, over: [label] }
}

/** Paper's lines (module note) of a line chart of thimble.chart's with several lines: each line's dash, and its dots'
 * shape when it has dots, by its line, named by the color's legend, with which they merge. Null for any other unit. */
function paperLines(unit: Spec, rows: unknown[] | null): Changed | null {
  if (markType(unit.mark) !== 'line' || !ownChart(unit, rows)) return null
  const enc = obj(unit.encoding)!
  const color = obj(enc.color)
  if (!discrete(color) || color.field === FOLD_FIELD || enc.strokeDash || enc.shape) return null
  const domain = obj(color.scale)?.domain
  const by: Spec = { field: color.field, type: color.type ?? 'nominal', title: titleOf(color), ...('sort' in color ? { sort: color.sort } : {}), ...(Array.isArray(domain) ? { scale: { domain } } : {}), ...(color.legend === null ? { legend: null } : {}) }
  const dots = obj(unit.mark)?.point === true
  return { unit: { ...unit, encoding: { ...enc, strokeDash: by, ...(dots ? { shape: by } : {}) } }, over: [] }
}
