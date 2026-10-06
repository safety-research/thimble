// A view's spec (view.json) and its rows (rows.json), as views/SPEC.md describes them, and the checks a builder's spec
// and a reader's rows must pass before the panel draws them. Pure: the hooks module, the panel's Client, the tests and
// tools/render_view.mjs share it.

export type Scalar = string | number | boolean | null
export type Value = Scalar | Scalar[]
export type Row = Record<string, Value>

export const FIELD_TYPES = ['text', 'category', 'number', 'time', 'duration', 'ref', 'list'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** One field of a collection's rows. `link` names the collection (or collections) whose key the field holds, a
 *  reference the analyst can follow; `derived` marks a field the reader made rather than read, with `from` and `how` in
 *  plain words. */
export type ViewField = {
  name: string
  type: FieldType
  label?: string
  unit?: string
  link?: string | string[]
  derived?: 'cleaned' | 'computed'
  from?: string
  how?: string
  /** values that are problems (an error, a denial, a failure), drawn in the error colour wherever the field shows */
  flag?: string[]
}

/** The collections a field links to. */
export function links(f: { link?: unknown } | undefined): string[] {
  const l = f?.link
  return typeof l === 'string' ? [l] : Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : []
}

export type Sort = { field: string; desc?: boolean }
export type Where = { field: string; is?: Value; not?: Value }

export type Column = { field: string; label?: string; show?: 'text' | 'bar' | 'chips'; width?: number }
/** `color`: a category field whose values colour each row's glyph, for a tab with no overview to name one (the file
 *  browser's file type). */
export type TableBody = { kind: 'table'; columns: Column[]; sort?: Sort; group?: string; color?: string }
export type ListBody = { kind: 'list'; meta?: string[]; text?: string; tags?: string[]; sort?: Sort; group?: string }
/** Marks on a time axis, a lane per value of `lane`, or per row of `lanes.collection` (whose key `lane` holds), each
 *  under its `parent` lane, the lanes under a heading per value of their `group`, with their `meta` fields in columns
 *  beside their names. */
export type LanesBody = {
  kind: 'lanes'
  lane: string
  time: string
  end?: string
  color?: string
  lanes?: { collection: string; label?: string; start?: string; end?: string; parent?: string; group?: string; meta?: string[] }
}
/** The tab's rows as boxes, an arrow from the row `edge` names to the row that names it; a tree of more than ten rows
 *  as an indented tree, each row's `meta` fields after it. */
export type GraphBody = { kind: 'graph'; edge: string; label?: string; meta?: string[] }
/** A bar per value of `field`, each stacked by the values of `color` when it is given. */
export type BarsBody = { kind: 'bars'; field: string; value?: string; agg?: 'count' | 'sum' | 'mean'; color?: string }
export type TranscriptBody = { kind: 'transcript'; speaker: string; text: string; time?: string; sort?: Sort }
/** Counts over time in a strip of bars, a bin per column, each bin in the colour of its commonest `color` value. */
export type HistogramBody = { kind: 'histogram'; time: string; color?: string }
export type Body = TableBody | ListBody | LanesBody | GraphBody | BarsBody | TranscriptBody | HistogramBody
/** A compact visual of every row of a tab, drawn above its records: a click on it narrows them (thimble's overview and
 *  zoom). */
export type Overview = HistogramBody | LanesBody | BarsBody | GraphBody
/** The tab's one filter row: the fields whose values the analyst picks (and the labels), and the fields search reads. */
export type Filter = { fields: string[]; search?: string[] }

/** Rows of another collection that name this row in `via`, drawn under its detail. */
export type Related = { title: string; collection: string; via: string; show: TableBody | ListBody | TranscriptBody; where?: Where }
/** `lines`: a list field holding the record's first lines, shown with their numbers under the title (the file
 *  browser's file, its first lines). */
export type Detail = { meta?: string[]; fields?: string[]; text?: string; related?: Related[]; lines?: string }

export type ViewCollection = {
  name: string
  one: string
  key: string
  title: string
  ref?: string
  fields: ViewField[]
  detail?: Detail
  /** a field holding a file's path: a click on a row opens that file in the file browser (the mod's own views) */
  opens?: string
}

export const AGGS = ['count', 'distinct', 'sum', 'mean', 'median', 'min', 'max', 'span'] as const
export type Agg = (typeof AGGS)[number]
export type Stat = { label: string; collection: string; agg: Agg; field?: string; where?: Where }

/** A tab follows thimble's proposal: an overview of all its rows, what a click on it narrows (zoom), one filter row,
 *  the records (body), and the selected row's details (its collection's `detail`). */
export type Tab = { name: string; collection: string; where?: Where; overview?: Overview; zoom: string; filter: Filter; body: Body[] }
export type Form = { form: string; means: string }

export type ViewSpec = {
  version: 1
  name: string
  slug: string
  description: string
  scope: string[]
  collections: ViewCollection[]
  stats?: Stat[]
  tabs: Tab[]
  labels?: boolean
  accepts?: Form[]
  units?: Form[]
  /** the mod's own views (the file browser, helper/files.py): the way back shown before the name, and the file shown */
  up?: string
  source?: string
  /** the lines (or a JSON list's items) of the file the view holds, when it holds one window of a longer file */
  window?: { from: number; to: number; total: number; unit: string }
}

/** A label over the view's files: its values, a colour per value where the analyst gave one, each marked record's
 *  value by its ref, and each unit's (a row that lists the refs it gathers) by `<collection>/<key>`. */
export type ViewLabel = { id: string; name: string; values: string[]; colours?: Record<string, string>; marks: Record<string, string>; units?: Record<string, string> }
export type Problem = { ref: string; why: string }
export type ViewData = {
  collections: Record<string, Row[]>
  labels?: ViewLabel[]
  problems?: Problem[]
  unplaced?: Problem[]
  hidden?: { path: string; why: string }[]
  files?: number
}

// ---------------------------------------------------------------------------------------- spec

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isScalar = (v: unknown): v is Scalar => v === null || ['string', 'number', 'boolean'].includes(typeof v)

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const BODY_KINDS = ['table', 'list', 'lanes', 'graph', 'bars', 'transcript', 'histogram'] as const
const OVERVIEW_KINDS = ['histogram', 'lanes', 'bars', 'graph'] as const
const SHOW_KINDS = ['table', 'list', 'transcript'] as const

/**
 * The spec's problems, each naming the place in the spec and what is wrong, all at once; none when the panel can draw
 * it. Every field a component names must be declared in its collection, with a type that suits the component.
 */
export function validateSpec(raw: unknown, opts: { builtin?: boolean } = {}): string[] {
  const out: string[] = []
  const bad = (at: string, why: string) => out.push(`${at}: ${why}`)
  if (!isObj(raw)) return ['the spec is not a JSON object']
  const s = raw
  if (s.version !== 1) bad('version', 'must be 1')
  if (!isStr(s.name)) bad('name', 'missing')
  if (!isStr(s.slug) || !SLUG_RE.test(s.slug)) bad('slug', 'lower case letters, digits and dashes')
  if (!isStr(s.description)) bad('description', 'missing')
  if (!Array.isArray(s.scope) || !s.scope.length || !s.scope.every(isStr)) bad('scope', 'a list of globs relative to the folder')
  const cols = new Map<string, Map<string, ViewField>>()
  if (!Array.isArray(s.collections) || !s.collections.length) bad('collections', 'at least one collection')
  else {
    s.collections.forEach((c, i) => {
      const at = `collections[${i}]`
      if (!isObj(c)) return bad(at, 'not an object')
      if (!isStr(c.name)) return bad(`${at}.name`, 'missing')
      if (cols.has(c.name)) bad(`${at}.name`, `${c.name} is named twice`)
      if (!isStr(c.one)) bad(`${at}.one`, 'say what one row is')
      const fields = new Map<string, ViewField>()
      if (!Array.isArray(c.fields) || !c.fields.length) bad(`${at}.fields`, 'declare every field the view shows')
      else {
        c.fields.forEach((f, j) => {
          const fa = `${at}.fields[${j}]`
          if (!isObj(f) || !isStr(f.name)) return bad(fa, 'a field needs a name')
          if (fields.has(f.name)) bad(fa, `${f.name} is declared twice`)
          if (!(FIELD_TYPES as readonly string[]).includes(f.type as string)) bad(`${fa}.type`, `one of ${FIELD_TYPES.join(', ')}`)
          if (f.derived !== undefined) {
            if (f.derived !== 'cleaned' && f.derived !== 'computed') bad(`${fa}.derived`, 'cleaned or computed')
            if (!isStr(f.from) || !isStr(f.how)) bad(fa, 'a derived field says where it comes from (from) and how (how)')
            for (const k of ['from', 'how'] as const) if (typeof f[k] === 'string' && (f[k] as string).includes(';')) bad(`${fa}.${k}`, 'a short phrase without semicolons')
          }
          if (f.flag !== undefined && (!Array.isArray(f.flag) || !f.flag.length || !f.flag.every(isStr))) bad(`${fa}.flag`, 'a list of the values that are problems')
          fields.set(f.name, f as unknown as ViewField)
        })
      }
      if (!isStr(c.key) || !fields.has(c.key)) bad(`${at}.key`, 'must name a declared field that is unique per row')
      if (!isStr(c.title) || !fields.has(c.title)) bad(`${at}.title`, 'must name a declared field, a readable name for a row')
      if (c.ref !== undefined && (!isStr(c.ref) || !fields.has(c.ref))) bad(`${at}.ref`, 'must name a declared field')
      if (c.opens !== undefined && (!isStr(c.opens) || !fields.has(c.opens))) bad(`${at}.opens`, 'must name a declared field holding a path')
      cols.set(c.name, fields)
    })
  }
  const fieldOf = (col: string, name: unknown) => (typeof name === 'string' ? cols.get(col)?.get(name) : undefined)
  // a field of the collection, of one of the given types
  const need = (at: string, col: string, name: unknown, types?: readonly FieldType[]) => {
    const f = fieldOf(col, name)
    if (!f) return bad(at, `${String(name)} is not a declared field of ${col}`)
    if (types && !types.includes(f.type)) bad(at, `${f.name} is ${f.type}; this needs ${types.join(' or ')}`)
  }
  const where = (at: string, col: string, w: unknown) => {
    if (w === undefined) return
    if (!isObj(w)) return bad(at, 'not an object')
    need(`${at}.field`, col, w.field)
    for (const k of ['is', 'not'] as const) {
      const v = w[k]
      if (v !== undefined && !isScalar(v) && !(Array.isArray(v) && v.every(isScalar))) bad(`${at}.${k}`, 'a value or a list of values')
    }
  }
  const sort = (at: string, col: string, v: unknown) => {
    if (v === undefined) return
    if (!isObj(v)) return bad(at, 'not an object')
    need(`${at}.field`, col, v.field)
  }
  const fieldList = (at: string, col: string, v: unknown) => {
    if (v === undefined) return
    if (!Array.isArray(v)) return bad(at, 'a list of field names')
    v.forEach((n, k) => need(`${at}[${k}]`, col, n))
  }
  const body = (at: string, col: string, b: unknown, kinds: readonly string[]) => {
    if (!isObj(b) || !kinds.includes(b.kind as string)) return bad(`${at}.kind`, `one of ${kinds.join(', ')}`)
    switch (b.kind) {
      case 'table':
        if (!Array.isArray(b.columns) || !b.columns.length) bad(`${at}.columns`, 'at least one column')
        else
          b.columns.forEach((c, k) => {
            if (!isObj(c)) return bad(`${at}.columns[${k}]`, 'not an object')
            need(`${at}.columns[${k}].field`, col, c.field)
            if (c.show === 'bar') need(`${at}.columns[${k}].field`, col, c.field, ['number', 'duration'])
            if (c.show === 'chips') need(`${at}.columns[${k}].field`, col, c.field, ['list', 'category'])
            if (c.show !== undefined && !['text', 'bar', 'chips'].includes(c.show as string)) bad(`${at}.columns[${k}].show`, 'text, bar or chips')
            if (c.width !== undefined && (typeof c.width !== 'number' || c.width < 3)) bad(`${at}.columns[${k}].width`, 'a number of columns, 3 or more')
          })
        sort(`${at}.sort`, col, b.sort)
        if (b.group !== undefined) need(`${at}.group`, col, b.group, ['category', 'text'])
        if (b.color !== undefined) need(`${at}.color`, col, b.color, ['category', 'text'])
        return
      case 'list':
        fieldList(`${at}.meta`, col, b.meta)
        if (b.text !== undefined) need(`${at}.text`, col, b.text)
        if (b.tags !== undefined) {
          if (!Array.isArray(b.tags)) bad(`${at}.tags`, 'a list of field names')
          else b.tags.forEach((n, k) => need(`${at}.tags[${k}]`, col, n, ['category', 'list']))
        }
        sort(`${at}.sort`, col, b.sort)
        if (b.group !== undefined) need(`${at}.group`, col, b.group, ['category', 'text'])
        return
      case 'lanes': {
        need(`${at}.time`, col, b.time, ['time', 'number', 'duration'])
        if (b.end !== undefined) need(`${at}.end`, col, b.end, ['time', 'number', 'duration'])
        if (b.color !== undefined) need(`${at}.color`, col, b.color, ['category', 'text'])
        if (b.lanes === undefined) return need(`${at}.lane`, col, b.lane, ['category', 'text'])
        need(`${at}.lane`, col, b.lane)
        const l = b.lanes
        if (!isObj(l) || !isStr(l.collection) || !cols.has(l.collection)) return bad(`${at}.lanes.collection`, 'must name a collection')
        const lc = l.collection
        const f = fieldOf(col, b.lane)
        if (f && !links(f).includes(lc)) bad(`${at}.lane`, `${f.name} must link to ${lc} (its field's link)`)
        if (l.label !== undefined) need(`${at}.lanes.label`, lc, l.label)
        if (l.start !== undefined) need(`${at}.lanes.start`, lc, l.start, ['time', 'number', 'duration'])
        if (l.end !== undefined) need(`${at}.lanes.end`, lc, l.end, ['time', 'number', 'duration'])
        if (l.parent !== undefined) {
          need(`${at}.lanes.parent`, lc, l.parent)
          const p = fieldOf(lc, l.parent)
          if (p && !links(p).includes(lc)) bad(`${at}.lanes.parent`, `${p.name} must link to ${lc}`)
        }
        if (l.group !== undefined) need(`${at}.lanes.group`, lc, l.group, ['category', 'text'])
        fieldList(`${at}.lanes.meta`, lc, l.meta)
        return
      }
      case 'graph': {
        need(`${at}.edge`, col, b.edge)
        const f = fieldOf(col, b.edge)
        if (f && !links(f).includes(col)) bad(`${at}.edge`, `${f.name} must link to ${col}, the rows the graph draws`)
        if (b.label !== undefined) need(`${at}.label`, col, b.label)
        fieldList(`${at}.meta`, col, b.meta)
        return
      }
      case 'bars':
        need(`${at}.field`, col, b.field, ['category', 'text', 'list'])
        if (b.value !== undefined) need(`${at}.value`, col, b.value, ['number', 'duration'])
        if (b.agg !== undefined && !['count', 'sum', 'mean'].includes(b.agg as string)) bad(`${at}.agg`, 'count, sum or mean')
        if ((b.agg === 'sum' || b.agg === 'mean') && b.value === undefined) bad(`${at}.value`, `${b.agg as string} needs a value field`)
        if (b.color !== undefined) need(`${at}.color`, col, b.color, ['category', 'text'])
        if (b.color !== undefined && b.agg === 'mean') bad(`${at}.color`, 'a mean does not stack: use count or sum')
        return
      case 'transcript':
        need(`${at}.speaker`, col, b.speaker)
        need(`${at}.text`, col, b.text)
        if (b.time !== undefined) need(`${at}.time`, col, b.time, ['time', 'number', 'duration'])
        sort(`${at}.sort`, col, b.sort)
        return
      case 'histogram':
        need(`${at}.time`, col, b.time, ['time', 'number', 'duration'])
        if (b.color !== undefined) need(`${at}.color`, col, b.color, ['category', 'text'])
        return
    }
  }
  // links name collections; details name their collection's fields
  if (Array.isArray(s.collections)) {
    s.collections.forEach((c, i) => {
      if (!isObj(c) || !isStr(c.name) || !Array.isArray(c.fields)) return
      c.fields.forEach((f, j) => {
        if (!isObj(f) || f.link === undefined) return
        const ls = links(f)
        if (!ls.length || ls.length !== (Array.isArray(f.link) ? f.link.length : 1)) return bad(`collections[${i}].fields[${j}].link`, 'a collection name or a list of them')
        for (const l of ls) if (!cols.has(l)) bad(`collections[${i}].fields[${j}].link`, `${l} is not a collection`)
      })
      const d = c.detail
      if (d === undefined) return
      const at = `collections[${i}].detail`
      if (!isObj(d)) return bad(at, 'not an object')
      fieldList(`${at}.meta`, c.name, d.meta)
      fieldList(`${at}.fields`, c.name, d.fields)
      if (d.text !== undefined) need(`${at}.text`, c.name, d.text)
      if (d.lines !== undefined) need(`${at}.lines`, c.name, d.lines, ['list'])
      if (d.related !== undefined) {
        if (!Array.isArray(d.related)) return bad(`${at}.related`, 'a list')
        d.related.forEach((r, k) => {
          const ra = `${at}.related[${k}]`
          if (!isObj(r)) return bad(ra, 'not an object')
          if (!isStr(r.title)) bad(`${ra}.title`, 'missing')
          if (!isStr(r.collection) || !cols.has(r.collection)) return bad(`${ra}.collection`, 'must name a collection')
          need(`${ra}.via`, r.collection, r.via)
          const v = fieldOf(r.collection, r.via)
          if (v && !links(v).includes(c.name as string)) bad(`${ra}.via`, `${v.name} must link to ${c.name as string}`)
          where(`${ra}.where`, r.collection, r.where)
          body(`${ra}.show`, r.collection, r.show, SHOW_KINDS)
        })
      }
    })
  }
  if (s.stats !== undefined) {
    if (!Array.isArray(s.stats)) bad('stats', 'a list')
    else
      s.stats.forEach((st, i) => {
        const at = `stats[${i}]`
        if (!isObj(st)) return bad(at, 'not an object')
        if (!isStr(st.label)) bad(`${at}.label`, 'missing')
        if (!isStr(st.collection) || !cols.has(st.collection)) return bad(`${at}.collection`, 'must name a collection')
        if (!(AGGS as readonly string[]).includes(st.agg as string)) return bad(`${at}.agg`, `one of ${AGGS.join(', ')}`)
        if (st.agg !== 'count') {
          const types: FieldType[] | undefined = st.agg === 'distinct' ? undefined : st.agg === 'span' ? ['time', 'number', 'duration'] : ['number', 'duration']
          need(`${at}.field`, st.collection, st.field, types)
        }
        where(`${at}.where`, st.collection, st.where)
      })
  }
  if (!Array.isArray(s.tabs) || !s.tabs.length) bad('tabs', 'at least one tab')
  else
    s.tabs.forEach((t, i) => {
      const at = `tabs[${i}]`
      if (!isObj(t)) return bad(at, 'not an object')
      if (!isStr(t.name)) bad(`${at}.name`, 'missing')
      if (!isStr(t.collection) || !cols.has(t.collection)) return bad(`${at}.collection`, 'must name a collection')
      const col = t.collection
      where(`${at}.where`, col, t.where)
      // thimble's proposal fields, each required: overview, zoom, filter, and the details of the collection's detail
      // (the mod's own views may leave it out: the file browser's raw lines have nothing to overview)
      if (t.overview !== undefined) body(`${at}.overview`, col, t.overview, OVERVIEW_KINDS)
      else if (!opts.builtin) bad(`${at}.overview`, `required: a compact visual of every row of the tab, one of ${OVERVIEW_KINDS.join(', ')}`)
      if (!isStr(t.zoom) || t.zoom.length > 90) bad(`${at}.zoom`, 'required: a short phrase (90 characters at most) saying what a click on the overview narrows the rows to')
      for (const old of ['facets', 'search'] as const) if (t[old] !== undefined) bad(`${at}.${old}`, `moved: the tab's filter is {"fields": [...], "search": [...]}`)
      if (!isObj(t.filter) || !Array.isArray(t.filter.fields)) bad(`${at}.filter`, 'required: {"fields": [the category, list or text fields the filter row offers], "search"?: [fields]}')
      else {
        t.filter.fields.forEach((f, k) => need(`${at}.filter.fields[${k}]`, col, f, ['category', 'list', 'text']))
        fieldList(`${at}.filter.search`, col, t.filter.search)
      }
      const c = (s.collections as unknown[]).find(x => isObj(x) && x.name === col) as Record<string, unknown> | undefined
      if (c && c.detail === undefined) bad(`${at}.collection`, `${col} needs a detail: what its selected row shows (the details on demand)`)
      if (t.body !== undefined && !Array.isArray(t.body)) bad(`${at}.body`, 'a list of components')
      else if (!Array.isArray(t.body) || !t.body.length) bad(`${at}.body`, 'at least one component: the records')
      else t.body.forEach((b, k) => body(`${at}.body[${k}]`, col, b, BODY_KINDS))
    })
  for (const k of ['up', 'source'] as const) if (s[k] !== undefined && !isStr(s[k])) bad(k, 'a string')
  const win = s.window as Record<string, unknown> | undefined
  if (win !== undefined && (!isObj(win) || !(['from', 'to', 'total'] as const).every(k => typeof win[k] === 'number') || !isStr(win.unit))) bad('window', '{from, to, total, unit}')
  for (const k of ['accepts', 'units'] as const) {
    const v = s[k]
    if (v !== undefined && (!Array.isArray(v) || !v.every(x => isObj(x) && isStr(x.form) && isStr(x.means)))) bad(k, 'a list of {form, means}')
  }
  return out
}

// ---------------------------------------------------------------------------------------- rows

const HEX_ID = /^(?=[^g-z]*\d)[0-9a-f]{7,}$|^[0-9a-f]{8}-[0-9a-f]{4}-/i
const TIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/

/** Whether a value reads as a hex id (a hash, a uuid), which no row's title should show. */
export function hexId(v: unknown): boolean {
  return typeof v === 'string' && HEX_ID.test(v.trim())
}

export type DataCheck = { problems: string[]; notes: string[] }

/**
 * The rows' problems against a valid spec (each collection present, keys unique, values of the declared types, refs
 * in citation form) and notes (references to rows that do not exist, titles that read as hex ids, collections with
 * no rows). Problems fail the view; notes are shown to the builder.
 */
export function validateData(spec: ViewSpec, raw: unknown): DataCheck {
  const problems: string[] = []
  const notes: string[] = []
  if (!isObj(raw) || !isObj(raw.collections)) return { problems: ['rows.json has no "collections" object'], notes }
  const data = raw as unknown as ViewData
  const keys = new Map<string, Set<string>>()
  for (const c of spec.collections) {
    const rows = data.collections[c.name]
    if (!Array.isArray(rows)) {
      problems.push(`collection ${c.name}: no rows (rows.json collections.${c.name} is missing)`)
      continue
    }
    if (!rows.length) notes.push(`collection ${c.name} has no rows`)
    const seen = new Set<string>()
    const dup: string[] = []
    let noKey = 0
    const wrong = new Map<string, { n: number; eg: string }>()
    const refField = c.ref ?? 'ref'
    let noRef = 0
    let hex = 0
    rows.forEach(r => {
      if (!isObj(r)) {
        noKey++
        return
      }
      const k = r[c.key]
      if (k === undefined || k === null || k === '') noKey++
      else if (seen.has(String(k))) dup.push(String(k))
      else seen.add(String(k))
      if (typeof r[refField] !== 'string' || !/#/.test(String(r[refField]))) noRef++
      if (hexId(r[c.title])) hex++
      for (const f of c.fields) {
        const v = r[f.name]
        if (v === undefined || v === null || v === '') continue
        if (!typeOk(f.type, v)) {
          const w = wrong.get(f.name) ?? { n: 0, eg: JSON.stringify(v).slice(0, 40) }
          w.n++
          wrong.set(f.name, w)
        }
      }
    })
    keys.set(c.name, seen)
    if (noKey) problems.push(`collection ${c.name}: ${noKey} rows without a ${c.key} (its key)`)
    if (dup.length) problems.push(`collection ${c.name}: ${c.key} is not unique (${[...new Set(dup)].slice(0, 3).join(', ')} repeat)`)
    for (const [name, w] of wrong) problems.push(`collection ${c.name}: ${w.n} values of ${name} are not ${c.fields.find(f => f.name === name)!.type} (such as ${w.eg})`)
    if (noRef) notes.push(`collection ${c.name}: ${noRef} of ${rows.length} rows have no ${refField} in citation form (<path>#L<n>), so they open no place`)
    if (hex && hex * 2 >= rows.length) notes.push(`collection ${c.name}: its title ${c.title} reads as a hex id on ${hex} rows; give rows a readable name`)
  }
  // references to rows that are not there
  for (const c of spec.collections) {
    const rows = data.collections[c.name]
    if (!Array.isArray(rows)) continue
    for (const f of c.fields) {
      const ls = links(f).filter(l => keys.has(l))
      if (!ls.length) continue
      const has = (v: string) => ls.some(l => keys.get(l)!.has(v))
      let dangling = 0
      for (const r of rows) {
        if (!isObj(r)) continue
        const vs = Array.isArray(r[f.name]) ? (r[f.name] as Scalar[]) : [r[f.name] as Scalar]
        for (const v of vs) if (v !== null && v !== undefined && v !== '' && !has(String(v))) dangling++
      }
      if (dangling) notes.push(`collection ${c.name}: ${dangling} values of ${f.name} name no row of ${ls.join(' or ')}`)
    }
  }
  if (data.labels !== undefined && (!Array.isArray(data.labels) || !data.labels.every(l => isObj(l) && isStr(l.id) && isStr(l.name) && Array.isArray(l.values) && isObj(l.marks) && (l.units === undefined || isObj(l.units))))) {
    problems.push('labels: each label needs id, name, values and marks (and units, if any, an object)')
  }
  if (data.problems !== undefined && (!Array.isArray(data.problems) || !data.problems.every(p => isObj(p) && typeof p.ref === 'string' && typeof p.why === 'string'))) {
    problems.push('problems: a list of {ref, why}')
  }
  return { problems, notes }
}

function typeOk(t: FieldType, v: Value): boolean {
  switch (t) {
    case 'number':
    case 'duration':
      return typeof v === 'number' && Number.isFinite(v)
    case 'time':
      return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && TIME_RE.test(v.trim()))
    case 'list':
      return Array.isArray(v) && v.every(isScalar)
    case 'category':
    case 'text':
    case 'ref':
      return isScalar(v)
  }
}

/** A time value as epoch milliseconds: an ISO string, or epoch seconds or milliseconds as a number; null otherwise. */
export function timeMs(v: Value | undefined): number | null {
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000
  if (typeof v !== 'string') return null
  // a view of tens of thousands of rows reads the same strings on every drawing
  const hit = parsedTimes.get(v)
  if (hit !== undefined) return hit
  let t: number | null = null
  if (TIME_RE.test(v.trim())) {
    const ms = Date.parse(v.trim().replace(' ', 'T'))
    t = Number.isNaN(ms) ? null : ms
  }
  if (parsedTimes.size >= 200_000) parsedTimes.clear()
  parsedTimes.set(v, t)
  return t
}
const parsedTimes = new Map<string, number | null>()

export function collectionOf(spec: ViewSpec, name: string): ViewCollection | undefined {
  return spec.collections.find(c => c.name === name)
}

export function fieldOf(spec: ViewSpec, col: string, name: string): ViewField | undefined {
  return collectionOf(spec, col)?.fields.find(f => f.name === name)
}
