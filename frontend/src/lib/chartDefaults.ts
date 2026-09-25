// What a Vega-Lite chart on a card is given before it is drawn (components/Outputs' Vega), so a chart made with Altair's
// defaults reads well at a card's width. Pure.
//
// It fixes legends that squeeze the plot or repeat facet groups, rotated x labels, titles that repeat the card's
// question, repeated facet y titles, merged layer axis titles, and y titles that overprint labels (Vega measures labels
// narrower than it draws them). Legends past FOLD_GROUPS colours fold the rest into a grey "other (n)" without summing.
// Long bar categories turn horizontal; whole-number axes step by whole numbers; discrete y axes get ROW_STEP per row.
// A colour channel over a label's classes takes the label's colours (labelColours).

type Spec = Record<string, unknown>
const obj = (v: unknown): Spec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Spec) : null)

/** below this width a legend goes under the chart rather than beside it */
export const LEGEND_BOTTOM_BELOW = 900
/** x labels this short, at most, read across; longer ones keep Vega-Lite's angle, or turn a bar chart horizontal */
const SHORT_LABEL = 12
/** the colour groups a chart shows apart; the rest fold into one */
export const FOLD_GROUPS = 7
/** the field a folded chart colours by: the group, or "other (n)" for a folded one */
export const FOLD_FIELD = '__thimble_group'
/** the height a row of a discrete y axis needs for its label to show at the theme's label size and separation (11 px
 * and 6 px, lib/vizTheme, which the overlap rule measures), with a pixel to spare; an axis that sets its own label size
 * or separation gets a step of those (rowStep) */
export const ROW_STEP = 18
const LABEL_PX = 11
const LABEL_GAP = 6
/** the aggregates that keep whole numbers whole (a count is always whole) */
const WHOLE_AGGREGATES = new Set(['count', 'distinct', 'valid', 'missing'])
const KEEPS_WHOLE = new Set(['sum', 'min', 'max'])
const COLOR_CHANNELS = ['color', 'fill', 'stroke']
const FACET_CHANNELS = ['row', 'column', 'facet']
const DISCRETE = new Set(['nominal', 'ordinal'])

export interface ChartOptions {
  /** the room the chart has, px */
  width?: number
  /** the chart is a card's: the card's question stands above it, so the chart's own title goes, unless it is what
   * explains marks no axis or legend explains (unexplainedMarks) */
  card?: boolean
  /** the colours a folded chart gives its groups, in order, and the grey of its "other (n)" (lib/vizTheme); without them
     * the folded groups keep the theme's category colours, "other" last */
  palette?: readonly string[]
  other?: string
  /** the classes of each label the card uses, in the card's order (labelColours) */
  labels?: readonly (readonly LabelClassColour[])[]
  /** the inks a value no label defines takes in turn, read per theme (lib/vizTheme VIZ_NEUTRAL) */
  neutral?: readonly string[]
}

/** A class of a label, with the colour the label gives it (files/labels, the token's value); `none` when that colour is
 * the label's grey, a negative's such as "other". */
export interface LabelClassColour {
  name: string
  colour: string
  none?: boolean
}

/** A field definition's title as Vega-Lite would show it: its own title, else its field's name. */
const titleOf = (def: Spec | null): string | null | undefined => (!def ? undefined : 'title' in def ? (def.title as string | null) : typeof def.field === 'string' ? def.field : undefined)

function rowsOf(s: Spec, root: Spec, inherited: unknown[] | null): unknown[] | null {
  const data = obj(s.data)
  if (!data) return inherited
  if (Array.isArray(data.values)) return data.values
  if (typeof data.name === 'string') {
    const set = obj(root.datasets)?.[data.name]
    return Array.isArray(set) ? set : null
  }
  return null
}

/** The longest text of `field` among the rows, or null when the rows are not in the spec. */
function longestLabel(rows: unknown[] | null, field: string): number | null {
  if (!rows) return null
  let n = 0
  for (const r of rows) {
    const v = obj(r)?.[field]
    if (v != null) n = Math.max(n, String(v).length)
  }
  return n
}

const DAY_MS = 86_400_000

/** The d3-time-format pattern for a date axis over `field`, by the span of its values, or null when the rows hold no
 * time. Every label names its month (Vega-Lite's own labels mix weekdays and months on one axis); the hour shows only
 * within a few days. Values are read as Vega-Lite reads them, in local time. */
export function timeFormat(rows: readonly unknown[] | null, field: string): string | null {
  if (!rows) return null
  let lo = Infinity
  let hi = -Infinity
  for (const r of rows) {
    const v = obj(r)?.[field]
    const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
    if (!Number.isFinite(t)) continue
    lo = Math.min(lo, t)
    hi = Math.max(hi, t)
  }
  if (!Number.isFinite(lo)) return null
  const span = hi - lo
  if (span < DAY_MS && new Date(lo).toDateString() === new Date(hi).toDateString()) return '%H:%M'
  if (span < 3 * DAY_MS) return '%b %-d %H:%M'
  if (span < 540 * DAY_MS) return '%b %-d'
  return '%b %Y'
}

/** A unit's encoding with its legends that repeat a facet's groups or the discrete axis's labels taken off, its binned
 * ticks written without trailing zeros, a long-labelled discrete y axis's title over its labels, and its short
 * discrete x labels turned to read across. */
function fixUnit(enc: Spec, facetFields: ReadonlySet<string>, rows: unknown[] | null): Spec {
  const out: Spec = { ...enc }
  const x = obj(enc.x)
  const y = obj(enc.y)
  const axisFields = new Set([x, y].filter((d) => d && typeof d.field === 'string' && DISCRETE.has(String(d.type ?? 'nominal'))).map((d) => String(d!.field)))
  const own = new Set(FACET_CHANNELS.map((c) => obj(enc[c])?.field).filter((f): f is string => typeof f === 'string'))
  for (const ch of COLOR_CHANNELS) {
    const def = obj(enc[ch])
    if (!def || typeof def.field !== 'string' || def.legend === null) continue
    if (facetFields.has(def.field) || own.has(def.field) || axisFields.has(def.field)) out[ch] = { ...def, legend: null }
  }
  // a binned axis's ticks without the zeros Vega-Lite writes after a whole number ("4.0"), and a date axis's labels each
  // naming their month (timeFormat)
  for (const ch of ['x', 'y'] as const) {
    const def = obj(out[ch])
    if (!def || def.axis === null) continue
    const axis = obj(def.axis) ?? {}
    if ('format' in axis || 'labelExpr' in axis) continue
    if (def.bin) out[ch] = { ...def, axis: { ...axis, format: '~g' } }
    else if (def.type === 'temporal' && !def.timeUnit && typeof def.field === 'string') {
      const format = timeFormat(rows, def.field)
      if (format) out[ch] = { ...def, axis: { ...axis, format } }
    } else if (wholeAxis(def, rows)) out[ch] = { ...def, axis: { tickMinStep: 1, format: ',d', ...axis } }
  }
  // a discrete y axis with long labels (a bar chart of named kinds) has its title over the label column, where Vega
  // would otherwise turn it beside labels it measured short and let the two overprint
  if (y && typeof y.field === 'string' && DISCRETE.has(String(y.type ?? 'nominal')) && y.axis !== null && titleOf(y)) {
    const axis = obj(y.axis) ?? {}
    const longest = longestLabel(rows, y.field)
    if (!('titleAngle' in axis) && longest != null && longest > SHORT_LABEL)
      out.y = { ...y, axis: { titleAngle: 0, titleAlign: 'right', titleAnchor: 'start', titleBaseline: 'bottom', titleX: -4, titleY: -6, ...axis } }
  }
  if (x && typeof x.field === 'string' && DISCRETE.has(String(x.type ?? 'nominal')) && x.axis !== null) {
    const axis = obj(x.axis) ?? {}
    const longest = longestLabel(rows, x.field)
    if (!('labelAngle' in axis) && longest != null && longest <= SHORT_LABEL) out.x = { ...x, axis: { ...axis, labelAngle: 0 } }
  }
  return out
}

/** Whether a quantitative axis shows only whole numbers: a count, or a field whose values in the rows are all whole
 * under an aggregate that keeps them whole (none, a sum, a min, a max) on a linear scale that is not normalized. */
export function wholeAxis(def: Spec, rows: readonly unknown[] | null): boolean {
  if (def.type !== 'quantitative' || def.stack === 'normalize') return false
  const scale = obj(def.scale)
  if (scale && typeof scale.type === 'string' && scale.type !== 'linear') return false
  const agg = typeof def.aggregate === 'string' ? def.aggregate : def.aggregate == null ? null : 'other'
  if (agg && WHOLE_AGGREGATES.has(agg)) return true
  if ((agg && !KEEPS_WHOLE.has(agg)) || typeof def.field !== 'string' || !rows) return false
  let seen = false
  for (const r of rows) {
    const v = obj(r)?.[def.field]
    if (v == null) continue
    if (typeof v !== 'number' || !Number.isInteger(v)) return false
    seen = true
  }
  return seen
}

/** The y encoding a unit or a layered chart draws with (its first layer's for a layer). */
const yOf = (s: Spec): Spec | null => obj(obj(s.encoding)?.y) ?? (Array.isArray(s.layer) ? obj(obj(obj(s.layer[0])?.encoding)?.y) : null)

/** The height a row of this discrete y axis needs for its label to show (ROW_STEP at the theme's label size). */
function rowStep(y: Spec): number {
  const axis = obj(y.axis) ?? {}
  const px = typeof axis.labelFontSize === 'number' ? axis.labelFontSize : LABEL_PX
  const gap = typeof axis.labelSeparation === 'number' ? axis.labelSeparation : LABEL_GAP
  return Math.ceil(px + gap + 1)
}

/** A chart whose discrete y axis names its rows, sized so each row has the room its label needs (rowStep) when the
 * height it names gives them less (module note): the rows are counted in the chart's data; a y axis without labels, a
 * height left to Vega-Lite (a step of 20 already) or set by its container is left as it is. */
function rowsHeight(s: Spec, rows: unknown[] | null): Spec {
  const y = yOf(s)
  if (typeof s.height !== 'number' || !y || !discrete(y) || y.axis === null || obj(y.axis)?.labels === false || !rows) return s
  const n = new Set(rows.map((r) => obj(r)?.[String(y.field)]).filter((v) => v != null)).size
  const step = rowStep(y)
  return n * step > s.height ? { ...s, height: { step } } : s
}

/** Views side by side after rowsHeight: a view with a discrete y drawn at a sibling's old height takes the sibling's
 * new step, so their rows stay in line (margin bars beside a heatmap). */
function alignRows(before: unknown[], after: unknown[]): unknown[] {
  const stepped = new Map<number, Spec>()
  after.forEach((v, i) => {
    const h = obj(before[i])?.height
    const now = obj(obj(v)?.height)
    if (typeof h === 'number' && now && typeof now.step === 'number') stepped.set(h, now)
  })
  if (!stepped.size) return after
  return after.map((v, i) => {
    const o = obj(v)
    const h = obj(before[i])?.height
    const y = o ? yOf(o) : null
    const step = typeof h === 'number' ? stepped.get(h) : undefined
    return o && step && typeof o.height === 'number' && y && discrete(y) ? { ...o, height: step } : v
  })
}

/** A faceted chart's y title said once, as the rows' title at the left, instead of on every row's axis. */
function yTitleOnce(facetRow: Spec, unitEnc: Spec | null): { row: Spec; enc: Spec | null } {
  const y = unitEnc ? obj(unitEnc.y) : null
  const t = titleOf(y)
  if (!y || !t) return { row: facetRow, enc: unitEnc }
  return { row: { ...facetRow, title: t }, enc: { ...unitEnc, y: { ...y, title: null } } }
}

/** In a grid of rows and columns a row's name stays at the left of its row, turned, rather than over each panel of it
 * (vegaConfig's headerRow puts it over the panel, which in a grid repeats it in every column). */
function besideRows(row: Spec): Spec {
  return { ...row, header: { labelOrient: 'left', labelAngle: -90, labelAnchor: 'middle', labelAlign: 'center', labelBaseline: 'bottom', ...(obj(row.header) ?? {}) } }
}

const markType = (mark: unknown): string => (typeof mark === 'string' ? mark : String(obj(mark)?.type ?? ''))
const discrete = (def: Spec | null): boolean => !!def && typeof def.field === 'string' && DISCRETE.has(String(def.type ?? 'nominal'))
const quantitative = (def: Spec | null): boolean => !!def && def.type === 'quantitative'

/** The quantitative field groups are ranked by: y, else x, else size. */
function measureOf(enc: Spec): string | null {
  for (const c of ['y', 'x', 'size']) {
    const def = obj(enc[c])
    if (def && typeof def.field === 'string' && quantitative(def)) return def.field
  }
  return null
}

/** The values of `field` among the rows, ranked by the sum of the absolute values of `measure`, then by how many rows
 * they have, then by first appearance; each value as the rows hold it. Pure. */
export function rankGroups(rows: readonly unknown[], field: string, measure: string | null): unknown[] {
  const acc = new Map<string, { value: unknown; sum: number; n: number; first: number }>()
  rows.forEach((r, i) => {
    const o = obj(r)
    if (!o || !(field in o)) return
    const key = JSON.stringify(o[field] ?? null)
    const a = acc.get(key) ?? { value: o[field] ?? null, sum: 0, n: 0, first: i }
    const v = measure ? o[measure] : null
    if (typeof v === 'number' && Number.isFinite(v)) a.sum += Math.abs(v)
    a.n += 1
    acc.set(key, a)
  })
  return Array.from(acc.values())
    .sort((a, b) => b.sum - a.sum || b.n - a.n || a.first - b.first)
    .map((a) => a.value)
}

/** The values a colour channel groups by: its scale's domain when the spec names one, else the field's values in the
 * rows in their order; null when neither is known. */
function channelValues(def: Spec, rows: unknown[] | null): unknown[] | null {
  const domain = obj(def.scale)?.domain
  if (Array.isArray(domain)) return domain
  if (!rows) return null
  const field = String(def.field)
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const r of rows) {
    const v = obj(r)?.[field]
    if (v == null || seen.has(JSON.stringify(v))) continue
    seen.add(JSON.stringify(v))
    out.push(v)
  }
  return out.length ? out : null
}

/** The label whose classes name the most of `values`, at least one in a non-grey colour, so a chart whose values merely
 * include "other" is not taken for the label's; the first wins a tie. */
function labelOf(values: readonly unknown[], labels: readonly (readonly LabelClassColour[])[]): readonly LabelClassColour[] | null {
  let best: readonly LabelClassColour[] | null = null
  let most = 0
  for (const classes of labels) {
    const hit = classes.filter((c) => values.includes(c.name))
    if (hit.length > most && hit.some((c) => !c.none)) {
      best = classes
      most = hit.length
    }
  }
  return best
}

/** Vega-Lite's order for a nominal scale's values: ascending. */
const ascending = (a: unknown, b: unknown): number => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)

/**
 * A unit whose colour channel groups by a label's classes (labelOf) takes the label's colours, so the chart matches the
 * label's tag and card; other values take the neutral inks. The domain is the spec's own, else a `sort` list's order,
 * then the label's classes, then the other values sorted. A scheme gives way to the label's colours. A scale with its own
 * range is left alone unless its label colours are the label's (the kernel's thimble.colours): its other values then
 * take the theme's neutral inks.
 */
function labelColours(unit: Spec, rows: unknown[] | null, opts: ChartOptions): Spec {
  const enc = obj(unit.encoding)
  const neutral = opts.neutral ?? []
  if (!enc || !opts.labels?.length || !neutral.length) return unit
  let next: Spec | null = null
  for (const ch of COLOR_CHANNELS) {
    const def = obj(enc[ch])
    if (!def || !discrete(def) || def.condition || def.scale === null) continue
    const scale = obj(def.scale) ?? {}
    const values = channelValues(def, rows)
    const classes = values ? labelOf(values, opts.labels) : null
    if (!values || !classes) continue
    const colour = new Map(classes.map((c) => [c.name, c.colour]))
    const own = (v: unknown): string | undefined => (typeof v === 'string' ? colour.get(v) : undefined)
    if (Array.isArray(scale.range)) {
      const range = scale.range
      const same = Array.isArray(scale.domain) && scale.domain.every((v, i) => own(v) === undefined || String(range[i] ?? '').toLowerCase() === own(v)!.toLowerCase())
      if (!same) continue
    }
    let domain: unknown[]
    if (Array.isArray(scale.domain)) domain = scale.domain
    else {
      const sorted = Array.isArray(def.sort) ? def.sort.filter((v) => values.includes(v)) : []
      const unsorted = values.filter((v) => !sorted.includes(v))
      domain = [...sorted, ...classes.map((c) => c.name).filter((n) => unsorted.includes(n)), ...unsorted.filter((v) => own(v) === undefined).sort(ascending)]
    }
    let others = 0
    const range = domain.map((v) => own(v) ?? neutral[others++ % neutral.length])
    const { scheme: _scheme, ...rest } = scale
    next = { ...(next ?? enc), [ch]: { ...def, scale: { ...rest, domain, range } } }
  }
  return next ? { ...unit, encoding: next } : unit
}

/** A unit whose colour groups outnumber FOLD_GROUPS: the rest fold into one grey "other (n)" group, every row still
 * drawn (the `detail` channel keeps each line). A scale that names its domain or range, or a field Vega-Lite reads as a
 * path, is left alone. A scheme alone does not escape the fold, since schemes like `tableau20` are too alike at a dozen
 * groups. */
function foldGroups(unit: Spec, rows: unknown[] | null, opts: ChartOptions): Spec {
  const enc = obj(unit.encoding)
  if (!enc || !rows) return unit
  for (const ch of COLOR_CHANNELS) {
    const def = obj(enc[ch])
    if (!def || !discrete(def) || def.condition) continue
    const field = String(def.field)
    const scale = obj(def.scale) ?? {}
    if (/[.[\]]/.test(field) || 'domain' in scale || 'range' in scale) continue
    const ranked = rankGroups(rows, field, measureOf(enc))
    if (ranked.length <= FOLD_GROUPS) continue
    const kept = ranked.slice(0, FOLD_GROUPS)
    const other = `other (${ranked.length - FOLD_GROUPS})`
    const at = `datum[${JSON.stringify(field)}]`
    const calc = { calculate: `indexof(${JSON.stringify(kept)}, ${at}) >= 0 ? ${at} : ${JSON.stringify(other)}`, as: FOLD_FIELD }
    const { sort: _sort, ...rest } = def
    const { scheme: _scheme, ...own } = scale
    const range = opts.palette && opts.other ? { range: [...opts.palette.slice(0, FOLD_GROUPS), opts.other] } : {}
    const folded = { ...rest, field: FOLD_FIELD, title: titleOf(def) ?? field, scale: { ...own, domain: [...kept, other], ...range } }
    // the folded groups stay apart: a line per group, a bar segment per group, only their colour shared
    const detail = 'detail' in enc ? {} : { detail: { field, type: def.type ?? 'nominal' } }
    return { ...unit, transform: [...(Array.isArray(unit.transform) ? unit.transform : []), calc], encoding: { ...enc, [ch]: folded, ...detail } }
  }
  return unit
}

const SWAP: Record<string, string> = { x: 'y', y: 'x', x2: 'y2', y2: 'x2', xOffset: 'yOffset', yOffset: 'xOffset' }
const swapSort = (sort: unknown): unknown => {
  if (typeof sort === 'string') return sort.replace(/^(-?)(x|y)$/, (_, sign: string, ch: string) => sign + SWAP[ch])
  const o = obj(sort)
  return o && typeof o.encoding === 'string' && o.encoding in SWAP ? { ...o, encoding: SWAP[o.encoding] } : sort
}

/** A vertical bar chart whose category names run past SHORT_LABEL characters, turned horizontal: the categories on y,
 * where they read across, the numbers on x. A chart whose x labels have an angle of the author's, and one whose names
 * the spec does not hold, are left as they are. */
function turnBars(unit: Spec, rows: unknown[] | null): Spec {
  const enc = obj(unit.encoding)
  if (!enc || markType(unit.mark) !== 'bar') return unit
  const x = obj(enc.x)
  const y = obj(enc.y)
  if (!x || !y || !discrete(x) || !quantitative(y) || 'labelAngle' in (obj(x.axis) ?? {})) return unit
  const longest = longestLabel(rows, String(x.field))
  if (longest == null || longest <= SHORT_LABEL) return unit
  const turned: Spec = {}
  for (const [ch, def] of Object.entries(enc)) {
    const d = obj(def)
    turned[SWAP[ch] ?? ch] = d && 'sort' in d ? { ...d, sort: swapSort(d.sort) } : def
  }
  const mark = obj(unit.mark)
  const orient = mark && typeof mark.orient === 'string' ? { orient: mark.orient === 'vertical' ? 'horizontal' : 'vertical' } : {}
  return { ...unit, ...(mark ? { mark: { ...mark, ...orient } } : {}), encoding: turned }
}

function walk(s: Spec, root: Spec, facetFields: ReadonlySet<string>, inherited: unknown[] | null, opts: ChartOptions = {}): Spec {
  const rows = rowsOf(s, root, inherited)
  let out: Spec = { ...s }
  // a facet operator: its fields name the panels; a row facet takes the y title
  const facet = obj(s.facet)
  const inner = obj(s.spec)
  if (facet && inner) {
    const fields = new Set(facetFields)
    for (const c of ['row', 'column']) if (typeof obj(facet[c])?.field === 'string') fields.add(String(obj(facet[c])!.field))
    if (typeof facet.field === 'string') fields.add(facet.field)
    let spec = walk(inner, root, fields, rows, opts)
    let f: Spec = facet
    if (obj(facet.row) && obj(spec.encoding)) {
      const moved = yTitleOnce(obj(facet.row)!, obj(spec.encoding))
      f = { ...facet, row: obj(facet.column) ? besideRows(moved.row) : moved.row }
      spec = { ...spec, encoding: moved.enc }
    }
    out = { ...out, facet: f, spec }
  }
  // side by side, one over another: each part on its own
  for (const key of ['hconcat', 'vconcat', 'concat']) {
    const list = s[key]
    if (!Array.isArray(list)) continue
    const walked = list.map((c) => (obj(c) ? walk(obj(c)!, root, facetFields, rows, opts) : c))
    out[key] = key === 'hconcat' ? alignRows(list, walked) : walked
  }
  // layers: each fixed, and every layer's x and y titled as the first layer's, so the axis carries one title
  if (Array.isArray(s.layer)) {
    const layers = s.layer.map((c) => (obj(c) ? walk(obj(c)!, root, facetFields, rows, opts) : c))
    const first = obj(obj(layers[0])?.encoding)
    const titles = { x: titleOf(obj(first?.x)), y: titleOf(obj(first?.y)) }
    out.layer = layers.map((l, i) => {
      const ls = obj(l)
      const enc = obj(ls?.encoding)
      if (!i || !ls || !enc) return l
      const next: Spec = { ...enc }
      for (const ch of ['x', 'y'] as const) {
        const def = obj(enc[ch])
        if (def && titles[ch] !== undefined && !('title' in def)) next[ch] = { ...def, title: titles[ch] }
      }
      return { ...ls, encoding: next }
    })
  }
  // a unit (or one faceted by its own channels): bars turned, label colours and folding applied first, so the fixes
    // below read the encoding the chart is drawn with
  if (obj(out.encoding)) out = foldGroups(labelColours(turnBars(out, rows), rows, opts), rows, opts)
  const enc = obj(out.encoding)
  if (enc) {
    let fixed = fixUnit(enc, facetFields, rows)
    const row = obj(fixed.row)
    if (row) {
      const moved = yTitleOnce(row, fixed)
      fixed = { ...moved.enc!, row: obj(fixed.column) ? besideRows(moved.row) : moved.row }
    }
    out.encoding = fixed
  }
  return rowsHeight(out, rows)
}

/** the channels whose field a legend names */
const LEGEND_CHANNELS = ['color', 'fill', 'stroke', 'shape', 'size', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeDash']

/** Where a layer puts its marks: its x and y fields, aggregates and fixed values. */
const placement = (enc: Spec): unknown =>
  ['x', 'y'].map((c) => {
    const d = obj(enc[c])
    return d ? [d.field, d.aggregate, d.datum, d.value] : null
  })

/**
 * Whether a layered chart draws marks that neither its axes nor a legend explain: a fixed-style layer that draws other
 * rows or places than another layer. Only the chart's title explains such marks, so a card keeps that title. Text
 * layers and points on a line's vertices do not count. Pure.
 */
export function unexplainedMarks(s: Spec, inherited: unknown = null): boolean {
  const data = s.data ?? inherited
  if (Array.isArray(s.layer)) {
    // each drawing layer's encoding over the one its layers share, and what it draws: its rows and its places
    const drawn = s.layer
      .map(obj)
      .filter((l): l is Spec => !!l && !Array.isArray(l.layer) && markType(l.mark) !== 'text')
      .map((l) => {
        const enc = { ...(obj(s.encoding) ?? {}), ...(obj(l.encoding) ?? {}) }
        const transform = Array.isArray(l.transform) && l.transform.length ? l.transform : null
        return {
          fixed: !LEGEND_CHANNELS.some((c) => typeof obj(enc[c])?.field === 'string' && obj(enc[c])?.legend !== null),
          what: JSON.stringify([l.data ?? data, transform, placement(enc)]),
        }
      })
    if (drawn.some((d) => d.fixed && drawn.some((o) => o.what !== d.what))) return true
  }
  const parts = [...(['layer', 'hconcat', 'vconcat', 'concat'] as const).flatMap((k) => (Array.isArray(s[k]) ? (s[k] as unknown[]) : [])), s.spec]
  return parts.some((p) => !!obj(p) && unexplainedMarks(obj(p)!, data))
}

/**
 * The spec as a card draws it (see the module comment). On a card, the top-level title is dropped unless it explains
 * marks no axis or legend explains (unexplainedMarks). Any other spec is returned as it is.
 */
export function chartDefaults(spec: unknown, opts: ChartOptions = {}): unknown {
  const s0 = obj(spec)
  if (!s0 || !(typeof s0.$schema === 'string' && s0.$schema.includes('vega-lite'))) return spec
  let s: Spec = s0
  if (opts.card && 'title' in s && !unexplainedMarks(s)) {
    const { title: _title, ...rest } = s
    s = rest
  }
  s = walk(s, s0, new Set(), null, opts)
  const config = obj(s.config) ?? {}
  const legend = obj(config.legend) ?? {}
  if (opts.width && opts.width > 0 && opts.width < LEGEND_BOTTOM_BELOW && !('orient' in legend)) s = { ...s, config: { ...config, legend: { ...legend, orient: 'bottom' } } }
  return s
}

/** Whether a spec's legends sit at the right (Vega-Lite's default): its config names no other side. */
export function legendAtRight(s: Spec): boolean {
  const orient = obj(obj(s.config)?.legend)?.orient
  return orient == null || orient === 'right'
}
