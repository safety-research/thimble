// A view drawn as styled lines for the panel: the header (name, stats, what the reader read), tabs, search, facet chips,
// label controls, the tab's components (table, list, lanes on a time axis, graph, bars, transcript) and the selected
// row's detail with its related rows. Pure, like draw.ts: the hooks module lays a view out at the panel's size and
// hands the lines and their hit regions to the Client (views.tsx); tools/render_view.mjs prints the same lines as ANSI.
//
// The analyst's state (ViewState: tab, search, facets, sort, selection, labels on) changes only by `reduce`, from the
// acts the hit regions carry and the keys the Client forwards.
import type { ChatViewSel, ChatViewState } from '../types'
import { bar, cardLayout, cut, fold, lineWidth, pad, shortTimes, width } from './draw'
import type { Line, Seg } from './draw'
import { fmt } from './lib'
import { COLORS } from './paint'
import { collectionOf, hexId, links, timeMs } from './viewspec'

// same as paint.ts COLORS (accent, link); the Merge step imports them. chrome.tsx holds the same, but tools/
// render_view.mjs runs this file under Node, which reads no .tsx.
const ACCENT = 'suggestion'
const LINK = 'remember'
/** A zero-width segment that marks the first line of the selected row: the final pass hangs `❯` in the margin before it
 *  and draws its words in the accent (views/SPEC.md, "The visual system", rule 13); `SEL_WHOLE` across the whole row,
 *  its dim parts too, as a table's row is (so the eye follows it across the columns). */
const SEL = '\u0000sel'
const SEL_WHOLE = '\u0000sel-whole'
const selMark = (whole: boolean): Seg => ({ s: '', fg: whole ? SEL_WHOLE : SEL })
import type { Body, Column, Detail, HistogramBody, LanesBody, ListBody, Overview, Row, Scalar, Sort, Stat, TableBody, TranscriptBody, Value, ViewCollection, ViewData, ViewField, ViewLabel, ViewSpec, Where } from './viewspec'

export type ViewSel = ChatViewSel
/** The analyst's state of a view: see ChatViewState in types/index.d.ts. Facets are keyed `<tab>.<field>`, sorts by
 *  tab, folded groups `<tab>.<group value>`; `scroll` is the first entry the tab's scrolling component shows. */
export type ViewState = ChatViewState

/** The records' right margin, where "?" stands on R beside the row under the pointer, a 2-cell gutter from the row
 *  (views/SPEC.md, rule 3): the records are that much narrower than the type area. */
export const VIEW_MARGIN = 3

export function initialState(): ViewState {
  return { tab: 0, q: '', typing: false, facets: {}, sorts: {}, sel: null, back: [], scroll: 0, dscroll: 0, labelsOn: [], labelFilter: null, open: [], closed: [], panel: '', zoom: {} }
}

export type ViewAct =
  | { op: 'tab'; i: number }
  | { op: 'facet'; field: string; value: string }
  | { op: 'more'; field: string }
  | { op: 'whole'; key: string }
  | { op: 'field'; field: string }
  | { op: 'unsearch' }
  | { op: 'sort'; field: string }
  | { op: 'select'; c: string; k: string }
  | { op: 'follow'; c: string; k: string }
  | { op: 'back' }
  | { op: 'cite'; ref: string; text: string }
  | { op: 'ask'; c: string; k: string }
  | { op: 'label'; id: string }
  | { op: 'labelValue'; id: string; value: string }
  | { op: 'search' }
  | { op: 'clear' }
  | { op: 'group'; g: string; open?: boolean }
  | { op: 'panel'; p: '' | 'problems' | 'derived' | 'about' }
  | { op: 'scroll'; d: number }
  | { op: 'dscroll'; d: number }
  | { op: 'zoom'; t: number | null; span?: [number, number] }
  | { op: 'key'; key: string; ctrl?: boolean; shift?: boolean }
  | { op: 'up' }
  | { op: 'page'; d: 1 | -1 }

/** A region of the drawing that acts on a click: cells [x0, x1) of line y. `cite` is the record it stands for, which
 *  a right-click's menu and a side thread act on. `row`: a whole row, which the Client lights under the pointer. */
export type Hit = { y: number; x0: number; x1: number; act: ViewAct; cite?: { ref: string; text: string; label: string }; row?: boolean }

/** What the Client posts for a click on a hit region: its index in the layout `s` (packHits' stamp) names, as a click
 *  (`ask`: on the "?" beside its row, `menu`: a right-click). The hooks module keeps the hits and maps it to their act. */
export type HitAct = { op: 'hit'; i: number; s: string; ask?: true; menu?: true }

// a hit's flags in packHits: a whole row (lit under the pointer), a row "?" can ask about, a record a right-click acts on
export const HIT_ROW = 1
export const HIT_ASK = 2
export const HIT_MENU = 4

/** The hits as the Client needs them, four numbers each (y, x0, x1, flags), and a stamp naming this set: a view with
 *  many lane marks has hundreds, whose acts and records would pass the Client's props limit. */
export function packHits(hits: readonly Hit[]): { hits: number[]; stamp: string } {
  const out: number[] = []
  for (const h of hits) out.push(h.y, h.x0, h.x1, (h.row ? HIT_ROW : 0) | (hitSel(h) ? HIT_ASK : 0) | (hitRecord(h) ? HIT_MENU : 0))
  // FNV-1a over the hits whole, acts included: the same drawing gets the same stamp
  let x = 0x811c9dc5
  const str = JSON.stringify(hits)
  for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 0x01000193)
  return { hits: out, stamp: (x >>> 0).toString(36) }
}

/** The row a hit selects or follows, which "?" beside it asks about. */
export function hitSel(h: Hit): ViewSel | null {
  return h.act.op === 'select' || h.act.op === 'follow' ? { c: h.act.c, k: h.act.k } : null
}

/** The record a hit stands for: the place a link opens, or the row's cited place a right-click acts on. */
export function hitRecord(h: Hit): { ref: string; text: string; label?: string } | null {
  if (h.act.op === 'cite') return { ref: h.act.ref, text: h.act.text }
  return h.cite ? { ref: h.cite.ref, text: h.cite.text, label: h.cite.label } : null
}

/** What a layout knew that the next act needs: the rows the keys step through, the window shown, and where the body
 *  and the detail stand (for the wheel). */
export type ViewMeta = { order: ViewSel[]; start: number; cap: number; body: [number, number]; detail: [number, number]; dstart: number; dlines: number }
export type ViewLayout = { lines: Line[]; hits: Hit[]; meta: ViewMeta }

// ---------------------------------------------------------------------------------------- rows and filters

// What a drawing derives from the rows is kept with them (by the rows object, so it goes when they do): a view of tens
// of thousands of rows is laid out again on every key, click and scroll, and the hooks worker must answer in time.
type Ix = {
  byKey: Map<string, Map<string, Row>>
  palettes: Map<string, Map<string, string>>
  tags: Map<string, boolean>
  memo: Map<string, unknown>
  search: Map<string, WeakMap<Row, string>>
  tabRows: { key: string; value: TabRows }[]
}
const ixCache = new WeakMap<object, Ix>()

function ix(spec: ViewSpec, data: ViewData): Ix {
  let x = ixCache.get(data)
  if (x) return x
  x = { byKey: new Map(), palettes: new Map(), tags: new Map(), memo: new Map(), search: new Map(), tabRows: [] }
  for (const c of spec.collections) {
    const m = new Map<string, Row>()
    for (const r of data.collections[c.name] ?? []) m.set(String(r[c.key] ?? ''), r)
    x.byKey.set(c.name, m)
  }
  ixCache.set(data, x)
  return x
}

/** A value derived from the rows alone, made once per rows object. */
function memo<T>(spec: ViewSpec, data: ViewData, key: string, make: () => T): T {
  const m = ix(spec, data).memo
  if (m.has(key)) return m.get(key) as T
  const v = make()
  // a detail's related rows are kept per selected row; a long session of clicks should not grow it without end
  if (m.size > 2000) m.clear()
  m.set(key, v)
  return v
}

const byRows = new WeakMap<readonly Row[], Map<string, unknown>>()

/** A value derived from one list of rows (a tab's rows under its filters), made once while that list stands. */
function rowsMemo<T>(rows: readonly Row[], key: string, make: () => T): T {
  let m = byRows.get(rows)
  if (!m) byRows.set(rows, (m = new Map()))
  if (m.has(key)) return m.get(key) as T
  const v = make()
  m.set(key, v)
  return v
}

function rowOf(spec: ViewSpec, data: ViewData, sel: ViewSel | null): Row | undefined {
  return sel ? ix(spec, data).byKey.get(sel.c)?.get(sel.k) : undefined
}

const keyOf = (c: ViewCollection, r: Row) => String(r[c.key] ?? '')
const refOf = (c: ViewCollection, r: Row) => (typeof r[c.ref ?? 'ref'] === 'string' ? String(r[c.ref ?? 'ref']) : '')
const fieldIn = (c: ViewCollection | undefined, name: string | undefined): ViewField | undefined => (name ? c?.fields.find(f => f.name === name) : undefined)
const vals = (v: Value | undefined): Scalar[] => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v])

function inList(v: Value | undefined, want: Value | undefined): boolean {
  const w = vals(want).map(String)
  return vals(v).some(x => w.includes(String(x)))
}

/** Whether a row meets a where; `is: null` keeps the rows without a value, `not: null` those with one. */
function matchWhere(r: Row, w: Where | undefined): boolean {
  if (!w) return true
  const has = vals(r[w.field]).length > 0
  if (w.is === null ? has : w.is !== undefined && !inList(r[w.field], w.is)) return false
  if (w.not === null ? !has : w.not !== undefined && inList(r[w.field], w.not)) return false
  return true
}

/** A row's title: its title field, a linked row's title in its place. */
export function titleOf(spec: ViewSpec, data: ViewData, c: ViewCollection, r: Row): string {
  return show(spec, data, c, fieldIn(c, c.title), r[c.title]) || keyOf(c, r)
}

/** A value as a person reads it: a link as the title of the row it names, a duration in s/m/h, a list joined. */
export function show(spec: ViewSpec, data: ViewData, c: ViewCollection | undefined, f: ViewField | undefined, v: Value | undefined): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.map(x => show(spec, data, c, f, x)).filter(Boolean).join(', ')
  const to = linked(spec, data, f, v)
  if (to && to.c.title !== f?.name) return titleOf(spec, data, to.c, to.r)
  if (f?.type === 'duration' && typeof v === 'number') return dur(v)
  if (f?.type === 'time') return timeText([v])[0] ?? fmt(v)
  if (typeof v === 'number') return fieldNum(v, f)
  return fmt(v)
}

/** The row a link field's value names, in the first of its collections that holds it. */
function linked(spec: ViewSpec, data: ViewData, f: ViewField | undefined, v: Value | undefined): { c: ViewCollection; r: Row } | undefined {
  if (v === undefined || v === null || Array.isArray(v)) return undefined
  for (const name of links(f)) {
    const c = collectionOf(spec, name)
    const r = c ? ix(spec, data).byKey.get(name)?.get(String(v)) : undefined
    if (c && r) return { c, r }
  }
  return undefined
}

/** The least and the greatest of many numbers (a spread into Math.min fails past some tens of thousands). */
function extent(xs: Iterable<number>): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const x of xs) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  return [lo, hi]
}

/** A count or an aggregate, with thousands separators from 1,000, so the numbers on one screen read alike. */
function num(v: number): string {
  return Number.isInteger(v) && Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : fmt(v)
}

// a field whose number names a thing rather than counts it, by its name or label: a key, a line, a year, a sequence
const ID_WORD = /(^|[\s_#-])(id|ids|key|seq|sequence|no|nr|num|number|line|year|index|idx|rank|port|pid|version|issue|pr|position|pos)$/i

/** Whether a number field names rather than counts: its values read without separators (line 13403, seq 1013). */
export function namesNumber(f: ViewField | undefined): boolean {
  return Boolean(f && (ID_WORD.test(f.name) || ID_WORD.test(f.label ?? '') || (f.label ?? '').startsWith('#')))
}

/** A field's own number: a number field's quantity as the header's numbers read (separators from 1,000), one that
 *  names a thing (a line, a year, a sequence number) as written. A number in another field (a category of runs) or
 *  without one (an axis's ends) takes separators from 10,000. */
function fieldNum(v: number, f?: ViewField): string {
  if (f?.type === 'number') return namesNumber(f) ? fmt(v) : num(v)
  return Number.isInteger(v) && Math.abs(v) >= 10000 ? v.toLocaleString('en-US') : fmt(v)
}

/** A duration in its two largest units, rounded to the smaller one first, so it never reads "60 s" or "24 h". */
export function dur(s: number): string {
  const a = Math.abs(s)
  const sign = s < 0 ? '-' : ''
  const two = (n: number) => String(n).padStart(2, '0')
  if (a < 9.95) return `${sign}${fmt(+a.toFixed(1))} s`
  const secs = Math.round(a)
  if (secs < 60) return `${sign}${secs} s`
  if (secs < 3600) return `${sign}${Math.floor(secs / 60)} m ${two(secs % 60)} s`
  const mins = Math.round(a / 60)
  if (mins < 1440) return `${sign}${Math.floor(mins / 60)} h ${two(mins % 60)} m`
  const hours = Math.round(a / 3600)
  return `${sign}${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** Times as the cards show them (shortTimes): one form for the set, epoch numbers read as UTC. */
function timeText(vs: readonly Value[]): string[] {
  const iso = vs.map(v => {
    const t = timeMs(v as Value)
    return t === null ? String(v ?? '') : new Date(t).toISOString().slice(0, 19)
  })
  return shortTimes(iso)
}

/** A row's text as search reads it, lower case, each row's made once. */
function searcher(spec: ViewSpec, data: ViewData, c: ViewCollection, fields: string[] | undefined): (r: Row) => string {
  const names = fields?.length ? fields : c.fields.filter(f => (f.type === 'text' || f.type === 'category' || f.type === 'list' || f.name === c.title) && !links(f).length).map(f => f.name)
  const fs = names.map(n => fieldIn(c, n))
  const x = ix(spec, data)
  const key = `${c.name}\u0000${names.join('\u0000')}`
  let m = x.search.get(key)
  if (!m) x.search.set(key, (m = new WeakMap()))
  const made = m
  return r => {
    let t = made.get(r)
    if (t === undefined) made.set(r, (t = names.map((n, i) => show(spec, data, c, fs[i], r[n])).join(' \u0000 ').toLowerCase()))
    return t
  }
}

function labelOf(data: ViewData, id: string): ViewLabel | undefined {
  return data.labels?.find(l => l.id === id)
}

/** The colour of a label's value: the analyst's, else thimble's label order, the first label's first value blue, the
 *  second's orange, and so on, each further value the next colour. */
export function labelColour(data: ViewData, l: ViewLabel, value: string): string {
  const own = l.colours?.[value]
  if (own) return own
  const i = (data.labels ?? []).indexOf(l)
  const v = Math.max(0, l.values.indexOf(value))
  return COLORS.series[(i + v) % COLORS.series.length]!
}

/** A label's value on a row: a unit's own (any record it gathers marked), else its record's by its ref. */
function labelValue(l: ViewLabel, c: ViewCollection, r: Row): string | undefined {
  return l.units?.[`${c.name}/${keyOf(c, r)}`] ?? l.marks[refOf(c, r)]
}

/** The colour of the first label that is on and marks a row, if any. */
function markOf(data: ViewData, st: ViewState, c: ViewCollection, r: Row): string | undefined {
  for (const id of st.labelsOn) {
    const l = labelOf(data, id)
    const v = l ? labelValue(l, c, r) : undefined
    if (l && v !== undefined && v === l.values[0]) return labelColour(data, l, v)
  }
  return undefined
}

/** Colours for a category field's values: by count, most common first, as many as the palette holds. */
function palette(spec: ViewSpec, data: ViewData, col: string, field: string): Map<string, string> {
  const x = ix(spec, data)
  const key = `${col}.${field}`
  let p = x.palettes.get(key)
  if (p) return p
  const n = new Map<string, number>()
  for (const r of data.collections[col] ?? []) for (const v of vals(r[field])) n.set(String(v), (n.get(String(v)) ?? 0) + 1)
  // the commonest values a colour each; the rest none, as a repeated colour would say two values are one
  p = new Map([...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, COLORS.series.length).map(([v], i) => [v, COLORS.series[i]!]))
  x.palettes.set(key, p)
  return p
}

/** The field a tab colours its rows by: its overview's colour field (a bar's field, lanes' or a strip's colour, lanes'
 *  own field when it is a category), else its lanes'. One field per tab carries colour, so a colour means the same in the
 *  overview, its legend, the filter's chips, the records and the details. */
export function colourField(spec: ViewSpec, tab: number): string {
  const t = spec.tabs[tab]
  if (!t) return ''
  const of = (b: Body | undefined): string => {
    if (!b) return ''
    if (b.kind === 'bars') return b.color ?? b.field
    if (b.kind === 'histogram') return b.color ?? ''
    if (b.kind === 'lanes') return b.color ?? (b.lanes ? '' : b.lane)
    return ''
  }
  // a table may name its own colour field (the file browser's file type), for a tab with no overview to carry one
  const table = t.body.find(b => b.kind === 'table') as TableBody | undefined
  return of(t.overview) || of(t.body.find(b => b.kind === 'lanes')) || table?.color || ''
}

/** The colour of a value's word: red when its field flags it as a problem, else none. A value of the colour field keeps
 *  its word in the text colour; its hue goes on the glyph beside it (views/SPEC.md, "The visual system", rule 20). */
function tint(_spec: ViewSpec, _data: ViewData, _col: string, f: ViewField | undefined, v: Value | undefined, _st: ViewState): string | undefined {
  return flagColour(f, v)
}

/** The colour of the glyph of a value of the tab's colour field: its hue when it is one of the commonest; none for the
 *  rest and for any other field. */
function hueOf(spec: ViewSpec, data: ViewData, col: string, f: ViewField | undefined, v: Value | undefined, st: ViewState): string | undefined {
  if (!f || f.name !== colourField(spec, st.tab)) return undefined
  if (f.type !== 'category' && f.type !== 'text') return undefined
  return palette(spec, data, col, f.name).get(String(v))
}

/** The colour of a value its field flags as a problem: red, whichever flagged value it is (the glyph tells the first,
 *  ×, from the others, !); none for a value not flagged. */
function flagColour(f: ViewField | undefined, v: Value | undefined): string | undefined {
  const i = f?.flag?.length ? Math.min(...vals(v).map(x => f.flag!.indexOf(String(x))).filter(j => j >= 0)) : Infinity
  return Number.isFinite(i) ? COLORS.problem : undefined
}

type Flag = { value: string; colour: string; glyph: string; field: string }

/** The first value of a row that a field of its collection flags as a problem, with its colour and glyph. */
function flagOf(c: ViewCollection, r: Row): Flag | undefined {
  for (const f of c.fields) {
    if (!f.flag?.length) continue
    for (const v of vals(r[f.name])) {
      const i = f.flag.indexOf(String(v))
      if (i >= 0) return { value: String(v), colour: COLORS.problem, glyph: i === 0 ? '×' : '!', field: f.name }
    }
  }
  return undefined
}

/** Whether a row's glyph cells hold a glyph: the tab's colour field is one of the collection's categories (and not the
 *  field its rows are grouped by, whose heading carries the colour), a label is on, or one of its fields flags
 *  problems. The cells are kept either way, so a row's name keeps its axis (A2). */
function glyphColumn(spec: ViewSpec, st: ViewState, c: ViewCollection, group?: string): boolean {
  return Boolean(st.labelsOn.length || glyphField(spec, st, c, group) || c.fields.some(f => f.flag?.length))
}

function glyphField(spec: ViewSpec, st: ViewState, c: ViewCollection, group?: string): ViewField | undefined {
  const f = fieldIn(c, colourField(spec, st.tab))
  return f && (f.type === 'category' || f.type === 'text') && f.name !== group ? f : undefined
}

/** The glyph at a row's left edge: its flag's × or ! in red, else while a label is on ● in its value's hue (dim on a
 *  row it does not mark), else ● in the hue of its value of the tab's colour field (dim past the commonest), so the
 *  rows' state reads down one column. */
function glyphOf(spec: ViewSpec, data: ViewData, st: ViewState, c: ViewCollection, r: Row, group?: string): Seg {
  const fl = flagOf(c, r)
  if (fl) return { s: fl.glyph, fg: fl.colour }
  if (st.labelsOn.length) return { s: '●', fg: markOf(data, st, c, r) ?? COLORS.dim }
  const f = glyphField(spec, st, c, group)
  const v = f ? vals(r[f.name])[0] : undefined
  if (!f || v === undefined) return { s: ' ' }
  // a field of one value draws dim marks (rule 20): one file type in the whole folder says nothing
  const pal = palette(spec, data, c.name, f.name)
  const colour = pal.size > 1 ? pal.get(String(v)) : undefined
  return { s: '●', fg: colour ?? COLORS.dim }
}

/** Values as tags: each in the text colour, a flagged one in its flag's colour, parted by a dim " · ". No background
 *  behind them: the panel's own is the only one behind text but a selection's. */
function chipSegs(f: ViewField | undefined, shown: string[], raw: readonly Scalar[], max = 24): Seg[] {
  const out: Seg[] = []
  shown.forEach((t, i) => {
    if (!t) return
    if (out.length) out.push({ s: TAG_SEP, fg: COLORS.dim })
    out.push({ s: cut(t, max), fg: flagColour(f, raw[i]) })
  })
  return out
}

const TAG_SEP = ' · '

/** Tags in `w` cells, a flagged one first: as many as fit whole, the rest counted (`+2`); the first cut only when none
 *  fits whole. */
function chipsIn(f: ViewField | undefined, shown: string[], raw: readonly Scalar[], w: number): Seg[] {
  const rank = (v: Scalar | undefined) => (f?.flag?.includes(String(v)) ? f.flag.indexOf(String(v)) : 99)
  const vs = shown.map((t, i) => ({ t, v: raw[i] })).filter(x => x.t).sort((a, b) => rank(a.v) - rank(b.v))
  const out: Seg[] = []
  let used = 0
  for (let i = 0; i < vs.length; i++) {
    const sep = i ? width(TAG_SEP) : 0
    const rest = vs.length - i - 1
    const t = vs[i]!.t
    if (used + sep + width(t) + (rest ? width(` +${rest}`) : 0) > w) {
      const left = vs.length - i
      if (!i) {
        const tail = left > 1 ? ` +${left - 1}` : ''
        out.push({ s: cut(t, Math.max(1, w - width(tail))), fg: flagColour(f, vs[0]!.v) })
        if (tail && width(tail) < w) out.push({ s: tail, fg: COLORS.dim })
      } else out.push({ s: ` +${left}`, fg: COLORS.dim })
      break
    }
    if (sep) out.push({ s: TAG_SEP, fg: COLORS.dim })
    out.push({ s: t, fg: flagColour(f, vs[i]!.v) })
    used += sep + width(t)
  }
  return fitLine(out, w)
}

/** Whether a field reads as a tag, drawn as chips: a category or a list, not a link, of at most eight values over the
 *  collection, each on three rows or more on average (an area, a flag); one of more or rarer values (a person, a
 *  reviewer) is drawn as plain text. */
function isTag(spec: ViewSpec, data: ViewData, c: ViewCollection, f: ViewField): boolean {
  if ((f.type !== 'category' && f.type !== 'list') || links(f).length) return false
  const x = ix(spec, data)
  const key = `${c.name}.${f.name}`
  let tag = x.tags.get(key)
  if (tag === undefined) {
    const seen = new Set<string>()
    let n = 0
    for (const r of data.collections[c.name] ?? []) for (const v of vals(r[f.name])) seen.add(String(v)), n++
    x.tags.set(key, (tag = seen.size <= 8 && n >= 3 * seen.size))
  }
  return tag
}

/** Whether every value of a text field reads as a number or numbers (`+9 −1`, `3/4`), so its column is right-aligned. */
function numericText(rows: readonly Row[], name: string): boolean {
  const vs = rows.map(r => r[name]).filter(v => typeof v === 'string' && v !== '')
  return vs.length > 0 && vs.every(v => /^[+−-]?\d[\d.,/%]*( [+−-]?\d[\d.,/%]*)*$/.test(String(v)))
}

export type Facet = { field: string; label: string; values: { value: string; shown: string; n: number; on: boolean }[]; offered: boolean }

/** The tab's rows under its own filter, the search, the facets chosen, the label filter and the zoom (`rows`), and
 *  under all of them but the zoom (`wide`, which the overview draws so the window shows where it sits); the facets'
 *  counts each under every filter but its own. */
export type TabRows = { col: ViewCollection; rows: Row[]; wide: Row[]; all: number; base: Row[]; facets: Facet[]; except: (field: string) => Row[] }

export function tabRows(spec: ViewSpec, data: ViewData, st: ViewState): TabRows {
  // the same filters give the same rows: a scroll, a selection or a fold does not filter them again
  const t = String(st.tab)
  const def = spec.tabs[Math.min(st.tab, spec.tabs.length - 1)]
  const key = JSON.stringify([st.tab, def?.collection, def?.where, def?.filter, def?.overview, def?.body, st.q.trim().toLowerCase(), Object.entries(st.facets).filter(([k]) => k.startsWith(`${t}.`)), st.labelFilter, st.zoom?.[t] ?? null])
  const x = ix(spec, data)
  const hit = x.tabRows.find(e => e.key === key)
  if (hit) return hit.value
  const value = filterRows(spec, data, st)
  x.tabRows = [{ key, value }, ...x.tabRows].slice(0, 6)
  return value
}

function filterRows(spec: ViewSpec, data: ViewData, st: ViewState): TabRows {
  const tab = spec.tabs[Math.min(st.tab, spec.tabs.length - 1)]!
  const col = collectionOf(spec, tab.collection)!
  const base = memo(spec, data, `base:${col.name}:${JSON.stringify(tab.where ?? null)}`, () => (data.collections[col.name] ?? []).filter(r => matchWhere(r, tab.where)))
  const q = st.q.trim().toLowerCase()
  const lf = st.labelFilter ? labelOf(data, st.labelFilter.id) : undefined
  const z = st.zoom?.[String(st.tab)]
  const zf = fieldIn(col, zoomField(spec, st.tab))
  const zoomName = zf?.name
  const inZoom = (r: Row) => {
    if (!z || !zoomName) return true
    const t = laneTime(zf, r[zoomName])
    return t !== null && t >= z[0] && t <= z[1]
  }
  const declared = tab.filter?.fields ?? []
  // a value picked on the overview, a bar or a legend filters too, its field shown as a chip though the row does not offer it
  const picked = Object.entries(st.facets).filter(([k, v]) => k.startsWith(`${st.tab}.`) && v.length).map(([k]) => k.slice(String(st.tab).length + 1))
  const fields = [...declared, ...picked.filter(f => !declared.includes(f) && fieldIn(col, f))]
  const text = searcher(spec, data, col, tab.filter?.search)
  const loose = !q && !lf ? base : base.filter(r => (!q || text(r).includes(q)) && (!lf || labelValue(lf, col, r) === st.labelFilter!.value))
  const pre = z && zoomName ? loose.filter(inZoom) : loose
  const chosen = fields.map(f => [f, st.facets[`${st.tab}.${f}`] ?? []] as const).filter(([, v]) => v.length)
  const passes = (r: Row, skip?: string) => chosen.every(([f, v]) => f === skip || vals(r[f]).some(x => v.includes(String(x))))
  const rows = chosen.length ? pre.filter(r => passes(r)) : pre
  const facets = fields.map(f => {
    const fd = fieldIn(col, f)
    const on = st.facets[`${st.tab}.${f}`] ?? []
    const n = new Map<string, number>()
    for (const r of pre) if (passes(r, f)) for (const v of vals(r[f])) n.set(String(v), (n.get(String(v)) ?? 0) + 1)
    for (const v of on) if (!n.has(v)) n.set(v, 0)
    const values = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, k]) => ({ value, shown: show(spec, data, col, fd, value) || value, n: k, on: on.includes(value) }))
    return { field: f, label: fd?.label ?? f, values, offered: declared.includes(f) }
  })
  const excepted = new Map<string, Row[]>()
  const except = (f: string): Row[] => {
    let rs = excepted.get(f)
    if (!rs) excepted.set(f, (rs = chosen.some(([g]) => g !== f) ? pre.filter(r => passes(r, f)) : pre))
    return rs
  }
  return { col, rows, wide: z ? (chosen.length ? loose.filter(r => passes(r)) : loose) : rows, all: base.length, base, facets, except }
}

/** A lanes time value on the axis: epoch milliseconds for a time field, the number itself otherwise. */
function laneTime(f: ViewField | undefined, v: Value | undefined): number | null {
  if (v === undefined || v === null || v === '') return null
  return f?.type === 'time' ? timeMs(v) : typeof v === 'number' ? v : null
}

function sortRows(spec: ViewSpec, c: ViewCollection, rows: Row[], s: Sort | undefined): Row[] {
  if (!s) return rows
  return rowsMemo(rows, `sort:${c.name}:${s.field}:${s.desc ? 1 : 0}`, () => sorted(c, rows, s))
}

const COLLATE = new Intl.Collator()

function sorted(c: ViewCollection, rows: Row[], s: Sort): Row[] {
  const f = fieldIn(c, s.field)
  const key = (r: Row): number | string => {
    const v = r[s.field]
    if (f?.type === 'time') return timeMs(v) ?? -Infinity
    if (typeof v === 'number') return v
    if (Array.isArray(v)) return v.length
    return v === null || v === undefined ? '' : String(v).toLowerCase()
  }
  const dir = s.desc ? -1 : 1
  // each row's key once, not once per comparison
  const keyed = rows.map((r, i) => ({ r, k: key(r), i }))
  keyed.sort((a, b) => {
    const x = a.k
    const y = b.k
    const d = typeof x === 'number' && typeof y === 'number' ? (x === y ? 0 : x < y ? -1 : 1) : COLLATE.compare(String(x), String(y))
    return d * dir || a.i - b.i
  })
  return keyed.map(e => e.r)
}

// ---------------------------------------------------------------------------------------- line building

type Block = { lines: Line[]; hits: Hit[] }

function builder() {
  const b: Block = { lines: [], hits: [] }
  let cur: Line = []
  let x = 0
  return {
    b,
    get x() {
      return x
    },
    seg(s: Seg, act?: ViewAct, extra?: Partial<Hit>) {
      if (!s.s) return
      if (act) b.hits.push({ y: b.lines.length, x0: x, x1: x + width(s.s), act, ...extra })
      cur.push(s)
      x += width(s.s)
    },
    nl() {
      b.lines.push(cur)
      cur = []
      x = 0
    },
    /** a whole line as one hit */
    line(l: Line, act?: ViewAct, extra?: Partial<Hit>) {
      if (act) b.hits.push({ y: b.lines.length, x0: 0, x1: Math.max(1, lineWidth(l)), act, ...extra })
      b.lines.push(l)
    },
    block(o: Block, maxLines = Infinity) {
      const y0 = b.lines.length
      const n = Math.min(o.lines.length, maxLines)
      b.lines.push(...o.lines.slice(0, n))
      for (const h of o.hits) if (h.y < n) b.hits.push({ ...h, y: h.y + y0 })
    },
    get y() {
      return b.lines.length
    },
  }
}

/** A line cut to `cols` cells, its last segment ending in … where cut. */
export function fitLine(l: Line, cols: number): Line {
  if (lineWidth(l) <= cols) return l
  const out: Line = []
  let w = 0
  for (const s of l) {
    const sw = width(s.s)
    if (w + sw <= cols) {
      out.push(s)
      w += sw
      continue
    }
    const room = cols - w
    if (room > 0) out.push({ ...s, s: cut(s.s, room) })
    break
  }
  return out
}

/** A short name for the place a ref cites: its file's name (left out when it is a hex id) and its line. */
export function placeLabel(ref: string): string {
  const [path = '', frag = ''] = ref.split('#', 2)
  // the file's name as written (`pages.jsonl line 3804`, views/SPEC.md "Words that recur"), left out when its stem
  // is a hex id
  const base = path.split('/').at(-1) ?? path
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '')
  const line = /^L(\d+)(?:-L?(\d+))?$/.exec(frag)
  const where = line ? (line[2] ? `lines ${line[1]}-${line[2]}` : `line ${line[1]}`) : frag
  const name = hexId(stem) || hexId(stem.replace(/^agent-/, '')) ? '' : base
  return [name, where].filter(Boolean).join(' ') || 'source'
}

// ---------------------------------------------------------------------------------------- header

function statValue(spec: ViewSpec, data: ViewData, s: Stat): string {
  return memo(spec, data, `stat:${JSON.stringify(s)}`, () => statOf(spec, data, s))
}

function statOf(spec: ViewSpec, data: ViewData, s: Stat): string {
  const c = collectionOf(spec, s.collection)
  const rows = (data.collections[s.collection] ?? []).filter(r => matchWhere(r, s.where))
  if (s.agg === 'count') return num(rows.length)
  const f = fieldIn(c, s.field)
  const vs = rows.flatMap(r => vals(r[s.field!]))
  if (s.agg === 'distinct') return num(new Set(vs.map(String)).size)
  const ns = vs.map(v => (f?.type === 'time' ? (timeMs(v) ?? NaN) / 1000 : Number(v))).filter(Number.isFinite)
  if (!ns.length) return '–'
  let v: number
  switch (s.agg) {
    case 'sum':
      v = ns.reduce((a, b) => a + b, 0)
      break
    case 'mean':
      v = ns.reduce((a, b) => a + b, 0) / ns.length
      break
    case 'median': {
      const o = [...ns].sort((a, b) => a - b)
      v = o.length % 2 ? o[(o.length - 1) / 2]! : (o[o.length / 2 - 1]! + o[o.length / 2]!) / 2
      break
    }
    case 'min':
      v = extent(ns)[0]
      break
    case 'max':
      v = extent(ns)[1]
      break
    case 'span': {
      const [a, b] = extent(ns)
      return dur(b - a)
    }
    default:
      return '–'
  }
  return f?.type === 'duration' ? dur(v) : num(+v.toPrecision(4))
}

/** The view's header under the panel's path row (views/SPEC.md, "A panel's header"): its name in the accent and bold,
 *  `N files ›` against the right edge (the files read and the fields the reader made, opened under the view); the dim
 *  subtitle of its numbers, "N unreadable lines" in red when there are any, and a file's window ("lines 1-4,000 of
 *  19,931") with `earlier` and `later` against the right edge; the tabs, when there are several, the selected one
 *  inverse; the bordered search box. */
function header(spec: ViewSpec, data: ViewData, st: ViewState, cols: number, tr?: TabRows): Block {
  const lb = builder()
  const probs = data.problems?.length ?? 0
  const files = data.files !== undefined ? `${num(data.files)} file${data.files === 1 ? '' : 's'}` : 'files'
  // the file browser's own views (a file tree, a file) read no files but their own: no `N files ›`, unless the tree
  // left files out
  const builtin = Boolean(spec.up) || spec.collections.some(c => c.opens)
  const right = builtin && !data.hidden?.length ? '' : `${files} ›`
  lb.seg({ s: cut(spec.name, Math.max(8, cols - width(right) - 2)), fg: ACCENT, b: true })
  if (right) {
    lb.seg({ s: ' '.repeat(Math.max(2, cols - lb.x - width(right))) })
    lb.seg({ s: right, ...(st.panel === 'about' ? { bg: COLORS.selected } : {}) }, { op: 'panel', p: st.panel === 'about' ? '' : 'about' })
  }
  lb.nl()
  // the subtitle: the view's numbers, dim; its problems, red; a file's window and its pages against the right edge
  const w = spec.window
  const pages: [string, ViewAct][] = w ? [...(w.from > 1 ? [['earlier', { op: 'page', d: -1 }] as [string, ViewAct]] : []), ...(w.to < w.total ? [['later', { op: 'page', d: 1 }] as [string, ViewAct]] : [])] : []
  const pagesW = pages.reduce((n, [t], i) => n + width(t) + (i ? 2 : 0), 0)
  const facts = [...(spec.stats ?? []).map(x => `${statValue(spec, data, x)} ${x.label}`), ...(w ? [`${w.unit} ${w.from}-${w.to} of ${num(w.total)}`] : [])]
  const probText = probs ? `${num(probs)} unreadable line${probs === 1 ? '' : 's'}` : ''
  const room = cols - pagesW - (pagesW ? 2 : 0) - (probText ? width(probText) + 3 : 0)
  let shown = ''
  for (const t of facts) {
    const next = shown ? `${shown} · ${t}` : t
    if (width(next) > room) break
    shown = next
  }
  if (shown || probText || pages.length) {
    if (shown) lb.seg({ s: shown, fg: COLORS.dim })
    if (probText) {
      if (shown) lb.seg({ s: ' · ', fg: COLORS.dim })
      lb.seg({ s: probText, fg: COLORS.problem, ...(st.panel === 'problems' ? { bg: COLORS.selected } : {}) }, { op: 'panel', p: st.panel === 'problems' ? '' : 'problems' })
    }
    if (pages.length) {
      lb.seg({ s: ' '.repeat(Math.max(2, cols - lb.x - pagesW)) })
      pages.forEach(([t, act], i) => {
        if (i) lb.seg({ s: '  ' })
        lb.seg({ s: t }, act)
      })
    }
    lb.nl()
  }
  // the tabs, each name with a cell of space at each side, the selected one inverse
  if (spec.tabs.length > 1) {
    spec.tabs.forEach((t, i) => {
      if (i) lb.seg({ s: ' ' })
      lb.seg({ s: ` ${t.name} `, ...(i === st.tab ? { inv: true } : {}) }, { op: 'tab', i })
    })
    lb.nl()
  }
  // the search box across the type area: ⌕ and a dim placeholder, the query while typing (its cursor inverse)
  const noun = (tr?.col.name ?? spec.tabs[st.tab]?.collection ?? 'rows').replace(/_/g, ' ')
  const inner = Math.max(4, cols - 4)
  const words: Line = st.q || st.typing ? [{ s: cut(st.q, inner - 3) }, ...(st.typing ? [{ s: ' ', inv: true }] : [])] : [{ s: cut(`Search ${noun}…`, inner - 2), fg: COLORS.dim }]
  const used = 2 + lineWidth(words)
  lb.line([{ s: `╭${'─'.repeat(Math.max(1, cols - 2))}╮`, fg: COLORS.rule }])
  lb.line([{ s: '│ ', fg: COLORS.rule }, { s: '⌕ ', fg: COLORS.dim }, ...words, { s: ' '.repeat(Math.max(0, inner - used)) }, { s: ' │', fg: COLORS.rule }], { op: 'search' })
  lb.line([{ s: `╰${'─'.repeat(Math.max(1, cols - 2))}╯`, fg: COLORS.rule }])
  return lb.b
}

/** The fields of the filter row, the labels last as a field of their own. */
function filterFields(spec: ViewSpec, data: ViewData, tr: ReturnType<typeof tabRows>): { field: string; label: string; n: number }[] {
  const out = tr.facets.filter(f => f.offered && f.values.length).map(f => ({ field: f.field, label: f.label, n: f.values.filter(v => v.on).length }))
  if (spec.labels !== false && data.labels?.length) out.push({ field: LABELS, label: 'labels', n: 0 })
  return out
}

/** The filter row: "search" (the query while typing, its cursor in inverse), "filter" dim and each field parted by a dim
 *  " · ", a click on one opening its values under the row (the open one on the selection background); the rows counted
 *  against the right edge. Under it the open field's values, each with its count dim (a colour field's after its ●), the
 *  ones on on the selection background, then "+N"; then the filters that are on, each "field value" on the selection
 *  background, which a click turns off, and "clear all" against the right edge. */
function filterRow(spec: ViewSpec, data: ViewData, st: ViewState, cols: number, tr: ReturnType<typeof tabRows>): Block {
  const lb = builder()
  // the counts that fit beside the search and a field or two, the first always
  const parts = countWords(spec, data, tr).split(' · ')
  let count = parts[0]!
  for (const p of parts.slice(1)) {
    if (width(`${count} · ${p}`) > cols - 26) break
    count = `${count} · ${p}`
  }
  const filtered = tr.rows.length !== tr.all
  const countW = width(count)
  const fields = filterFields(spec, data, tr)
  const open = openField(st)
  if (fields.length) {
    lb.seg({ s: 'filter  ', fg: COLORS.dim })
    const room = cols - countW - 2
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!
      const isOpen = open === f.field
      const label = `${f.label}${f.n ? ` ${f.n}` : ''}`
      const sep = i ? ' · ' : ''
      const rest = fields.length - i - 1
      const moreW = rest ? width(` · +${rest}`) : 0
      if (lb.x + width(sep) + width(label) + moreW > room) {
        const left = fields.length - i
        if (sep) lb.seg({ s: sep, fg: COLORS.dim })
        lb.seg({ s: `+${left}`, fg: COLORS.dim, ...(open === MORE ? { bg: COLORS.selected } : {}) }, { op: 'field', field: MORE })
        break
      }
      if (sep) lb.seg({ s: sep, fg: COLORS.dim })
      lb.seg({ s: label, ...(isOpen ? { bg: COLORS.selected } : {}) }, { op: 'field', field: f.field })
    }
  }
  lb.seg({ s: ' '.repeat(Math.max(2, cols - lb.x - countW)) })
  lb.seg({ s: count, fg: COLORS.dim })
  lb.nl()
  // the open field's values: up to three lines, all of them once "+N" is pressed
  if (open === MORE) {
    lb.seg({ s: 'fields  ', fg: COLORS.dim })
    fields.forEach(f => {
      if (lb.x + width(f.label) + 2 > cols) return
      lb.seg({ s: f.label }, { op: 'field', field: f.field })
      lb.seg({ s: '  ' })
    })
    lb.nl()
  } else if (open === LABELS) {
    const labels = data.labels ?? []
    const lead = 'labels  '
    lb.seg({ s: lead, fg: COLORS.dim })
    for (const l of labels) {
      const on = st.labelsOn.includes(l.id)
      const pos = l.values[0] ?? ''
      const n = Object.values(l.marks).filter(v => v === pos).length
      const colour = labelColour(data, l, pos)
      const fOn = st.labelFilter?.id === l.id
      const same = pos.toLowerCase() === l.name.toLowerCase() || l.name.toLowerCase().includes(pos.toLowerCase())
      const w = 2 + width(l.name) + 1 + width(same ? num(n) : `${pos} ${num(n)}`) + 2
      if (lb.x + w > cols && lb.x > width(lead)) {
        lb.nl()
        lb.seg({ s: ' '.repeat(width(lead)) })
      }
      // its ● in its first value's hue, its name (on the selection background while on), the count that filters
      lb.seg({ s: '● ', fg: colour }, { op: 'label', id: l.id })
      lb.seg({ s: l.name, ...(on ? { bg: COLORS.selected } : {}) }, { op: 'label', id: l.id })
      lb.seg({ s: ' ' })
      lb.seg({ s: same ? num(n) : `${pos} ${num(n)}`, ...(fOn ? { bg: COLORS.selected } : { fg: COLORS.dim }) }, { op: 'labelValue', id: l.id, value: pos })
      lb.seg({ s: '  ' })
    }
    lb.nl()
  } else if (open) {
    const f = tr.facets.find(x => x.field === open)
    if (f) {
      const whole = st.open.includes(`${st.tab}.${f.field}.all`)
      const lead = `${cut(f.label, 14)}  `
      lb.seg({ s: lead, fg: COLORS.dim })
      let lines = 1
      const maxLines = whole ? 8 : 3
      for (let i = 0; i < f.values.length; i++) {
        const v = f.values[i]!
        const hue = hueOf(spec, data, tr.col.name, fieldIn(tr.col, f.field), v.value, st)
        const name = cut(v.shown, 28)
        const w = (hue ? 2 : 0) + width(name) + 1 + width(num(v.n)) + 2
        const left = f.values.length - i
        if (lb.x + w + (lines === maxLines && left > 1 ? width(`+${left - 1}`) : 0) > cols) {
          if (lines >= maxLines) {
            lb.seg({ s: `+${left}`, fg: COLORS.dim }, { op: 'more', field: f.field })
            break
          }
          lb.nl()
          lb.seg({ s: ' '.repeat(width(lead)) })
          lines++
        }
        const act: ViewAct = { op: 'facet', field: f.field, value: v.value }
        const bg = v.on ? { bg: COLORS.selected } : {}
        if (hue) lb.seg({ s: '● ', fg: hue }, act)
        lb.seg({ s: name, ...(v.n ? {} : { fg: COLORS.dim }), ...bg }, act)
        lb.seg({ s: ' ' })
        lb.seg({ s: num(v.n), fg: COLORS.dim, ...bg }, act)
        lb.seg({ s: '  ' })
      }
      if (whole && f.values.length > 1) lb.seg({ s: 'fewer' }, { op: 'more', field: f.field })
      lb.nl()
    }
  }
  // every filter on, each "field value" on the selection background, which a click turns off
  const chips: [Seg[], ViewAct][] = []
  for (const f of tr.facets) {
    for (const v of f.values.filter(x => x.on)) chips.push([[{ s: `${f.label} ${cut(v.shown, 24)}` }], { op: 'facet', field: f.field, value: v.value }])
  }
  if (st.q && !st.typing) chips.push([[{ s: `search "${cut(st.q, 20)}"` }], { op: 'unsearch' }])
  const z = st.zoom?.[String(st.tab)]
  const zt = zoomField(spec, st.tab)
  if (z) chips.push([[{ s: `zoom ${spanText(fieldIn(tr.col, zt), z)}` }], { op: 'zoom', t: null }])
  for (const id of st.labelsOn) {
    const l = labelOf(data, id)
    if (l) chips.push([[{ s: '● ', fg: labelColour(data, l, l.values[0] ?? '') }, { s: cut(l.name, 24) }], { op: 'label', id }])
  }
  if (st.labelFilter) {
    const l = labelOf(data, st.labelFilter.id)
    if (l) chips.push([[{ s: '● ', fg: labelColour(data, l, st.labelFilter.value) }, { s: `only ${cut(l.name, 24)}` }], { op: 'labelValue', id: l.id, value: st.labelFilter.value }])
  }
  if (chips.length) {
    const clear = chips.length > 1 || filtered ? 'clear all' : ''
    for (const [segs, act] of chips) {
      const w = segs.reduce((n, x) => n + width(x.s), 0) + 2
      if (lb.x + w + width(clear) + 2 > cols && lb.x > 0) break
      for (const x of segs) lb.seg(x.fg ? x : { ...x, bg: COLORS.selected }, act)
      lb.seg({ s: '  ' })
    }
    if (clear) {
      lb.seg({ s: ' '.repeat(Math.max(0, cols - lb.x - width(clear))) })
      lb.seg({ s: clear }, { op: 'clear' })
    }
    lb.nl()
  }
  return lb.b
}

/** What the filter row counts: the tab's rows in the header's words where the header counts them (its `count` stats
 *  of the tab's collection that hold most of its rows), each "N of M" where the filters, or the tab itself, leave out
 *  some of what the header counts; else the rows by their collection's name. */
export function countWords(spec: ViewSpec, data: ViewData, tr: TabRows): string {
  // stats that count rows no stat before them counted (calls, not then the errors among them)
  const stats = rowsMemo(tr.base, 'counted', () => {
    const seen = new Set<Row>()
    return (spec.stats ?? []).filter(s => {
      if (s.agg !== 'count' || s.field || s.collection !== tr.col.name) return false
      const rs = tr.base.filter(r => matchWhere(r, s.where))
      if (rs.some(r => seen.has(r))) return false
      for (const r of rs) seen.add(r)
      return true
    })
  })
  const parts = stats.map(s => {
    const all = memo(spec, data, `count:${JSON.stringify(s)}`, () => (data.collections[s.collection] ?? []).filter(r => matchWhere(r, s.where)).length)
    const inTab = rowsMemo(tr.base, `count:${JSON.stringify(s)}`, () => tr.base.filter(r => matchWhere(r, s.where)).length)
    const shown = rowsMemo(tr.rows, `count:${JSON.stringify(s)}`, () => tr.rows.filter(r => matchWhere(r, s.where)).length)
    return { label: s.label, all, inTab, shown }
  })
  const covered = parts.reduce((n, p) => n + p.inTab, 0)
  if (!parts.length || covered * 2 < tr.base.length) {
    const filtered = tr.rows.length !== tr.all
    return `${num(tr.rows.length)}${filtered ? ` of ${num(tr.all)}` : ''} ${tr.col.name}`
  }
  return parts
    .filter(p => p.inTab > 0)
    .map(p => `${num(p.shown)}${p.shown !== p.all ? ` of ${num(p.all)}` : ''} ${p.label}`)
    .join(' · ')
}

/** The field the filter row has open on this tab, if any. */
function openField(st: ViewState): string {
  const pre = `${st.tab}.`
  const k = st.open.find(o => o.startsWith(pre) && !o.endsWith('.all'))
  return k ? k.slice(pre.length) : ''
}

const LABELS = '\u0000labels'
const MORE = '\u0000more'

/** The time field a tab's zoom narrows: its overview's, else its lanes'. */
function zoomField(spec: ViewSpec, tab: number): string {
  const t = spec.tabs[tab]
  if (!t) return ''
  const o = t.overview
  if (o && (o.kind === 'lanes' || o.kind === 'histogram')) return o.time
  const l = t.body.find(b => b.kind === 'lanes' || b.kind === 'histogram') as LanesBody | HistogramBody | undefined
  return l?.time ?? ''
}

/** A zoom window as text: its ends as times, durations or numbers. */
function spanText(f: ViewField | undefined, z: [number, number]): string {
  if (f?.type === 'time') return timeText(z).join('–')
  if (f?.type === 'duration') return `${dur(z[0])}–${dur(z[1])}`
  return `${fieldNum(+z[0].toPrecision(4))}–${fieldNum(+z[1].toPrecision(4))}`
}

// ---------------------------------------------------------------------------------------- body components

type Ctx = { spec: ViewSpec; data: ViewData; st: ViewState; col: ViewCollection; rows: Row[]; wide?: Row[]; legend?: string; except?: (field: string) => Row[]; indent?: number }
type Windowed = Block & { order: ViewSel[]; start: number; cap: number; total: number; left?: number; dropped?: string[] }

/** The window of `n` entries of heights `h` that fits `cap` lines from `start`, moved to show entry `want`. */
function windowOf(h: readonly number[], cap: number, start: number, want: number): [number, number] {
  const n = h.length
  let a = Math.max(0, Math.min(start, n - 1))
  const fits = (from: number) => {
    let used = 0
    let b = from
    while (b < n && used + h[b]! <= cap) used += h[b++]!
    return b
  }
  if (want >= 0) {
    if (want < a) a = want
    while (a < want && fits(a) <= want) a++
  }
  // no blank left at the bottom while earlier entries fit
  while (a > 0) {
    let used = 0
    for (let i = a - 1; i < n; i++) used += h[i]!
    if (used > cap) break
    a--
  }
  return [a, Math.max(a, fits(a))]
}

type Entry = { group?: string; n?: number; closed?: boolean; row?: Row; colour?: string; more?: number }

/** The rows an open group of the file browser's tree shows before `… N more` (views/SPEC.md, "The file browser"). */
const GROUP_ROWS = 20

/** Whether a group is open: a view's groups are open until folded; the file browser's tree opens its first folder and
 *  folds the rest, until the analyst unfolds one (`<tab>.g.<group>` in `open`). */
function groupOpen(ctx: Ctx, g: string, i: number): boolean {
  const k = `${ctx.st.tab}.${g}`
  if (!ctx.col.opens) return !ctx.st.closed.includes(k)
  return i === 0 ? !ctx.st.closed.includes(k) : ctx.st.open.includes(`${ctx.st.tab}.g.${g}`)
}

function grouped(ctx: Ctx, rows: Row[], group: string | undefined): Entry[] {
  if (!group) return rowsMemo(rows, 'entries', () => rows.map(row => ({ row })))
  const gf = fieldIn(ctx.col, group)
  const by = rowsMemo(rows, `groups:${group}`, () => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const g = show(ctx.spec, ctx.data, ctx.col, gf, r[group]) || '–'
      const rs = m.get(g)
      if (rs) rs.push(r)
      else m.set(g, [r])
    }
    return m
  })
  const out: Entry[] = []
  let i = 0
  for (const [g, rs] of by) {
    const closed = !groupOpen(ctx, g, i++)
    out.push({ group: g, n: rs.length, closed, colour: hueOf(ctx.spec, ctx.data, ctx.col.name, gf, rs[0]![group], ctx.st) })
    if (closed) continue
    // the file browser's open folder: its first files, then `… N more`, until the analyst asks for them all
    const cap = ctx.col.opens && !ctx.st.open.includes(`${ctx.st.tab}.g.${g}.all`) && rs.length > GROUP_ROWS + 1 ? GROUP_ROWS : rs.length
    out.push(...rs.slice(0, cap).map(row => ({ row })))
    if (cap < rs.length) out.push({ group: g, more: rs.length - cap })
  }
  return out
}

function citeOf(ctx: Pick<Ctx, 'spec' | 'data'>, c: ViewCollection, r: Row): Hit['cite'] {
  const ref = refOf(c, r)
  const t = titleOf(ctx.spec, ctx.data, c, r)
  return ref ? { ref, text: t, label: `${t}` } : undefined
}

const isSel = (st: ViewState, c: ViewCollection, r: Row) => st.sel?.c === c.name && st.sel.k === keyOf(c, r)

/** A group's heading at A0 (views/SPEC.md, "Tables"): `▾` open or `▸` folded, a blank line above it (but at the top of
 *  the window), its ● in the group's hue when it is a value of the colour field, its name and its count dim; folded,
 *  only its heading shows. An open folder of the file browser past its first rows ends in `… N more`. */
function groupLine(lb: ReturnType<typeof builder>, e: Entry, first: boolean): void {
  if (e.more) {
    lb.line([{ s: `  … ${num(e.more)} more`, fg: COLORS.dim }], { op: 'whole', key: `__g:${e.group!}` })
    return
  }
  if (!first) lb.line([])
  lb.line([{ s: e.closed ? '▸ ' : '▾ ' }, ...(e.colour ? [{ s: '● ', fg: e.colour }] : []), { s: e.group!, fg: COLORS.dim }, { s: `  ${num(e.n!)}`, fg: COLORS.dim }], { op: 'group', g: e.group!, open: !e.closed })
}

/** The window's entries, headed by the group it starts in: the heading in place of the row that would end the window
 *  (or of its first row, when the last is the one selected). */
function headed(entries: readonly Entry[], a: number, b: number, want: number): Entry[] {
  if (!entries[a]?.row || a === 0 || !entries.some(e => !e.row)) return entries.slice(a, b)
  const from = want === b - 1 ? a + 1 : a
  let g = from
  while (g > 0 && (entries[g]!.row || entries[g]!.more)) g--
  if (entries[g]!.row) return entries.slice(a, b)
  if (g === from) return entries.slice(from, b)
  return [entries[g]!, ...entries.slice(from, from === a ? b - 1 : b)]
}

/** The lines each entry takes: a row its own, a group's heading one more for the blank above it, but the first, a
 *  group's `… N more` one. */
const heights = (entries: readonly Entry[], per = 1) => entries.map((e, i) => (e.row ? per : e.more ? 1 : i ? 2 : 1))

/** Column widths that fit `room` with two cells between columns: each column at least its floor (floors that do not
 *  fit narrow the widest first); then the row's name (`first`) wide enough for nine in ten names whole, as it tells the
 *  rows apart; the room left goes where it shows the most cells whole (`cells`, each column's cell widths), else in
 *  proportion to how much more each column would take. */
export function fitWidths(nat: readonly number[], floor: readonly number[], room: number, cells?: readonly (readonly number[])[], first = -1): number[] {
  const gaps = 2 * Math.max(0, nat.length - 1)
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  if (sum(nat) + gaps <= room) return [...nat]
  const ws = floor.map((f, i) => Math.min(f, nat[i]!))
  while (sum(ws) + gaps > room && extent(ws)[1] > 3) ws[ws.indexOf(extent(ws)[1])]! -= 1
  let left = room - gaps - sum(ws)
  const names = first >= 0 ? cells?.[first] : undefined
  if (names?.length && left > 0) {
    const o = [...names].sort((x, y) => x - y)
    const want = Math.min(nat[first]!, o[Math.ceil(o.length * 0.9) - 1]!)
    const add = Math.max(0, Math.min(left, want - ws[first]!))
    ws[first]! += add
    left -= add
  }
  if (cells) {
    // a step at a time to the width that shows the most more cells whole per cell it takes
    const sortedCells = cells.map(c => [...c].sort((x, y) => x - y))
    for (;;) {
      let best = { i: -1, to: 0, gain: 0 }
      sortedCells.forEach((c, i) => {
        const from = ws[i]!
        let base = 0
        while (base < c.length && c[base]! <= from) base++
        for (let j = base; j < c.length; j++) {
          const w = c[j]!
          if (w > nat[i]! || w - from > left) break
          if (c[j + 1] === w) continue
          const gain = (j + 1 - base) / (w - from)
          if (gain > best.gain) best = { i, to: w, gain }
        }
      })
      if (best.i < 0) break
      left -= best.to - ws[best.i]!
      ws[best.i] = best.to
    }
  }
  const want = nat.map((n, i) => n - ws[i]!)
  const total = sum(want)
  if (left > 0 && total > 0) {
    const add = want.map(w => Math.floor((w * left) / total))
    add.forEach((a, i) => (ws[i]! += a))
    left -= sum(add)
    for (let i = 0; left > 0 && i < ws.length; i++) if (ws[i]! < nat[i]!) (ws[i]!++, left--)
  }
  return ws
}

function median(xs: readonly number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
}

/** The columns a table keeps in `room`: all whose floors fit; else, one at a time, a long text column that is not a
 *  name, then the last column but the first, the row's name and the columns of its state (`state`: its tags), then
 *  those, go, so the columns kept read whole rather than every one cut to a few cells. The detail shows what a row's
 *  dropped columns held. */
export function keptColumns(nat: readonly number[], floor: readonly number[], room: number, title: number, long: readonly boolean[], state: readonly boolean[] = []): number[] {
  let keep = nat.map((_, i) => i)
  const need = () => keep.reduce((n, i) => n + floor[i]!, 0) + 2 * Math.max(0, keep.length - 1)
  while (keep.length > 1 && need() > room) {
    const others = keep.filter(i => i !== title && i !== keep[0])
    const plain = others.filter(i => !state[i])
    const drop = [...others].reverse().find(i => long[i]) ?? plain.at(-1) ?? others.at(-1) ?? keep.at(-1)!
    keep = keep.filter(i => i !== drop)
  }
  return keep
}

/** A table of rows, as many as fit `cap` lines from the window's start, its column names (dim) sorting by a column.
 *  Each row's glyph hangs at A0 (its flag, else its colour or label's hue, else nothing) and its columns start at A2,
 *  rows under a group keeping the columns; the title column regular, numbers right-aligned. Columns that do not fit
 *  the panel are left to the detail. */
function table(ctx: Ctx, body0: TableBody, cols: number, cap: number, act: (c: ViewCollection, r: Row) => ViewAct, sortable: boolean): Windowed {
  const { spec, data, st, col } = ctx
  const sort = (sortable ? st.sorts[String(st.tab)] : undefined) ?? body0.sort
  const rows = sortRows(spec, col, ctx.rows, sort)
  const entries = grouped(ctx, rows, body0.group)
  const glyph = glyphColumn(spec, st, col, body0.group)
  const lead = 2
  const sample = rows.slice(0, 200)
  const want = entries.findIndex(e => e.row && isSel(st, col, e.row))
  const [a, b] = windowOf(heights(entries), Math.max(1, cap - 1), sortable ? st.scroll : 0, want)
  const shown = headed(entries, a, b, want)
  const winRows = shown.filter(e => e.row).map(e => e.row!)
  const BAR = 8
  const measure = (columns: readonly Column[]) => {
    const fields = columns.map(c => fieldIn(col, c.field))
    const numeric = fields.map((f, i) => f?.type === 'number' || f?.type === 'duration' || (f?.type === 'text' && numericText(sample, columns[i]!.field)))
    const texts = (rs: Row[]) =>
      columns.map((c, i) => {
        const f = fields[i]
        if (f?.type === 'time') return timeText(rs.map(r => r[c.field] ?? null))
        // tags as they are drawn, parted by " · ", so the column is as wide as its tags
        if (c.show === 'chips') return rs.map(r => vals(r[c.field]).map(v => show(spec, data, col, f, v)).filter(Boolean).join(TAG_SEP))
        return rs.map(r => show(spec, data, col, f, r[c.field]))
      })
    const cells = texts(winRows)
    const sampleCells = texts(sample)
    const heads = columns.map((c, i) => `${c.label ?? fields[i]?.label ?? c.field}${fields[i]?.unit ? ` (${fields[i]!.unit})` : ''}${sort?.field === c.field ? (sort.desc ? ' ▼' : ' ▲') : ''}`)
    // a time column as wide as the times drawn: the sample's may need seconds the window's do not
    const widths = columns.map((_, i) => (fields[i]?.type === 'time' ? cells[i]! : [...sampleCells[i]!, ...cells[i]!]).map(width))
    const nat = columns.map((c, i) => c.width ?? Math.min(40, Math.max(width(heads[i]!), ...widths[i]!) + (c.show === 'bar' ? BAR + 1 : 0)))
    // numbers, bars and times keep their width: a cut one reads as another value
    const exact = columns.map((c, i) => numeric[i]! || c.show === 'bar' || fields[i]?.type === 'time' || nat[i]! <= 10)
    // a column of names kept is wide enough for most of them to read (three fifths of the typical one), so a narrow
    // panel leaves out a column rather than keep one of a few cells; prose reads from its start at any width
    const typical = widths.map(median)
    const prose = columns.map((_, i) => median([...sampleCells[i]!, ...cells[i]!].map(c => c.trim().split(/\s+/).length)) > 3)
    // a column of tags is wide enough for each row's first tag whole and the count of the rest (`existed before +1`),
    // up to 20 cells, past which a long tag is cut rather than a column left out
    const tagW = columns.map((c, i) => {
      if (c.show !== 'chips') return 0
      let w = 0
      for (const r of [...sample, ...winRows]) {
        const vs = vals(r[c.field]).map(v => show(spec, data, col, fields[i], v)).filter(Boolean)
        if (vs.length) w = Math.max(w, width(vs[0]!) + (vs.length > 1 ? width(` +${vs.length - 1}`) : 0))
      }
      return w
    })
    // the row's own name whole on its typical row, as it tells the rows apart: a column the builder put last goes to
    // the detail first
    const floor = columns.map((c, i) =>
      exact[i] ? nat[i]! : c.show === 'chips' ? Math.min(nat[i]!, Math.max(4, width(heads[i]!), Math.min(20, tagW[i]!))) : prose[i] ? Math.min(nat[i]!, 12) : Math.min(nat[i]!, Math.max(8, Math.ceil(typical[i]! * (c.field === col.title ? 1 : 0.6)))),
    )
    return { fields, numeric, cells, heads, widths, nat, exact, floor }
  }
  let m = measure(body0.columns)
  const titleAt0 = body0.columns.findIndex(c => c.field === col.title)
  // tags are a row's state, kept while any other column can go (a flagged value also shows in the row's glyph)
  const state = body0.columns.map(c => c.show === 'chips')
  const keep = keptColumns(m.nat, m.floor, cols - lead, titleAt0, body0.columns.map((c, i) => !m.exact[i] && !state[i] && m.nat[i]! > 16 && !links(m.fields[i]).length), state)
  const body: TableBody = keep.length === body0.columns.length ? body0 : { ...body0, columns: keep.map(i => body0.columns[i]!) }
  if (body !== body0) m = measure(body.columns)
  const { fields, numeric, cells, heads, widths, nat, floor } = m
  const max = body.columns.map(c => (c.show === 'bar' ? Math.max(0, extent(rows.map(r => Math.abs(Number(r[c.field]) || 0)))[1]) : 0))
  const ws = fitWidths(nat, floor, cols - lead, widths, body.columns.findIndex(c => c.field === col.title))
  // a last column of text takes the room the others leave, up to its longest cell
  const last = body.columns.length - 1
  const spare = cols - lead - ws.reduce((a, b) => a + b, 0) - 2 * last
  if (spare > 0 && !numeric[last] && !body.columns[last]!.show && !body.columns[last]!.width) {
    ws[last] = Math.min(ws[last]! + spare, Math.max(ws[last]!, ...widths[last]!))
  }
  // the row's name, when it is a column of its own and not the long text at the end
  const titleAt = body.columns.findIndex((c, i) => c.field === col.title && (i < last || body.columns.length === 1))
  // a name (the row's own or a linked row's) cut in the middle, as its start and end both tell it apart
  const named = body.columns.map((c, i) => i === titleAt || links(fields[i]).length > 0)
  const lb = builder()
  lb.seg({ s: ' '.repeat(lead) })
  heads.forEach((h, i) => {
    lb.seg({ s: pad(h, ws[i]!, numeric[i]), fg: COLORS.dim }, sortable ? { op: 'sort', field: body.columns[i]!.field } : undefined)
    if (i < heads.length - 1) lb.seg({ s: '  ' })
  })
  lb.nl()
  let k = 0
  shown.forEach((e, n) => {
    if (!e.row) return groupLine(lb, e, n === 0)
    const r = e.row
    const on = isSel(st, col, r)
    // the selected row: `❯` in the margin and the accent across it (the final pass), no background
    const bg: string | undefined = undefined
    const line: Line = [...(on ? [selMark(true)] : []), ...(glyph ? [{ ...glyphOf(spec, data, st, col, r, body.group), bg }, { s: ' ', bg }] : [{ s: '  ', bg }])]
    body.columns.forEach((c, i) => {
      const t = cells[i]![k] ?? ''
      if (c.show === 'bar') {
        const v = Math.abs(Number(r[c.field]) || 0)
        const tw = Math.max(0, ws[i]! - BAR - 1)
        const n8 = max[i]! > 0 ? Math.round((v / max[i]!) * BAR * 8) : 0
        const barS = '█'.repeat(Math.floor(n8 / 8)) + (['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][n8 % 8] ?? '')
        line.push({ s: pad(t, tw, true), bg }, { s: ' ', bg }, { s: pad(barS, BAR), bg })
      } else if (c.show === 'chips') {
        const raw = vals(r[c.field])
        const fit = chipsIn(fields[i], raw.map(v => show(spec, data, col, fields[i], v)), raw, ws[i]!)
        line.push(...fit.map(s => (on ? { ...s, bg } : s)), { s: ' '.repeat(Math.max(0, ws[i]! - lineWidth(fit))), bg })
      } else {
        // the colour field's word stays plain beside its glyph; a flagged value keeps its flag's colour
        const f = fields[i]
        const colour = flagColour(f, r[c.field])
        const s = named[i] && !numeric[i] ? padEnd(cutName(t, ws[i]!), ws[i]!) : pad(t, ws[i]!, numeric[i])
        line.push({ s, bg, ...(colour ? { fg: colour } : {}) })
      }
      if (i < body.columns.length - 1) line.push({ s: '  ', bg })
    })
    k++
    lb.line(line, act(col, r), { cite: citeOf(ctx, col, r), row: true })
  })
  if (!rows.length) lb.line([{ s: '  none', fg: COLORS.dim }])
  const dropped = body0.columns.filter((_, i) => !keep.includes(i)).map(c => c.field)
  return { ...lb.b, order: rowsMemo(rows, `order:${body.group ?? ''}:${st.closed.join(',')}`, () => entries.filter(e => e.row).map(e => ({ c: col.name, k: keyOf(col, e.row!) }))), start: a, cap: Math.max(1, cap - 1), total: entries.length, dropped }
}

type MetaCol = { f: ViewField; kind: 'num' | 'chip' | 'text'; w: number }

/** Rows as a list, an item in two lines: its glyph at A0 and its title at A2, regular, its meta fields in aligned
 *  columns after it (a category or a list as tags, a number right-aligned, anything else dim), and under the title, at
 *  A2 and dim, its `text` with its `tags`. Columns that leave the title too little room are left to the details. */
function list(ctx: Ctx, body: ListBody, cols: number, cap: number, act: (c: ViewCollection, r: Row) => ViewAct, sortable: boolean): Windowed {
  const { spec, data, st, col } = ctx
  const sort = (sortable ? st.sorts[String(st.tab)] : undefined) ?? body.sort
  const rows = sortRows(spec, col, ctx.rows, sort)
  const entries = grouped(ctx, rows, body.group)
  const tags = (body.tags ?? []).map(n => fieldIn(col, n)).filter((f): f is ViewField => Boolean(f))
  const per = body.text || tags.length ? 2 : 1
  const want = entries.findIndex(e => e.row && isSel(st, col, e.row))
  const [a, b] = windowOf(heights(entries, per), cap, sortable ? st.scroll : 0, want)
  const lb = builder()
  const glyph = glyphColumn(spec, st, col, body.group)
  const lead = 2
  const cf = colourField(spec, st.tab)
  const win = headed(entries, a, b, want)
  const sample = [...rows.slice(0, 200), ...win.filter(e => e.row).map(e => e.row!)]
  // the colour field leaves the meta when the glyph or the group heading shows it
  const metaOf = (f: ViewField): MetaCol['kind'] =>
    f.type === 'number' || f.type === 'duration' || (f.type === 'text' && numericText(sample, f.name)) ? 'num' : isTag(spec, data, col, f) ? 'chip' : 'text'
  const cell = (f: ViewField, kind: MetaCol['kind'], r: Row): Seg[] => {
    if (kind === 'chip') {
      const raw = vals(r[f.name])
      return chipSegs(f, raw.map(v => show(spec, data, col, f, v)), raw, 20)
    }
    const t = show(spec, data, col, f, r[f.name])
    return t ? [{ s: t, fg: flagColour(f, r[f.name]) ?? (kind === 'num' ? COLORS.text : COLORS.dim) }] : []
  }
  let metas: MetaCol[] = (body.meta ?? [])
    .map(m => fieldIn(col, m))
    .filter((f): f is ViewField => Boolean(f) && !(f!.name === cf && (glyph || body.group === cf)))
    .map(f => {
      const kind = metaOf(f)
      return { f, kind, w: Math.min(kind === 'text' ? 24 : 30, Math.max(0, ...sample.map(r => lineWidth(cell(f, kind, r))))) }
    })
    .filter(m => m.w > 0)
  const titles = win.filter(e => e.row).map(e => width(titleOf(spec, data, col, e.row!)))
  const natTitle = Math.max(4, ...titles)
  const minTitle = Math.min(natTitle, Math.max(16, Math.floor((cols - lead) * 0.45)))
  const metaW = () => metas.reduce((n, m) => n + m.w + 2, 0)
  while (metas.length && lead + minTitle + metaW() > cols) metas = metas.slice(0, -1)
  const titleW = Math.max(4, Math.min(natTitle, cols - lead - metaW()))
  const sub = lead
  win.forEach((e, n) => {
    if (!e.row) return groupLine(lb, e, n === 0)
    const r = e.row
    const on = isSel(st, col, r)
    const bg: string | undefined = undefined
    const title = titleOf(spec, data, col, r)
    const line: Line = [...(on ? [selMark(false)] : []), ...(glyph ? [{ ...glyphOf(spec, data, st, col, r, body.group), bg }, { s: ' ', bg }] : [{ s: '  ', bg }])]
    line.push({ s: metas.length ? pad(title, titleW) : cut(title, titleW), bg })
    for (const m of metas) {
      const raw = vals(r[m.f.name])
      const segs = m.kind === 'chip' ? chipsIn(m.f, raw.map(v => show(spec, data, col, m.f, v)), raw, m.w) : fitLine(cell(m.f, m.kind, r), m.w)
      const room = ' '.repeat(Math.max(0, m.w - lineWidth(segs)))
      line.push({ s: '  ', bg }, ...(m.kind === 'num' ? [{ s: room, bg }] : []), ...segs.map(s => ({ ...s, bg })), ...(m.kind === 'num' ? [] : [{ s: room, bg }]))
    }
    const used = lineWidth(line)
    if (on && used < cols) line.push({ s: ' '.repeat(cols - used), bg })
    lb.line(fitLine(line, cols), act(col, r), { cite: citeOf(ctx, col, r), row: true })
    if (per === 2) {
      // the text whole where it fits, then each tag that fits whole, the rest counted
      const t = body.text ? show(spec, data, col, fieldIn(col, body.text), r[body.text]).replace(/\s+/g, ' ') : ''
      const second: Line = [{ s: ' '.repeat(sub), bg }]
      // a flagged tag first, the error before the warnings; the text is cut to keep room for it
      const rank = (f: ViewField, v: Scalar) => (f.flag?.includes(String(v)) ? f.flag.indexOf(String(v)) : 99)
      const tagged = tags.flatMap(f => vals(r[f.name]).map(v => ({ f, v }))).sort((x, y) => rank(x.f, x.v) - rank(y.f, y.v))
      const each = tagged.map(({ f, v }) => chipSegs(f, [show(spec, data, col, f, v)], [v], 30))
      // the tags after the text, three cells from it and parted from each other as a cell's tags are
      const gap = (j: number) => (j ? TAG_SEP : lineWidth(second) > sub ? '   ' : '')
      const keep = tagged[0] && rank(tagged[0].f, tagged[0].v) < 99 ? lineWidth(each[0]!) + 3 + (each.length > 1 ? 4 : 0) : 0
      if (t) second.push({ s: cut(t, Math.max(Math.min(width(t), 16), cols - sub - keep)), fg: COLORS.dim, bg })
      let counted = false
      each.forEach((chip, j) => {
        if (counted) return
        const more = each.length - j - 1
        if (lineWidth(second) + width(gap(j)) + lineWidth(chip) + (more ? 4 : 0) > cols) {
          if (lineWidth(second) + 4 <= cols) second.push({ s: `  +${each.length - j}`, fg: COLORS.dim, bg })
          counted = true
          return
        }
        const g = gap(j)
        if (g) second.push({ s: g, fg: COLORS.dim, bg })
        second.push(...chip.map(x => ({ ...x, bg })))
      })
      const w2 = lineWidth(second)
      if (on && w2 < cols) second.push({ s: ' '.repeat(cols - w2), bg })
      lb.line(fitLine(second, cols), act(col, r), { cite: citeOf(ctx, col, r), row: true })
    }
  })
  if (!rows.length) lb.line([{ s: '  none', fg: COLORS.dim }])
  return { ...lb.b, order: entries.filter(e => e.row).map(e => ({ c: col.name, k: keyOf(col, e.row!) })), start: a, cap, total: entries.length }
}

/** Turns (views/SPEC.md, "The file browser", a transcript): per turn, its time dim in a column at A0, then the
 *  speaker's `●` in its hue (a label's while one is on) and the speaker's name bold (a flagged turn's glyph and value
 *  after it, in red); the turn's text under the name, upright, to three rows. */
function transcript(ctx: Ctx, body: TranscriptBody, cols: number, cap: number, act: (c: ViewCollection, r: Row) => ViewAct, sortable: boolean): Windowed {
  const { spec, data, st, col } = ctx
  const rows = sortRows(spec, col, ctx.rows, body.sort ?? (body.time ? { field: body.time } : undefined))
  const sp = palette(spec, data, col.name, body.speaker)
  const tf = fieldIn(col, body.time)
  const times = rowsMemo(rows, `times:${body.time ?? ''}`, () => (body.time ? (tf?.type === 'time' ? timeText(rows.map(r => r[body.time!] ?? null)) : rows.map(r => show(spec, data, col, tf, r[body.time!]))) : []))
  const timeW = Math.min(16, extent([0, ...times.map(width)])[1])
  // the name, and the text under it, after the time's column, a gutter and the speaker's ●
  const lead = (timeW ? timeW + 2 : 0) + 2
  const room = Math.max(10, cols - lead)
  const texts = rowsMemo(rows, `turns:${body.text}:${room}`, () => rows.map(r => wrap(show(spec, data, col, fieldIn(col, body.text), r[body.text]), room, 3)))
  const want = rows.findIndex(r => isSel(st, col, r))
  const [a, b] = windowOf(texts.map(t => 1 + t.length), cap, sortable ? st.scroll : 0, want)
  const lb = builder()
  for (let i = a; i < b; i++) {
    const r = rows[i]!
    const on = isSel(st, col, r)
    const who = show(spec, data, col, fieldIn(col, body.speaker), r[body.speaker]) || '–'
    const hue = st.labelsOn.length ? (markOf(data, st, col, r) ?? COLORS.dim) : (sp.size > 1 ? (sp.get(String(r[body.speaker])) ?? COLORS.dim) : COLORS.dim)
    const fl = flagOf(col, r)
    const time = timeW ? cut(times[i] ?? '', timeW) : ''
    const tail: Line = fl ? [{ s: `  ${fl.glyph} ${fl.value}`, fg: fl.colour }] : []
    const nameW = Math.max(4, cols - lead - lineWidth(tail))
    const head: Line = [...(on ? [selMark(false)] : []), ...(timeW ? [{ s: pad(time, timeW), fg: COLORS.dim }, { s: '  ' }] : []), { s: '● ', fg: hue }, { s: cut(who, nameW), b: true }, ...tail]
    lb.line(fitLine(head, cols), act(col, r), { cite: citeOf(ctx, col, r), row: true })
    for (const t of texts[i]!) lb.line([{ s: ' '.repeat(lead) + t }], act(col, r), { cite: citeOf(ctx, col, r), row: true })
  }
  if (!rows.length) lb.line([{ s: '  none', fg: COLORS.dim }])
  return { ...lb.b, order: rows.map(r => ({ c: col.name, k: keyOf(col, r) })), start: a, cap, total: rows.length }
}

/** `text` in at most `max` lines of `w` cells, broken at spaces, the last cut. */
export function wrap(text: string, w: number, max: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let rest = para.replace(/\s+/g, ' ').trim()
    while (rest && out.length < max) {
      if (width(rest) <= w) {
        out.push(rest)
        rest = ''
        break
      }
      if (out.length === max - 1) {
        out.push(cut(rest, w))
        rest = ''
        break
      }
      const [first] = fold(rest, w)
      const take = first!.endsWith('…') ? first!.slice(0, -1) : first!
      out.push(take)
      rest = rest.slice(take.length).trimStart()
    }
    if (out.length >= max) break
  }
  return out
}

/** Counts (or sums, or means) by a field's values, a bar each, largest first, as the bar card draws them: the value's
 *  name, its bar (in its hue when the field is the tab's colour field, else dim), its number against the
 *  right edge with separators as the header's; or each bar stacked by the values of `color`. A bar filters by its
 *  value; the values on are on the selection background. */
function bars(ctx: Ctx, body: Extract<Body, { kind: 'bars' }>, cols: number, cap: number): Block {
  const { spec, data, st, col } = ctx
  if (body.color) return stacked(ctx, body as Extract<Body, { kind: 'bars' }> & { color: string }, cols, cap)
  const by = new Map<string, number[]>()
  // every value under the other filters, so a bar picked leaves the others to pick
  for (const r of ctx.except ? ctx.except(body.field) : ctx.rows) for (const v of vals(r[body.field])) by.set(String(v), [...(by.get(String(v)) ?? []), body.value ? Number(r[body.value]) || 0 : 1])
  const agg = body.agg ?? (body.value ? 'sum' : 'count')
  const ff = fieldIn(col, body.field)
  const rows = [...by.entries()].map(([key, xs]) => ({ key, label: show(spec, data, col, ff, key) || key, value: agg === 'mean' ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toPrecision(4) : xs.reduce((a, b) => a + b, 0) }))
  rows.sort((a, b) => b.value - a.value)
  const n = rows.length > cap ? Math.max(1, cap - 1) : rows.length
  const shown = rows.slice(0, n)
  const valueW = Math.max(1, ...shown.map(r => width(num(r.value))))
  const labelW = Math.min(Math.max(4, ...shown.map(r => width(r.label))), Math.max(8, Math.floor(cols * 0.4)))
  // a 2-cell gutter after the names and before the numbers (rule 3)
  const barW = Math.max(4, cols - labelW - valueW - 4)
  const max = Math.max(0, ...shown.map(r => Math.abs(r.value)))
  const on = st.facets[`${st.tab}.${body.field}`] ?? []
  const pal = body.field === colourField(spec, st.tab) ? palette(spec, data, col.name, body.field) : undefined
  const lb = builder()
  for (const r of shown) {
    const act: ViewAct = { op: 'facet', field: body.field, value: r.key }
    const sel = on.includes(r.key)
    const b = bar(r.value, max, barW)
    const name = cutName(r.label, labelW)
    lb.seg({ s: name, ...(sel ? { bg: COLORS.selected } : {}) }, act)
    lb.seg({ s: ' '.repeat(Math.max(0, labelW - width(name)) + 2) })
    // a mark no colour names is dim (rule 20)
    lb.seg({ s: b, fg: pal ? (pal.get(r.key) ?? COLORS.dim) : COLORS.dim }, act)
    lb.seg({ s: ' '.repeat(Math.max(2, barW - width(b) + 2)) })
    lb.seg({ s: pad(num(r.value), valueW, true) })
    lb.nl()
  }
  if (rows.length > n) lb.line([{ s: `… ${rows.length - n} more`, fg: COLORS.dim }])
  return lb.b
}

/** A bar per value of the field, each split by the values of `color` in their colours, its total at its end, and the
 *  colours' legend under them. */
function stacked(ctx: Ctx, body: Extract<Body, { kind: 'bars' }> & { color: string }, cols: number, cap: number): Block {
  const { spec, data, st, col } = ctx
  const ff = fieldIn(col, body.field)
  const cf = fieldIn(col, body.color)
  const by = new Map<string, Map<string, number>>()
  const tot = new Map<string, number>()
  for (const r of ctx.except ? ctx.except(body.field) : ctx.rows) {
    const x = body.value ? Number(r[body.value]) || 0 : 1
    const c = String(vals(r[body.color])[0] ?? '')
    for (const v of vals(r[body.field])) {
      const m = by.get(String(v)) ?? new Map<string, number>()
      m.set(c, (m.get(c) ?? 0) + x)
      by.set(String(v), m)
    }
    tot.set(c, (tot.get(c) ?? 0) + x)
  }
  const pal = palette(spec, data, col.name, body.color)
  const order = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  const rows = [...by.entries()].map(([key, m]) => ({ key, label: show(spec, data, col, ff, key) || key, parts: m, value: [...m.values()].reduce((a, b) => a + b, 0) }))
  // a field of a few values keeps its own order (runs r1 to r4); more, the largest first
  if (rows.length > 6) rows.sort((a, b) => b.value - a.value)
  else rows.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
  const legend = order.map(c => ({ glyph: { s: '● ', fg: pal.get(c) ?? COLORS.dim }, text: `${show(spec, data, col, cf, c) || c || '–'} ${num(tot.get(c)!)}`, act: { op: 'facet', field: body.color, value: c } as ViewAct }))
  const legendH = legendHeight(legend, cols, 0)
  const n = Math.max(1, cap - legendH - (rows.length > cap - legendH ? 1 : 0))
  const shown = rows.slice(0, n)
  // with two or three colours, a bar's first part of its whole (7 of 8 merged), else its whole
  const part = order.length <= 3 && order.length > 1
  const valueOf = (r: (typeof rows)[number]) => (part ? `${num(r.parts.get(order[0]!) ?? 0)} of ${num(r.value)}` : num(r.value))
  const valueW = Math.max(1, ...shown.map(r => width(valueOf(r))))
  const labelW = Math.min(Math.max(4, ...shown.map(r => width(r.label))), Math.max(8, Math.floor(cols * 0.4)))
  const barW = Math.max(4, Math.min(50, cols - labelW - valueW - 4))
  const max = Math.max(1, ...shown.map(r => r.value))
  const on = st.facets[`${st.tab}.${body.field}`] ?? []
  const lb = builder()
  for (const r of shown) {
    const act: ViewAct = { op: 'facet', field: body.field, value: r.key }
    const sel = on.includes(r.key)
    const name = cut(r.label, labelW)
    lb.seg({ s: name, ...(sel ? { bg: COLORS.selected } : {}) }, act)
    lb.seg({ s: ' '.repeat(Math.max(0, labelW - width(name)) + 2) })
    // each part ends where its running total falls on the bar, so the parts add up to the whole
    let sum = 0
    let x = 0
    for (const c of order) {
      const v = r.parts.get(c)
      if (!v) continue
      sum += v
      const end = Math.round((sum / max) * barW)
      if (end > x) lb.seg({ s: '█'.repeat(end - x), fg: pal.get(c) ?? COLORS.dim }, act)
      x = Math.max(x, end)
    }
    lb.seg({ s: ' '.repeat(Math.max(2, barW - x + 2)) })
    lb.seg({ s: pad(valueOf(r), valueW, true) })
    lb.nl()
  }
  if (rows.length > n) lb.line([{ s: `… ${rows.length - n} more`, fg: COLORS.dim }])
  legendLines(lb, legend, cols, 0)
  return lb.b
}

/** The rows as a diagram: a box per row, an arrow from the row its edge field names. */
function graph(ctx: Ctx, body: Extract<Body, { kind: 'graph' }>, cols: number, cap: number): Block {
  const { spec, data, st, col } = ctx
  const rows = ctx.rows.slice(0, 40)
  const keys = new Set(rows.map(r => keyOf(col, r)))
  const nodes = rows.map(r => ({ id: keyOf(col, r), label: body.label ? show(spec, data, col, fieldIn(col, body.label), r[body.label]) || titleOf(spec, data, col, r) : titleOf(spec, data, col, r), ...(refOf(col, r) ? { ref: refOf(col, r) } : {}) }))
  const edges = rows.flatMap(r => vals(r[body.edge]).filter(v => keys.has(String(v))).map(v => ({ source: String(v), target: keyOf(col, r) })))
  const lb = builder()
  if (!rows.length) {
    lb.line([{ s: '  none', fg: COLORS.dim }])
    return lb.b
  }
  const parents = new Map<string, string[]>()
  for (const e of edges) parents.set(e.target, [...(parents.get(e.target) ?? []), e.source])
  if (rows.length > 10 && [...parents.values()].every(p => p.length === 1)) return tree(ctx, body, cols, cap)
  const selAt = rows.findIndex(r => isSel(st, col, r))
  const lay = cardLayout({ id: 'view', kind: 'diagram', question: '', x: '', y: '', note: '', source: {}, nodes, edges }, cols, selAt)
  const lines = lay.lines.slice(0, cap - (ctx.rows.length > 40 ? 1 : 0))
  lines.forEach((l, y) => {
    lb.line(l)
    // each run of cells on a node is a hit that selects its row
    const w = lineWidth(l)
    let x0 = -1
    let cur = -1
    for (let x = 0; x <= w; x++) {
      const i = x < w ? lay.hit(x, y) : -1
      const node = i >= 0 && i < nodes.length ? i : -1
      if (node !== cur) {
        if (cur >= 0) lb.b.hits.push({ y, x0, x1: x, act: { op: 'select', c: col.name, k: nodes[cur]!.id }, cite: citeOf(ctx, col, rows[cur]!) })
        cur = node
        x0 = x
      }
    }
  })
  if (ctx.rows.length > 40) lb.line([{ s: `the first 40 of ${num(ctx.rows.length)} rows`, fg: COLORS.dim }])
  return lb.b
}

/** A forest too large for boxes: each row under the row its edge names, with its meta fields after it. */
function tree(ctx: Ctx, body: Extract<Body, { kind: 'graph' }>, cols: number, cap: number): Block {
  const { spec, data, st, col } = ctx
  const keys = new Set(ctx.rows.map(r => keyOf(col, r)))
  const kids = new Map<string, Row[]>()
  const roots: Row[] = []
  for (const r of ctx.rows) {
    const p = vals(r[body.edge]).map(String).find(v => keys.has(v) && v !== keyOf(col, r))
    if (p) kids.set(p, [...(kids.get(p) ?? []), r])
    else roots.push(r)
  }
  const out: { r: Row; prefix: string }[] = []
  const seen = new Set<string>()
  const walk = (r: Row, lead: string, branch: string) => {
    const k = keyOf(col, r)
    if (seen.has(k)) return
    seen.add(k)
    out.push({ r, prefix: lead + branch })
    const ks = kids.get(k) ?? []
    const next = lead + (branch === '├─ ' ? '│  ' : branch ? '   ' : '')
    ks.forEach((c, i) => walk(c, next, i === ks.length - 1 ? '└─ ' : '├─ '))
  }
  for (const r of roots) walk(r, '', '')
  const want = out.findIndex(o => isSel(st, col, o.r))
  const room = Math.max(1, cap - 1 - (out.length > cap - 1 ? 1 : 0))
  const [a, b] = windowOf(out.map(() => 1), room, 0, want)
  const nameOf = (r: Row) => (body.label ? show(spec, data, col, fieldIn(col, body.label), r[body.label]) || titleOf(spec, data, col, r) : titleOf(spec, data, col, r))
  const metas = (body.meta ?? []).map(m => fieldIn(col, m)!).filter(Boolean)
  const cells = out.map(o => metas.map(f => show(spec, data, col, f, o.r[f.name])))
  const metaW = metas.map((f, j) => Math.max(width(f.label ?? f.name), extent(cells.map(c => width(c[j]!)))[1]))
  const numeric = metas.map(f => f.type === 'number' || f.type === 'duration')
  const nameW = Math.max(4, Math.min(cols - metaW.reduce((x, y) => x + y + 2, 0), extent(out.map(o => width(o.prefix) + width(nameOf(o.r))))[1]))
  const lb = builder()
  if (metas.length) lb.line([{ s: ' '.repeat(nameW) }, ...metas.flatMap((f, j): Seg[] => [{ s: '  ' }, { s: pad(f.label ?? f.name, metaW[j]!, numeric[j]), fg: COLORS.dim }])])
  for (const o of out.slice(a, b)) {
    const { r, prefix } = o
    const on = isSel(st, col, r)
    const bg: string | undefined = undefined
    const line: Line = [...(on ? [selMark(true)] : []), { s: prefix, fg: COLORS.rule, bg }, { s: pad(nameOf(r), Math.max(1, nameW - width(prefix))), bg }]
    const row = cells[out.indexOf(o)]!
    metas.forEach((f, j) => line.push({ s: '  ', bg }, { s: pad(row[j]!, metaW[j]!, numeric[j]), fg: tint(spec, data, col.name, f, r[f.name], st), bg }))
    lb.line(fitLine(line, cols), { op: 'select', c: col.name, k: keyOf(col, r) }, { cite: citeOf(ctx, col, r), row: true })
  }
  if (out.length > b - a) lb.line([{ s: `${b - a} of ${out.length}`, fg: COLORS.dim }])
  return lb.b
}

type Lane = { key: string; label: string; depth: number; prefix: string; group?: string; head?: { c?: ViewCollection; r?: Row }; row?: Row; start?: number; end?: number; n?: number; meta: string[] }
type Mark = { r: Row; t: number; lane: string[] }

/** `s` in `n` cells, cut in the middle where it is longer: a name's start and its end both tell it apart. */
export function cutMiddle(s: string, n: number): string {
  if (width(s) <= n) return s
  if (n < 8) return cut(s, n)
  const chars = [...s]
  const tail = Math.floor((n - 1) * 0.45)
  let end = ''
  let w = 0
  for (let i = chars.length - 1; i >= 0 && w + width(chars[i]!) <= tail; i--) {
    end = chars[i]! + end
    w += width(chars[i]!)
  }
  // a name the reader already cut keeps one ellipsis
  return (cut(s, n - w).replace(/…$/, '') + '…' + end).replace(/…+/g, '…')
}

/** A name in `n` cells: cut in the middle when it reads as a name (three words at most: a page, "X on Y", "lead · r2"),
 *  at its end when it reads as a sentence (a pull request's title). */
function cutName(s: string, n: number): string {
  return s.trim().split(/\s+/).length <= 3 ? cutMiddle(s, n) : cut(s, n)
}

/** The lanes of rows of the lanes' collection, each under its parent with tree lines, under a heading per value of
 *  their group, with their meta fields as text; made once per rows object. */
function laneTree(spec: ViewSpec, data: ViewData, body: LanesBody): Lane[] {
  return memo(spec, data, `lanes:${JSON.stringify(body.lanes)}`, () => {
    const L = body.lanes!
    const lc = collectionOf(spec, L.collection)!
    const metaF = (L.meta ?? []).map(n => fieldIn(lc, n)).filter((f): f is ViewField => Boolean(f))
    const lrows = data.collections[lc.name] ?? []
    const keys = new Set(lrows.map(r => keyOf(lc, r)))
    const kids = new Map<string, Row[]>()
    const roots: Row[] = []
    for (const r of lrows) {
      const p = L.parent ? String(r[L.parent] ?? '') : ''
      if (p && keys.has(p) && p !== keyOf(lc, r)) {
        const ks = kids.get(p)
        if (ks) ks.push(r)
        else kids.set(p, [r])
      } else roots.push(r)
    }
    const sf = fieldIn(lc, L.start)
    const ef = fieldIn(lc, L.end)
    const gf = fieldIn(lc, L.group)
    const startOf = (r: Row) => laneTime(sf, r[L.start ?? '']) ?? 0
    const byStart = (a: Row, b: Row) => startOf(a) - startOf(b)
    const ls: Lane[] = []
    const seen = new Set<string>()
    const walk = (r: Row, depth: number, lead: string, branch: string, group: string | undefined) => {
      const k = keyOf(lc, r)
      if (seen.has(k)) return
      seen.add(k)
      ls.push({
        key: k,
        label: L.label ? show(spec, data, lc, fieldIn(lc, L.label), r[L.label]) : titleOf(spec, data, lc, r),
        depth,
        prefix: lead + branch,
        group,
        row: r,
        start: laneTime(sf, r[L.start ?? '']) ?? undefined,
        end: laneTime(ef, r[L.end ?? '']) ?? undefined,
        meta: metaF.map(f => show(spec, data, lc, f, r[f.name])),
      })
      const ks = (kids.get(k) ?? []).sort(byStart)
      const next = lead + (branch === '├ ' ? '│ ' : branch ? '  ' : '')
      ks.forEach((c, i) => walk(c, depth + 1, next, i === ks.length - 1 ? '└ ' : '├ ', group))
    }
    if (gf) {
      // a heading per value of the group, in the order the rows first name it, its roots indented under it
      const groups = new Map<string, Row[]>()
      for (const r of roots) {
        const g = String(r[gf.name] ?? '')
        const rs = groups.get(g)
        if (rs) rs.push(r)
        else groups.set(g, [r])
      }
      for (const [g, rs] of groups) {
        const to = linked(spec, data, gf, g)
        const meta = metaF.map(f => {
          const hf = to ? fieldIn(to.c, f.name) : undefined
          return hf && to ? show(spec, data, to.c, hf, to.r[f.name]) : ''
        })
        ls.push({ key: `\u0000${g}`, label: to ? titleOf(spec, data, to.c, to.r) : show(spec, data, lc, gf, g) || '–', depth: 0, prefix: '', group: g, head: { c: to?.c, r: to?.r }, meta })
        for (const r of rs.sort(byStart)) walk(r, 0, '  ', '', g)
      }
    } else for (const r of roots.sort(byStart)) walk(r, 0, '', '', undefined)
    return ls
  })
}

/** A legend's entries on as many lines as they need, up to `max`, from `left` (or the line's start, where the indent
 *  leaves too little room), the entries that do not fit counted at the end. */
function legendLines(lb: ReturnType<typeof builder>, entries: { glyph: Seg; text: string; act?: ViewAct }[], cols: number, left: number, max = 2): void {
  if (!entries.length) return
  // from the indent when every entry fits there, else from the line's start
  const fits = (from: number) => {
    let lines = 1
    let x = from
    for (const e of entries) {
      const w = width(e.glyph.s) + width(e.text) + 2
      if (x > from && x + w > cols) (lines++, (x = from))
      x += w
    }
    return lines <= max
  }
  const lead = cols - left >= 28 && (left === 0 || fits(left) || !fits(0)) ? left : 0
  let lines = 0
  let on = false
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const w = width(e.glyph.s) + width(e.text) + 2
    const rest = entries.length - i - 1
    const moreW = rest ? width(`+${rest}`) + 2 : 0
    if (on && lb.x + w + (lines === max - 1 ? moreW : 0) > cols) {
      if (lines === max - 1) {
        lb.seg({ s: `+${entries.length - i}`, fg: COLORS.dim })
        break
      }
      lb.nl()
      lines++
      on = false
    }
    if (!on) {
      lb.seg({ s: ' '.repeat(lead) })
      on = true
    }
    // the value in the text colour, its count after it by one space, dim
    const sp = e.text.lastIndexOf(' ')
    lb.seg(e.glyph, e.act)
    if (sp > 0) {
      lb.seg({ s: e.text.slice(0, sp + 1) }, e.act)
      lb.seg({ s: e.text.slice(sp + 1), fg: COLORS.dim }, e.act)
    } else lb.seg({ s: e.text }, e.act)
    lb.seg({ s: '  ' })
  }
  lb.nl()
}

/** How many lines legendLines takes for these entries. */
function legendHeight(entries: { glyph: Seg; text: string }[], cols: number, left: number, max = 2): number {
  const lb = builder()
  legendLines(lb, entries, cols, left, max)
  return lb.y
}

/** Marks on one time axis, a lane per value or per row of the lanes' collection (children under their parent, the lanes
 *  under a heading per value of their group, their meta fields in columns beside their names); each mark coloured by
 *  its field, or by the label that marks it while labels are on, a mark its row's flag calls a problem drawn ×. */
function lanes(ctx: Ctx, body: LanesBody, cols: number, cap: number, sortable: boolean): Windowed {
  const { spec, data, st, col } = ctx
  const tf = fieldIn(col, body.time)
  const lc = body.lanes ? collectionOf(spec, body.lanes.collection) : undefined
  const metaF = lc && body.lanes?.meta ? body.lanes.meta.map(n => fieldIn(lc, n)).filter((f): f is ViewField => Boolean(f)) : []
  const bkey = JSON.stringify(body)
  let ls: Lane[]
  if (lc && body.lanes) {
    const all = laneTree(spec, data, body)
    // with a filter on, only lanes holding a mark, the lanes above them and their headings
    ls =
      ctx.rows.length === (data.collections[col.name] ?? []).length
        ? all
        : rowsMemo(ctx.rows, `keep:${bkey}`, () => {
            const used = new Set<string>()
            for (const r of ctx.rows) for (const v of vals(r[body.lane])) used.add(String(v))
            const keep = new Set<string>()
            all.forEach((l, i) => {
              if (l.head || !used.has(l.key)) return
              keep.add(l.key)
              if (l.group !== undefined) keep.add(`\u0000${l.group}`)
              for (let j = i - 1, d = l.depth; j >= 0 && d > 0; j--) if (!all[j]!.head && all[j]!.depth < d) (keep.add(all[j]!.key), (d = all[j]!.depth))
            })
            return all.filter(l => keep.has(l.key))
          })
  } else {
    // every lane under the other filters, so a lane picked leaves the others to pick
    const from = ctx.except ? ctx.except(body.lane) : ctx.rows
    ls = rowsMemo(from, `values:${bkey}`, () => {
      const n = new Map<string, number>()
      for (const r of from) for (const v of vals(r[body.lane])) n.set(String(v), (n.get(String(v)) ?? 0) + 1)
      const lf = fieldIn(col, body.lane)
      return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, c]) => ({ key: k, label: show(spec, data, col, lf, k) || k, depth: 0, prefix: '', n: c, meta: [num(c)] }))
    })
  }
  const marks = rowsMemo(ctx.rows, `marks:${bkey}`, (): Mark[] => {
    const out: Mark[] = []
    for (const r of ctx.rows) {
      const t = laneTime(tf, r[body.time])
      if (t !== null) out.push({ r, t, lane: vals(r[body.lane]).map(String) })
    }
    return out
  })
  const lb = builder()
  const span = rowsMemo(ctx.rows, `span:${bkey}:${ls.length}`, () => extent([...marks.map(m => m.t), ...ls.flatMap(l => [l.start, l.end].filter((v): v is number => v !== undefined))]))
  if (!ls.length || !Number.isFinite(span[0])) {
    lb.line([{ s: '  none', fg: COLORS.dim }])
    return { ...lb.b, order: [], start: 0, cap, total: 0 }
  }
  // the whole span, over every row of the collection, which zooming in stays inside
  const whole = memo(spec, data, `whole:${col.name}:${body.time}`, () => extent((data.collections[col.name] ?? []).map(r => laneTime(tf, r[body.time])).filter((t): t is number => t !== null)))
  const full0 = Math.min(span[0], whole[0])
  const full1 = Math.max(span[1], whole[1])
  const z = st.zoom?.[String(st.tab)]
  // under a strip, the strip's whole span, so a mark stands under its bin
  const t0 = z ? z[0] : ctx.indent ? full0 : span[0]
  const t1 = z ? z[1] : ctx.indent ? full1 : span[1]
  // the lanes' meta fields in columns, a heading's from its row's fields of the same names
  const counted = !lc
  const metaW = rowsMemo(ls as unknown as Row[], `metaW:${bkey}`, () => {
    const ws = counted ? [0] : metaF.map(f => width(f.label ?? f.name))
    for (const l of ls) l.meta.forEach((t, j) => (ws[j] = Math.max(ws[j] ?? 0, width(t))))
    return ws
  })
  const metaNum = counted ? [true] : metaF.map(f => f.type === 'number' || f.type === 'duration')
  const headName = lc && body.lanes?.label ? (fieldIn(lc, body.lanes.label)?.label ?? body.lanes.label) : (lc?.name ?? '')
  // a lane per value of the colour field starts with its glyph in that colour, as a row does
  const laneGlyph = !lc && Boolean(fieldIn(col, body.lane)) && body.lane === colourField(spec, st.tab)
  const gw = laneGlyph ? 2 : 0
  // the names take what they need, up to about a third of the width, leaving the axis at least two fifths of it; where
  // the meta columns leave the axis less than about a third, the last of them are left to the detail
  const natural = rowsMemo(ls as unknown as Row[], `natural:${bkey}`, () => ls.reduce((n, l) => Math.max(n, width(l.prefix) + width(l.label) + gw), metaF.length ? width(headName) : 0) + 1)
  const fit = (shown: number) => {
    const total = metaW.slice(0, shown).reduce((n, w) => n + w + 1, 0)
    const roomL = Math.max(Math.floor(cols * 0.28), Math.min(Math.floor(cols * 0.36), cols - total - 1 - Math.floor(cols * 0.4)))
    const lab = Math.min(Math.max(8, roomL), natural)
    return { total, lab, axis: cols - lab - total - 1 }
  }
  let metaN = metaW.length
  while (!counted && metaN > 0 && fit(metaN).axis < Math.max(16, Math.floor(cols * 0.35))) metaN--
  const { total: metaTotal, lab: labW } = fit(metaN)
  const W = Math.max(10, cols - labW - metaTotal - 1)
  const xOf = (t: number) => (t1 === t0 ? 0 : Math.min(W - 1, Math.max(0, Math.round(((t - t0) / (t1 - t0)) * (W - 1)))))
  const pal = body.color ? palette(spec, data, col.name, body.color) : new Map<string, string>()
  const flags = rowsMemo(ctx.rows, `flags:${bkey}`, () => {
    const out = new Map<string, { n: number; f: Flag }>()
    for (const m of marks) {
      const fl = flagOf(col, m.r)
      if (fl) out.set(fl.value, { n: (out.get(fl.value)?.n ?? 0) + 1, f: fl })
    }
    return out
  })
  const left = labW + metaTotal + 1
  // the colours' legend (marks without a value are drawn dim and left out of it), then the flags'
  const anyOn = st.labelsOn.length > 0
  const legend: { glyph: Seg; text: string; act?: ViewAct }[] = []
  if (body.color && !ctx.legend) {
    const n = rowsMemo(ctx.rows, `legend:${bkey}`, () => {
      const c = new Map<string, number>()
      for (const m of marks) for (const v of vals(m.r[body.color!]).slice(0, 1)) c.set(String(v), (c.get(String(v)) ?? 0) + 1)
      return [...c.entries()].sort((p, q) => q[1] - p[1])
    })
    for (const [v, k] of n) legend.push({ glyph: { s: '● ', fg: anyOn ? COLORS.dim : pal.get(v) }, text: `${v} ${num(k)}`, act: { op: 'facet', field: body.color, value: v } })
  }
  for (const [v, { n: k, f }] of [...flags.entries()].sort((p, q) => q[1].n - p[1].n)) legend.push({ glyph: { s: `${f.glyph} `, fg: f.colour }, text: `${v} ${num(k)}`, act: { op: 'facet', field: f.field, value: v } })
  const legendRows = legendHeight(legend, cols, left)
  const headRows = metaF.length ? 1 : 0
  let want = -1
  if (st.sel) {
    const sel = st.sel
    if (lc && sel.c === lc.name) want = ls.findIndex(l => !l.head && l.key === sel.k)
    else if (sel.c === col.name) {
      const r = rowOf(spec, data, sel)
      const on = new Set(r ? vals(r[body.lane]).map(String) : [])
      if (on.size) want = ls.findIndex(l => !l.head && on.has(l.key))
    }
  }
  // the column heads, the axis, its labels, the legend, and a line counting the lanes when they do not all fit
  const fixed = 2 + legendRows + headRows
  const laneCap = Math.max(1, cap - fixed - (ls.length > cap - fixed ? 1 : 0))
  // a heading takes a blank line above it, but at the top
  const [a, b] = windowOf(ls.map((l, i) => (l.head && i ? 2 : 1)), laneCap, sortable ? st.scroll : 0, want)
  const byLane = rowsMemo(ctx.rows, `bylane:${bkey}`, () => {
    const out = new Map<string, Mark[]>()
    for (const m of marks)
      for (const k of m.lane) {
        const ms = out.get(k)
        if (ms) ms.push(m)
        else out.set(k, [m])
      }
    return out
  })
  if (headRows) {
    lb.seg({ s: pad(cut(headName, labW - 1), labW), fg: COLORS.dim })
    metaF.slice(0, metaN).forEach((f, j) => lb.seg({ s: ' ' + pad(f.label ?? f.name, metaW[j]!, metaNum[j]), fg: COLORS.dim }))
    lb.nl()
  }
  ls.slice(a, b).forEach((l, n) => {
    const meta = l.meta.slice(0, metaN)
    if (l.head) {
      // a group's heading: a blank line above it, its name regular, its totals dim
      if (n) lb.nl()
      const act: ViewAct | undefined = l.head.c && l.head.r ? { op: 'select', c: l.head.c.name, k: keyOf(l.head.c, l.head.r) } : undefined
      const on = Boolean(act && st.sel?.c === l.head.c!.name && st.sel.k === keyOf(l.head.c!, l.head.r!))
      if (on) lb.seg(selMark(false))
      lb.seg({ s: padEnd(cutName(l.label, labW), labW) }, act, act ? { cite: citeOf(ctx, l.head.c!, l.head.r!), row: true } : undefined)
      meta.forEach((t, j) => lb.seg({ s: ' ' + pad(t, metaW[j]!, metaNum[j]), fg: COLORS.dim }))
      lb.nl()
      return
    }
    const laneSel = lc && st.sel?.c === lc.name && st.sel.k === l.key
    const laneAct: ViewAct = lc ? { op: 'select', c: lc.name, k: l.key } : { op: 'facet', field: body.lane, value: l.key }
    const laneOn = !lc && (st.facets[`${st.tab}.${body.lane}`] ?? []).includes(l.key)
    const laneTint = lc ? undefined : hueOf(spec, data, col.name, fieldIn(col, body.lane), l.key, st)
    const hit = lc && l.row ? { cite: citeOf(ctx, lc, l.row), row: true } : undefined
    // a lane of rows selected takes `❯` and the accent; a lane of a value kept by the filter, the selection background
    const bg = laneOn ? COLORS.selected : undefined
    if (laneSel) lb.seg(selMark(false))
    if (l.prefix) lb.seg({ s: l.prefix, fg: COLORS.rule, bg }, laneAct, hit)
    if (laneGlyph) lb.seg({ s: '● ', fg: laneTint ?? COLORS.dim, bg }, laneAct, hit)
    const room = Math.max(1, labW - width(l.prefix) - gw)
    lb.seg({ s: padEnd(cutName(l.label, room), room), bg }, laneAct, hit)
    meta.forEach((t, j) => lb.seg({ s: ' ' + pad(t, metaW[j]!, metaNum[j]), fg: counted || (metaNum[j] && /^0(\.0+)?$/.test(t)) ? COLORS.dim : undefined, bg }, laneAct))
    lb.seg({ s: ' ' })
    // each cell keeps the selected mark, else one a label marks, else a flagged one, else the first; ◆ where more
    // than two meet
    const spanned = new Array<boolean>(W).fill(false)
    if (l.start !== undefined && (l.end ?? l.start) >= t0 && l.start <= t1) for (let x = xOf(Math.max(t0, l.start)); x <= xOf(Math.min(t1, l.end ?? l.start)); x++) spanned[x] = true
    const cells: ({ m: Mark; pri: number; n: number; colour?: string; flag?: Flag } | null)[] = new Array(W).fill(null)
    for (const m of byLane.get(l.key) ?? []) {
      const x = xOf(m.t)
      const mark = markOf(data, st, col, m.r)
      const flag = flagOf(col, m.r)
      const pri = isSel(st, col, m.r) ? 4 : mark ? 3 : flag ? 2 : 1
      const colour = mark ?? (anyOn ? undefined : body.color ? pal.get(String(m.r[body.color])) : COLORS.dim)
      const c = cells[x]
      if (!c || pri > c.pri) cells[x] = { m, pri, n: (c?.n ?? 0) + 1, colour, flag }
      else c.n++
    }
    let x = 0
    while (x < W) {
      const c = cells[x]
      if (c) {
        // a flagged mark keeps its glyph; its colour is the label's that marks it, else the flag's; a mark of no value
        // dim; the selected one on the selection background
        const s = c.flag ? c.flag.glyph : c.n > 2 ? '◆' : '●'
        const fg = c.flag && c.pri !== 3 ? c.flag.colour : (c.colour ?? COLORS.dim)
        lb.seg({ s, fg, ...(c.pri === 4 ? { bg: COLORS.selected } : {}) }, { op: 'select', c: col.name, k: keyOf(col, c.m.r) }, { cite: citeOf(ctx, col, c.m.r) })
        x++
        continue
      }
      const on = spanned[x]
      let run = ''
      while (x < W && !cells[x] && spanned[x] === on) {
        run += on ? '─' : ' '
        x++
      }
      lb.seg({ s: run, fg: on ? COLORS.rule : undefined })
    }
    lb.nl()
  })
  const lanesN = rowsMemo(ls as unknown as Row[], 'lanesN', () => ls.filter(l => !l.head).length)
  if (ls.length > b - a) lb.line([{ s: `${ls.slice(a, b).filter(l => !l.head).length} of ${num(lanesN)} lanes`, fg: COLORS.dim }])
  // the axis: its ends and middle as times, durations or numbers
  const fmtT = (t: number) => (tf?.type === 'time' ? timeText([t])[0]! : tf?.type === 'duration' ? dur(t) : fieldNum(+t.toPrecision(4)))
  const [ta, tm, tb] = tf?.type === 'time' ? timeText([t0, (t0 + t1) / 2, t1]) : [fmtT(t0), fmtT((t0 + t1) / 2), fmtT(t1)]
  // the axis: a click zooms to half the span around that time
  lb.seg({ s: ' '.repeat(left) })
  for (let x = 0; x < W; x++) lb.seg({ s: x ? '─' : '└', fg: COLORS.rule }, { op: 'zoom', t: t0 + ((t1 - t0) * x) / Math.max(1, W - 1), span: [full0, full1] })
  lb.nl()
  const mid = Math.floor(W / 2) - Math.floor(width(tm!) / 2)
  let axis = ta!
  if (mid > width(axis) + 1 && mid + width(tm!) + 1 < W - width(tb!)) axis += ' '.repeat(mid - width(axis)) + tm!
  axis += ' '.repeat(Math.max(1, W - width(axis) - width(tb!))) + tb!
  if (z) {
    lb.seg({ s: 'whole' }, { op: 'zoom', t: null })
    lb.seg({ s: ' '.repeat(Math.max(1, left - 5)) + axis, fg: COLORS.dim })
    lb.nl()
  } else if (!ctx.indent) lb.line([{ s: ' '.repeat(left) + axis, fg: COLORS.dim }])
  legendLines(lb, legend, cols, left)
  const order: ViewSel[] = lc ? rowsMemo(ls as unknown as Row[], `order:${lc.name}`, () => ls.filter(l => !l.head).map(l => ({ c: lc.name, k: l.key }))) : rowsMemo(ctx.rows, `order:${bkey}`, () => [...marks].sort((p, q) => p.t - q.t).map(m => ({ c: col.name, k: keyOf(col, m.r) })))
  return { ...lb.b, order, start: a, cap: laneCap, total: ls.length, left }
}

/** `s` then spaces to `n` cells, for text already cut to fit. */
function padEnd(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - width(s)))
}

/** Counts over the whole span in a strip two cells high, a bin per column, each bin in the colour of its commonest
 *  `color` value (or of the label on that marks most of it); bins outside the zoom window dim. A click on a bin zooms
 *  to half the span around it, as the lanes' axis does. */
function histogram(ctx: Ctx, body: HistogramBody, cols: number, cap: number): Block {
  const { spec, data, st, col } = ctx
  const tf = fieldIn(col, body.time)
  const lb = builder()
  const rows = ctx.wide ?? ctx.rows
  const bkey = JSON.stringify(body)
  const [full0, full1] = memo(spec, data, `whole:${col.name}:${body.time}`, () => extent((data.collections[col.name] ?? []).map(r => laneTime(tf, r[body.time])).filter((t): t is number => t !== null)))
  const timed = rowsMemo(rows, `timed:${bkey}`, () => rows.some(r => laneTime(tf, r[body.time]) !== null))
  if (!Number.isFinite(full0) || !timed) {
    lb.line([{ s: '  none', fg: COLORS.dim }])
    return lb.b
  }
  const span = Math.max(1e-9, full1 - full0)
  // the strip's scale at its left: the most rows in one bin at its top, none at its foot; over lanes, in the lanes'
  // name column, so a bin stands over its marks
  const count = (W: number) =>
    rowsMemo(rows, `bins:${bkey}:${W}:${st.labelsOn.join(',')}`, () => {
      const n = new Array<number>(W).fill(0)
      const tally: Map<string, number>[] = Array.from({ length: W }, () => new Map())
      for (const r of rows) {
        const t = laneTime(tf, r[body.time])
        if (t === null) continue
        const b = Math.min(W - 1, Math.max(0, Math.floor(((t - full0) / span) * W)))
        n[b]!++
        const mark = markOf(data, st, col, r)
        const key = mark ? `\u0001${mark}` : body.color ? String(vals(r[body.color])[0] ?? '') : ''
        tally[b]!.set(key, (tally[b]!.get(key) ?? 0) + 1)
      }
      return { n, tally, max: Math.max(1, extent(n)[1]) }
    })
  let ind = Math.max(0, Math.min(ctx.indent ?? 0, cols - 20))
  if (!ctx.indent) {
    // the scale as wide as the most rows in a bin at the width it leaves the strip, counted again until it holds
    // ("1,443 ┤", never "1,44…")
    const need = (w: number) => Math.min(cols - 20, width(`${num(count(Math.max(10, w)).max)} ┤`) + 1)
    ind = need(cols - 8)
    for (let k = 0; k < 3 && need(cols - ind) > ind; k++) ind = need(cols - ind)
  }
  const W = Math.max(10, cols - ind)
  const H = cap >= 4 ? 2 : 1
  const { n, tally, max } = count(W)
  const pal = body.color ? palette(spec, data, col.name, body.color) : new Map<string, string>()
  const z = st.zoom?.[String(st.tab)]
  const colourOf = (b: number): string | undefined => {
    if (z) {
      const t = full0 + ((b + 0.5) / W) * span
      if (t < z[0] || t > z[1]) return COLORS.rule
    }
    // the hue of its commonest value (dim past the commonest), of the label on that marks it (dim where none does), or
    // dim for a strip of no colour field; outside the zoom, the rule grey
    const top = [...tally[b]!.entries()].sort((p, q) => q[1] - p[1])
    const marked = top.find(([k]) => k.startsWith('\u0001'))
    if (marked) return marked[0].slice(1)
    if (st.labelsOn.length) return COLORS.dim
    return body.color ? (pal.get(top[0]?.[0] ?? '') ?? COLORS.dim) : COLORS.dim
  }
  const BLOCKS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  const side = H === 2 ? [`${num(max)} ┤`, '0 ┤'] : [`${num(max)} ┤`]
  for (let y = H - 1; y >= 0; y--) {
    if (ind) lb.seg({ s: pad(side[H - 1 - y] ?? '', ind - 1, true) + ' ', fg: COLORS.dim })
    for (let b = 0; b < W; b++) {
      // a bin with any rows stands above the baseline
      const lvl = n[b] ? Math.max(2, Math.round((n[b]! / max) * H * 8)) : 0
      const here = Math.max(0, Math.min(8, lvl - y * 8))
      const ch = here ? BLOCKS[here]! : y === 0 ? '▁' : ' '
      lb.seg({ s: ch, fg: here ? colourOf(b) : COLORS.rule }, { op: 'zoom', t: full0 + ((b + 0.5) / W) * span, span: [full0, full1] })
    }
    lb.nl()
  }
  const fmtT = (t: number) => (tf?.type === 'duration' ? dur(t) : fieldNum(+t.toPrecision(4)))
  const [ta, tm, tb] = tf?.type === 'time' ? timeText([full0, (full0 + full1) / 2, full1]) : [fmtT(full0), fmtT((full0 + full1) / 2), fmtT(full1)]
  let axis = ta!
  const mid = Math.floor(W / 2) - Math.floor(width(tm!) / 2)
  if (mid > width(axis) + 1 && mid + width(tm!) + 1 < W - width(tb!)) axis += ' '.repeat(mid - width(axis)) + tm!
  axis += ' '.repeat(Math.max(1, W - width(axis) - width(tb!))) + tb!
  lb.line([{ s: ' '.repeat(ind) + axis, fg: COLORS.dim }])
  if (cap >= 4) legendLines(lb, histLegend(ctx, body), cols, ind)
  return lb.b
}

/** A strip's legend: each value of its colour field with its count, the commonest first; none while labels are on. */
function histLegend(ctx: Ctx, body: HistogramBody): { glyph: Seg; text: string; act?: ViewAct }[] {
  const { spec, data, st, col } = ctx
  if (!body.color || st.labelsOn.length) return []
  const rows = ctx.wide ?? ctx.rows
  const pal = palette(spec, data, col.name, body.color)
  const counts = rowsMemo(rows, `hlegend:${body.color}`, () => {
    const c = new Map<string, number>()
    for (const r of rows) for (const v of vals(r[body.color!]).slice(0, 1)) c.set(String(v), (c.get(String(v)) ?? 0) + 1)
    return [...c.entries()].sort((p, q) => q[1] - p[1])
  })
  return counts.map(([v, k]) => ({ glyph: { s: '● ', fg: pal.get(v) }, text: `${show(spec, data, col, fieldIn(col, body.color), v) || v} ${num(k)}`, act: { op: 'facet', field: body.color!, value: v } }))
}

const SCROLLS = new Set(['table', 'list', 'transcript', 'lanes'])

function natural(ctx: Ctx, b: Body, cols: number): number {
  // the bars a picked value leaves: every value under the other filters, as bars() draws them
  if (b.kind === 'bars') return Math.min(new Set((ctx.except ? ctx.except(b.field) : ctx.rows).flatMap(r => vals(r[b.field]).map(String))).size, 8) + 1 + (b.color ? 2 : 0)
  if (b.kind === 'histogram') return 3 + legendHeight(histLegend(ctx, b), cols, ctx.indent ?? 8)
  return 99
}

function component(ctx: Ctx, b: Body, cols: number, cap: number, scrolls: boolean): Windowed | Block {
  const select = (c: ViewCollection, r: Row): ViewAct => ({ op: 'select', c: c.name, k: keyOf(c, r) })
  switch (b.kind) {
    case 'table':
      return table(ctx, b, cols, cap, select, scrolls)
    case 'list':
      return list(ctx, b, cols, cap, select, scrolls)
    case 'transcript':
      return transcript(ctx, b, cols, cap, select, scrolls)
    case 'lanes':
      return lanes(ctx, b, cols, cap, scrolls)
    case 'bars':
      return bars(ctx, b, cols, cap)
    case 'graph':
      return graph(ctx, b, cols, cap)
    case 'histogram':
      return histogram(ctx, b, cols, cap)
  }
}

// ---------------------------------------------------------------------------------------- detail

function defaultDetail(c: ViewCollection): Detail {
  return { fields: c.fields.filter(f => f.name !== c.key && f.name !== c.title && f.name !== (c.ref ?? 'ref') && f.type !== 'text').map(f => f.name), text: c.fields.find(f => f.type === 'text' && f.name !== c.title)?.name }
}

/** The rows a related section shows while another follows it, so every section is in reach without scrolling past
 *  hundreds of rows; the rest open on a click. */
export const RELATED_ROWS = 8

/** The selected row in full: its title, its place, its fields (a link followed by a click; `extra`, the columns its
 *  table left out at this width, after them), its text, and the rows of other collections that name it. */
export function detail(spec: ViewSpec, data: ViewData, st: ViewState, cols: number, extra: readonly string[] = []): Block {
  const lb = builder()
  const c = st.sel ? collectionOf(spec, st.sel.c) : undefined
  const r = rowOf(spec, data, st.sel)
  if (!c || !r) return lb.b
  const d = c.detail ?? defaultDetail(c)
  const title = titleOf(spec, data, c, r)
  const ref = refOf(c, r)
  const place = ref ? placeLabel(ref) : ''
  // its glyph at A0 as its row shows it (its flag, else its colour), or ‹ to go back to the row it was followed from;
  // its title at A2, regular; ↗ and its place underlined, and ?, against the right edge
  const g = glyphColumn(spec, st, c) ? glyphOf(spec, data, st, c, r) : { s: ' ' }
  if (st.back.length) lb.seg({ s: '‹ ' }, { op: 'back' })
  else lb.seg({ ...g, s: `${g.s.trim() || ' '} ` })
  // a file of the file browser says what opening it shows; any other row its place (`↗`, blue and underlined) and `?`
  const kind = c.opens && typeof r.kind === 'string' ? (r.opens_as === false || /^(binary|image|pdf|database|other)$/.test(r.kind) ? 'opens as raw bytes: not shown' : `opens as ${r.kind}`) : ''
  const right = kind ? width(kind) : (place ? width(place) + 2 + 2 : 0) + 1
  const room = cols - lb.x - right - 2
  lb.seg({ s: cutName(title, Math.max(8, room)) })
  lb.seg({ s: ' '.repeat(Math.max(2, cols - lb.x - right)) })
  if (kind) lb.seg({ s: kind, fg: COLORS.dim })
  else {
    if (place) {
      lb.seg({ s: '↗ ', fg: LINK }, { op: 'cite', ref, text: title }, { cite: { ref, text: title, label: title } })
      lb.seg({ s: place, fg: LINK, u: true }, { op: 'cite', ref, text: title }, { cite: { ref, text: title, label: title } })
      lb.seg({ s: '  ' })
    }
    lb.seg({ s: '?', fg: LINK }, { op: 'ask', c: c.name, k: keyOf(c, r) }, { cite: citeOf({ spec, data }, c, r) })
  }
  lb.nl()
  // the record's first lines, their numbers right-aligned in a dim column (the file browser's file)
  if (d.lines) {
    const ls = vals(r[d.lines]).map(String)
    const nw = String(ls.length).length
    ls.forEach((l, i) => lb.line([{ s: `  ${String(i + 1).padStart(nw)}  `, fg: COLORS.dim }, { s: cut(l.replace(/\t/g, '  '), Math.max(8, cols - nw - 4)) }]))
    if (!ls.length) lb.line([{ s: '  none', fg: COLORS.dim }])
  }
  // its meta values under the title, each after its field's name (a value alone, such as a week, may not say what it
  // is), a flagged one in its flag's colour; on a second line when they do not fit one
  const metaFields = d.meta ?? []
  const metas = metaFields.flatMap(m => {
    const f = fieldIn(c, m)
    const raw = vals(r[m])
    const segs = chipSegs(f, raw.map(v => show(spec, data, c, f, v)), raw, 40)
    return segs.length ? [[{ s: `${f?.label ?? m} `, fg: COLORS.dim }, ...segs] as Seg[]] : []
  })
  // at A2, dim, each value after its field's label, parted by " · "
  if (metas.length) {
    let lines = 1
    lb.seg({ s: '  ' })
    for (const segs of metas) {
      if (lb.x > 2 && lb.x + 3 + lineWidth(segs) > cols) {
        if (lines === 2) break
        lb.nl()
        lb.seg({ s: '  ' })
        lines++
      } else if (lb.x > 2) lb.seg({ s: ' · ', fg: COLORS.dim })
      for (const x of fitLine(segs.map(x => (x.fg ? x : { ...x, fg: COLORS.dim })), cols - 2)) lb.seg(x)
    }
    lb.nl()
  }
  // fields as label and value, in two columns where they fit; a link's value follows to its row
  const named = new Set([...(d.fields ?? []), ...metaFields, c.key, c.title, c.ref ?? 'ref'])
  const fs = [...(d.fields ?? []), ...extra.filter(n => !named.has(n))].map(n => fieldIn(c, n)!).filter(f => f && vals(r[f.name]).length)
  // at A2, two blocks side by side from 80 cells, the second at the middle; numbers right-aligned on their block's widest
  const A2 = 2
  if (fs.length) {
    const labW = Math.min(18, extent(fs.map(f => width(f.label ?? f.name)))[1]) + 2
    const half = Math.floor((cols - A2) / 2)
    // a value that would be cut in half the width takes a line of its own, before the short ones in two columns
    const text = (f: ViewField) => vals(r[f.name]).map(v => show(spec, data, c, f, v)).join(', ')
    const long = cols >= 80 && fs.length > 3 ? fs.filter(f => width(text(f)) > half - labW - 1) : []
    const short = fs.filter(f => !long.includes(f))
    const two = cols >= 80 && short.length > 3
    const isNum = (f: ViewField) => f.type === 'number' || f.type === 'duration'
    const per = two ? Math.ceil(short.length / 2) : short.length
    const blocks = two ? [short.slice(0, per), short.slice(per)] : [short]
    const numW = blocks.map(b => Math.max(0, ...b.filter(isNum).map(f => width(text(f)))))
    const field = (f: ViewField, colW: number, nw: number) => {
      const x0 = lb.x
      lb.seg({ s: pad(cut(f.label ?? f.name, labW - 2), labW), fg: COLORS.dim })
      const vs = vals(r[f.name])
      if (links(f).length) {
        // a link to another row of the view: a click follows it; not underlined, as it stays in the view
        vs.forEach((v, j) => {
          if (lb.x - x0 >= colW - 4) return
          const t = show(spec, data, c, f, v)
          const to = linked(spec, data, f, v)
          if (j) lb.seg({ s: ', ', fg: COLORS.dim })
          const s = cutName(t, Math.max(4, colW - (lb.x - x0) - 1))
          if (to) lb.seg({ s }, { op: 'follow', c: to.c.name, k: String(v) })
          else lb.seg({ s })
        })
      } else if (isNum(f) && nw) lb.seg({ s: pad(text(f), nw, true), fg: flagColour(f, r[f.name]) })
      else lb.seg({ s: cut(text(f), Math.max(4, colW - labW - 1)), fg: flagColour(f, r[f.name]) })
      return lb.x - x0
    }
    for (const f of long) {
      lb.seg({ s: ' '.repeat(A2) })
      field(f, cols - A2, 0)
      lb.nl()
    }
    for (let i = 0; i < per; i++) {
      lb.seg({ s: ' '.repeat(A2) })
      const used = field(short[i]!, two ? half - 2 : cols - A2, numW[0]!)
      const right = two ? short[i + per] : undefined
      if (right) {
        lb.seg({ s: ' '.repeat(Math.max(2, half - used)) })
        field(right, half, numW[1]!)
      }
      lb.nl()
    }
  }
  if (d.text) {
    const tf = fieldIn(c, d.text)
    const t = show(spec, data, c, tf, r[d.text])
    if (t) {
      // its field's label dim at A2, as every other value has one, then the text under it at the measure
      lb.line([])
      lb.line([{ s: `  ${tf?.label ?? d.text}`, fg: COLORS.dim }])
      for (const l of wrap(t, cols - 2, 12)) lb.line([{ s: `  ${l}` }])
    }
  }
  // the related sections that hold rows, each but the last shortened to its first rows until opened
  const rels = (d.related ?? []).flatMap(rel => {
    const rc = collectionOf(spec, rel.collection)
    if (!rc) return []
    const key = keyOf(c, r)
    // the rows of the collection by each value of the field that names this one, made once
    const by = memo(spec, data, `via:${rc.name}:${rel.via}`, () => {
      const m = new Map<string, Row[]>()
      for (const x of data.collections[rc.name] ?? [])
        for (const v of new Set(vals(x[rel.via]).map(String))) {
          const rs = m.get(v)
          if (rs) rs.push(x)
          else m.set(v, [x])
        }
      return m
    })
    const rows = (by.get(key) ?? []).filter(x => matchWhere(x, rel.where))
    return rows.length ? [{ rel, rc, rows }] : []
  })
  rels.forEach(({ rel, rc, rows: all }, i) => {
    lb.line([])
    lb.line([{ s: rel.title }, { s: `  ${num(all.length)}`, fg: COLORS.dim }])
    const whole = i === rels.length - 1 || st.open.includes(relatedKey(c, rel.title))
    const sort = rel.show.sort ?? (rel.show.kind === 'transcript' && rel.show.time ? { field: rel.show.time } : undefined)
    const rows = whole || all.length <= RELATED_ROWS ? all : sortRows(spec, rc, all, sort).slice(0, RELATED_ROWS)
    const ctx: Ctx = { spec, data, st, col: rc, rows }
    const follow = (cc: ViewCollection, rr: Row): ViewAct => ({ op: 'follow', c: cc.name, k: keyOf(cc, rr) })
    const cap = 400
    const blk = rel.show.kind === 'table' ? table(ctx, rel.show, cols, cap, follow, false) : rel.show.kind === 'list' ? list(ctx, rel.show, cols, cap, follow, false) : transcript(ctx, rel.show, cols, cap, follow, false)
    lb.block(blk)
    const act: ViewAct = { op: 'whole', key: relatedKey(c, rel.title) }
    if (rows.length < all.length) lb.line([{ s: `  … ${num(all.length - rows.length)} more`, fg: COLORS.dim }], act)
    else if (i < rels.length - 1 && all.length > RELATED_ROWS) lb.line([{ s: '  fewer' }], act)
  })
  return lb.b
}

/** The key in `open` of a related section shown whole. */
const relatedKey = (c: ViewCollection, title: string) => `rel:${c.name}:${title}`

function panelBlock(spec: ViewSpec, data: ViewData, st: ViewState, cols: number): Block {
  const lb = builder()
  if (st.panel === 'problems') {
    const ps = [...(data.problems ?? []).map(p => ({ ...p, kind: 'unreadable' })), ...(data.unplaced ?? []).map(p => ({ ...p, kind: 'unplaced' }))]
    lb.line([{ s: `${num(data.problems?.length ?? 0)} unreadable lines`, fg: COLORS.problem }, ...(data.unplaced?.length ? [{ s: ` · ${num(data.unplaced.length)} unplaced`, fg: COLORS.dim }] : [])], { op: 'panel', p: '' })
    for (const h of data.hidden ?? []) lb.line([{ s: cut(`${h.path}  left out: ${h.why}`, cols), fg: COLORS.dim }])
    for (const p of ps) {
      const place = placeLabel(p.ref)
      lb.seg({ s: '  ↗ ' }, { op: 'cite', ref: p.ref, text: p.why }, { cite: { ref: p.ref, text: p.why, label: place } })
      lb.seg({ s: place, u: true }, { op: 'cite', ref: p.ref, text: p.why }, { cite: { ref: p.ref, text: p.why, label: place } })
      lb.seg({ s: '  ' })
      lb.seg({ s: cut(p.why, Math.max(8, cols - width(place) - 6)), fg: p.kind === 'unplaced' ? COLORS.dim : undefined })
      lb.nl()
    }
  } else if (st.panel === 'derived' || st.panel === 'about') {
    if (st.panel === 'about') {
      const files = data.files !== undefined ? `${num(data.files)} file${data.files === 1 ? '' : 's'} read` : 'Files'
      lb.line([{ s: files }, { s: `  ${spec.scope.join(' · ')}`, fg: COLORS.dim }], { op: 'panel', p: '' })
      for (const h of data.hidden ?? []) lb.line([{ s: cut(`  ${h.path}  left out: ${h.why}`, cols), fg: COLORS.dim }])
      if (data.unplaced?.length) lb.line([{ s: `  ${num(data.unplaced.length)} records read but not drawn`, fg: COLORS.dim }, { s: '  show ›' }], { op: 'panel', p: 'problems' })
      lb.line([])
    }
    lb.line([{ s: 'Fields the reader made' }, { s: '  rather than read as the files hold them', fg: COLORS.dim }], { op: 'panel', p: '' })
    for (const c of spec.collections) {
      const ds = c.fields.filter(f => f.derived)
      if (!ds.length) continue
      lb.line([])
      lb.line([{ s: c.name }, { s: `  ${num(ds.length)}`, fg: COLORS.dim }])
      for (const f of ds) {
        lb.line([{ s: `  ${f.label ?? f.name}` }, { s: '  ' }, { s: f.derived ?? '', fg: COLORS.dim }])
        for (const l of wrap(`from ${f.from ?? '?'}; ${f.how ?? ''}`, cols - 4, 2)) lb.line([{ s: `    ${l}`, fg: COLORS.dim }])
      }
    }
  }
  return lb.b
}

// ---------------------------------------------------------------------------------------- the whole view

/** The keys a view names in its last row (views/SPEC.md, rule 26). */
export function viewHints(spec: ViewSpec): string[] {
  const opens = spec.collections.some(c => c.opens)
  const grouped = spec.tabs.some(t => t.body.some(b => (b.kind === 'table' || b.kind === 'list') && b.group))
  return opens ? ['Enter to open', '↑↓ to choose', ...(grouped ? ['Space to fold'] : []), 'x to close'] : ['↑↓ to choose', '/ to search', 'Enter to open its place', '? to ask', 'x to close']
}

/** The view at `cols` × `rows` cells: the header (title, subtitle, tabs, search box), the filter row, the overview,
 *  the records, the selected row's details (or what the header opened) under them, and the key hints. `lead`: the
 *  margin before every line, where `❯` marks the selected row (register.tsx draws views with 2). */
export function viewLayout(spec: ViewSpec, data: ViewData, st0: ViewState, full: number, rows0: number, margin = 0, lead = 0): ViewLayout {
  // the type area's width (`full`): the header, the filter row, the rules, the overview and the detail take it whole;
  // the records leave `margin` cells at its right, where "?" stands beside the row under the pointer (views.tsx)
  const cols = Math.max(20, full - margin)
  const st = { ...st0, tab: Math.max(0, Math.min(st0.tab, spec.tabs.length - 1)) }
  const tr = tabRows(spec, data, st)
  const tab = spec.tabs[st.tab]!
  // the last row holds the key hints
  const rows = Math.max(8, rows0 - 1)
  const lb = builder()
  lb.block(header(spec, data, st, full, tr))
  lb.block(filterRow(spec, data, st, full, tr))
  let below = st.panel ? panelBlock(spec, data, st, full) : detail(spec, data, st, full)
  const ctx: Ctx = { spec, data, st, col: tr.col, rows: tr.rows, wide: tr.wide, except: tr.except }
  const hasBelow = below.lines.length > 0
  // the overview: at most a third of what is left, then its line saying what a click on it does
  const room0 = Math.max(4, rows - lb.y)
  if (tab.overview) {
    // a strip over lanes on the same time shares their axis
    const under = tab.body.find(b => b.kind === 'lanes') as LanesBody | undefined
    const shared = tab.overview.kind === 'histogram' && under && under.time === tab.overview.time
    if (shared) ctx.indent = (lanes(ctx, under, cols, 6, false) as Windowed).left
    // the overview takes the type area, or the lanes' width when it shares their axis
    const ow = shared ? cols : full
    const capO = Math.max(3, Math.min(natural(ctx, tab.overview, ow), Math.floor(room0 * (tab.overview.kind === 'graph' ? 0.4 : 0.34))))
    // the rule under the filter row, then the overview named by a dim title row
    lb.line([{ s: '─'.repeat(full), fg: COLORS.rule }])
    const caption = overviewCaption(spec, tr.col, tab.overview)
    if (caption) lb.line([{ s: cut(caption, full), fg: COLORS.dim }])
    const ov = component(ctx, tab.overview, ow, capO, false)
    const oc = tab.overview.kind === 'histogram' || tab.overview.kind === 'lanes' ? tab.overview.color : undefined
    if (oc) ctx.legend = oc
    lb.block(ov, capO)
    // blank space, not a rule, between the overview and the records; the spec's zoom phrase is not printed (the view
    // carries no usage hints: what a click does follows from the overview's kind)
    lb.line([])
  } else lb.line([{ s: '─'.repeat(full), fg: COLORS.rule }])
  const left = Math.max(4, rows - lb.y)
  const scrollAt = (() => {
    for (let i = tab.body.length - 1; i >= 0; i--) if (SCROLLS.has(tab.body[i]!.kind)) return i
    return -1
  })()
  const lastAt = scrollAt >= 0 ? scrollAt : tab.body.length - 1
  // the detail takes up to half, the body the rest
  let bodyCap = hasBelow ? Math.max(4, Math.floor((left - 1) * 0.5), left - 1 - below.lines.length) : left
  // components that do not scroll are drawn first at up to their share; the scrolling one takes the rest
  const blocks: (Windowed | Block)[] = new Array(tab.body.length)
  let rest = bodyCap - Math.max(0, tab.body.length - 1)
  tab.body.forEach((b, i) => {
    if (i === lastAt) return
    const blk = component(ctx, b, cols, Math.min(natural(ctx, b, cols), Math.max(3, Math.floor(bodyCap * 0.45))), false)
    blocks[i] = blk
    rest -= blk.lines.length
  })
  blocks[lastAt] = component(ctx, tab.body[lastAt]!, cols, Math.max(3, rest), lastAt === scrollAt)
  // the columns a table left out at this width show in the selected row's detail
  const dropped = blocks.flatMap(b => ('dropped' in b ? (b.dropped ?? []) : []))
  if (!st.panel && dropped.length && st.sel?.c === tr.col.name) below = detail(spec, data, st, full, dropped)
  const used = blocks.reduce((n, b) => n + b.lines.length, 0) + Math.max(0, blocks.length - 1)
  if (hasBelow && used < bodyCap) bodyCap = used
  const bodyTop = lb.y
  blocks.forEach((b, i) => {
    if (i) lb.line([])
    lb.block(b, Math.max(0, bodyTop + bodyCap - lb.y))
  })
  const bodyEnd = lb.y
  const win = scrollAt >= 0 ? (blocks[scrollAt] as Windowed) : undefined
  let detailRange: [number, number] = [lb.y, lb.y]
  let dstart = 0
  if (hasBelow) {
    lb.line([{ s: '─'.repeat(full), fg: COLORS.rule }])
    const room = Math.max(1, rows - lb.y)
    dstart = Math.max(0, Math.min(st.dscroll, below.lines.length - room))
    const shown: Block = { lines: below.lines.slice(dstart, dstart + room), hits: below.hits.filter(h => h.y >= dstart && h.y < dstart + room).map(h => ({ ...h, y: h.y - dstart })) }
    // the title line stays when the detail scrolls
    if (dstart > 0 && shown.lines.length) {
      shown.lines[0] = below.lines[0]!
      shown.hits = [...shown.hits.filter(h => h.y !== 0), ...below.hits.filter(h => h.y === 0)]
    }
    detailRange = [lb.y, lb.y + shown.lines.length]
    lb.block(shown)
  }
  const kept = lb.b.lines.slice(0, rows).map(l => fitLine(l, full))
  kept.push([{ s: viewHints(spec).join(' · '), fg: COLORS.dim, i: true }].map(x => ({ ...x, s: cut(x.s, full) })))
  // the margin: `❯` in the accent before the selected row's first line, its words in the accent; else blank
  const lines = kept.map(l => {
    const mark = l.find(x => x.fg === SEL || x.fg === SEL_WHOLE)
    const rest = l.filter(x => x.fg !== SEL && x.fg !== SEL_WHOLE)
    if (!lead) return rest
    if (!mark) return [{ s: ' '.repeat(lead) }, ...rest]
    const whole = mark.fg === SEL_WHOLE
    return [{ s: '❯'.padEnd(lead), fg: ACCENT }, ...rest.map(x => (x.fg === undefined || x.fg === COLORS.text || (whole && x.fg === COLORS.dim) ? { ...x, fg: ACCENT } : x))]
  })
  const hits = lb.b.hits.filter(h => h.y < rows && h.x0 < full).map(h => ({ ...h, x0: h.x0 + lead, x1: Math.min(h.x1, full) + lead }))
  return {
    lines,
    hits,
    meta: { order: win?.order ?? [], start: win?.start ?? 0, cap: win?.cap ?? 1, body: [bodyTop, bodyEnd], detail: detailRange, dstart, dlines: below.lines.length },
  }
}

/** What a bars or strip overview counts, in the words of its rows and its field's label ("pages by week first
 *  stored"); none for lanes and graphs, whose names and axis say it. */
export function overviewCaption(spec: ViewSpec, c: ViewCollection, o: Overview): string {
  const label = (n: string | undefined) => (n ? (fieldIn(c, n)?.label ?? n) : '')
  // the rows as the header counts them, else by their collection's name
  const noun = spec.stats?.find(s => s.agg === 'count' && !s.field && !s.where && s.collection === c.name)?.label ?? c.name
  if (o.kind === 'bars') {
    const agg = o.agg ?? (o.value ? 'sum' : 'count')
    const what = agg === 'count' ? noun : agg === 'mean' ? `mean ${label(o.value)}` : label(o.value)
    return `${what} by ${label(o.field)}`
  }
  if (o.kind === 'histogram') return `${noun} by ${label(o.time)}`
  return ''
}

/** What a side thread about a row of a view is told: the view, what one row is, the row's fields as the view shows
 *  them, and the place it cites. */
export function rowContext(spec: ViewSpec, data: ViewData, slug: string, sel: ViewSel): { label: string; context: string; ref?: string } | null {
  const c = collectionOf(spec, sel.c)
  const r = c ? (data.collections[c.name] ?? []).find(x => String(x[c.key]) === sel.k) : undefined
  if (!c || !r) return null
  const title = titleOf(spec, data, c, r)
  const ref = typeof r[c.ref ?? 'ref'] === 'string' ? String(r[c.ref ?? 'ref']) : ''
  const fields = c.fields
    .filter(f => f.name !== (c.ref ?? 'ref') && r[f.name] !== undefined && r[f.name] !== null && r[f.name] !== '')
    .map(f => `${f.label ?? f.name}: ${show(spec, data, c, f, r[f.name]).slice(0, 400)}${f.derived ? ` (${f.derived}: ${f.how ?? ''})` : ''}`)
  const context = [
    `The analyst points at "${title}" in ${spec.source ? 'the file' : 'the view'} ${spec.name}${ref ? `, [[${ref}]]` : ''}.`,
    `One row of it is ${c.one}. Its fields as the view shows them:\n${fields.join('\n')}`,
    spec.source || c.opens
      ? `The file browser (/thimble-files) shows ${spec.source ? `${spec.source} as the file holds it, its text cut` : "the folder's files"}; read the file itself.`
      : `The view's files: .thimble-cc-mod/views/${slug}/ (view.json, reader.py, rows.json).`,
  ].filter(Boolean).join('\n')
  const short = title.length > 40 ? `${title.slice(0, 39)}…` : title
  // a file's record by its place ("revisions line 4"), after its name when it has one besides its line
  const label = spec.source && ref ? (title === String(r[c.key]) ? placeLabel(ref) : `${short}, ${placeLabel(ref)}`) : `${short} in ${spec.name}`
  return { label, context, ...(ref ? { ref: `[[${ref}]]` } : {}) }
}

// ---------------------------------------------------------------------------------------- the analyst's acts

const turns = new Map<string, Promise<unknown>>()

/** `f` run once every earlier call with the same key has ended: changes of one view's state, read and written, one at
 *  a time and in the order they came (the engine runs the hooks of messages that arrive together side by side). */
export function inTurn<T>(key: string, f: () => Promise<T>): Promise<T> {
  const next = (turns.get(key) ?? Promise.resolve()).catch(() => undefined).then(f)
  turns.set(key, next)
  void next.finally(() => turns.get(key) === next && turns.delete(key)).catch(() => undefined)
  return next
}

/** What an act asks of the hooks module besides the new state: a side thread about a row, or a place opened. */
export type Effect = { ask?: ViewSel; open?: { ref: string; text: string }; file?: string; from?: number; up?: true }

/** The file a row of the file browser's tree opens (its collection's `opens` field), or none. */
function opensFile(spec: ViewSpec, data: ViewData, sel: ViewSel | null): string {
  const c = sel ? collectionOf(spec, sel.c) : undefined
  const v = c?.opens ? rowOf(spec, data, sel)?.[c.opens] : undefined
  return typeof v === 'string' ? v : ''
}

function toggle(xs: readonly string[], x: string): string[] {
  return xs.includes(x) ? xs.filter(y => y !== x) : [...xs, x]
}

/** The state after one act or key, given what the last layout showed. */
export function reduce(spec: ViewSpec, data: ViewData, st: ViewState, act: ViewAct, meta?: ViewMeta): { state: ViewState; effect?: Effect } {
  const same = { state: st }
  switch (act.op) {
    case 'tab':
      if (act.i < 0 || act.i >= spec.tabs.length || act.i === st.tab) return same
      return { state: { ...st, tab: act.i, q: '', typing: false, scroll: 0, labelFilter: st.labelFilter } }
    case 'facet': {
      const k = `${st.tab}.${act.field}`
      return { state: { ...st, facets: { ...st.facets, [k]: toggle(st.facets[k] ?? [], act.value) }, scroll: 0 } }
    }
    case 'more':
      return { state: { ...st, open: toggle(st.open, `${st.tab}.${act.field}.all`) } }
    case 'whole':
      // a folder's `… N more` shows all its rows
      if (act.key.startsWith('__g:')) return { state: { ...st, open: toggle(st.open, `${st.tab}.g.${act.key.slice(4)}.all`) } }
      return { state: { ...st, open: toggle(st.open, act.key) } }
    case 'field': {
      // one field open per tab: another closes it, the same one again too
      const k = `${st.tab}.${act.field}`
      const others = st.open.filter(o => !(o.startsWith(`${st.tab}.`) && !o.endsWith('.all')))
      return { state: { ...st, open: st.open.includes(k) ? others : [...others, k] } }
    }
    case 'unsearch':
      return { state: { ...st, q: '', typing: false, scroll: 0 } }
    case 'sort': {
      const cur = st.sorts[String(st.tab)]
      const body = spec.tabs[st.tab]?.body.find(b => b.kind === 'table' || b.kind === 'list') as TableBody | ListBody | undefined
      const base = cur ?? body?.sort
      const next: Sort = base?.field === act.field ? { field: act.field, desc: !base.desc } : { field: act.field, desc: isNumeric(spec, st, act.field) }
      return { state: { ...st, sorts: { ...st.sorts, [String(st.tab)]: next }, scroll: 0 } }
    }
    case 'select': {
      // the file browser: a click shows a file's first lines under the rule, a second click opens it
      const file = opensFile(spec, data, { c: act.c, k: act.k })
      if (file) return st.sel?.c === act.c && st.sel.k === act.k ? { state: st, effect: { file } } : { state: { ...st, sel: { c: act.c, k: act.k }, back: [], dscroll: 0, panel: '' } }
      if (st.sel?.c === act.c && st.sel.k === act.k && !st.panel) return { state: { ...st, sel: null, back: [], dscroll: 0 } }
      return { state: { ...st, sel: { c: act.c, k: act.k }, back: [], dscroll: 0, panel: '' } }
    }
    case 'up':
      return spec.up ? { state: st, effect: { up: true } } : same
    case 'page': {
      // the window before or after, of the same size; the file browser writes it and opens it in place
      const w = spec.window
      if (!w || !spec.source) return same
      const from = w.from + act.d * (w.to - w.from + 1)
      if (from < 1 || from > w.total) return same
      return { state: { ...st, sel: null, back: [], scroll: 0, dscroll: 0 }, effect: { file: spec.source, from } }
    }
    case 'follow':
      if (!rowOf(spec, data, { c: act.c, k: act.k })) return same
      return { state: { ...st, sel: { c: act.c, k: act.k }, back: st.sel ? [...st.back, st.sel].slice(-20) : st.back, dscroll: 0, panel: '' } }
    case 'back': {
      if (!st.back.length) return same
      return { state: { ...st, sel: st.back.at(-1)!, back: st.back.slice(0, -1), dscroll: 0 } }
    }
    case 'cite':
      return { state: st, effect: { open: { ref: act.ref, text: act.text } } }
    case 'ask':
      return { state: st, effect: { ask: { c: act.c, k: act.k } } }
    case 'label':
      if (!labelOf(data, act.id)) return same
      return { state: { ...st, labelsOn: toggle(st.labelsOn, act.id), labelFilter: st.labelFilter?.id === act.id && st.labelsOn.includes(act.id) ? null : st.labelFilter } }
    case 'labelValue':
      if (!labelOf(data, act.id)) return same
      return {
        state: {
          ...st,
          labelsOn: st.labelsOn.includes(act.id) ? st.labelsOn : [...st.labelsOn, act.id],
          labelFilter: st.labelFilter?.id === act.id && st.labelFilter.value === act.value ? null : { id: act.id, value: act.value },
          scroll: 0,
        },
      }
    case 'search':
      return { state: { ...st, typing: true } }
    case 'clear': {
      const facets = Object.fromEntries(Object.entries(st.facets).filter(([k]) => !k.startsWith(`${st.tab}.`)))
      const zoom = { ...(st.zoom ?? {}) }
      delete zoom[String(st.tab)]
      return { state: { ...st, q: '', typing: false, facets, labelFilter: null, scroll: 0, zoom } }
    }
    case 'group': {
      // folded or unfolded against how it is drawn now: `closed` folds an open group, `<tab>.g.<group>` in `open`
      // unfolds one the file browser folds at first
      const k = `${st.tab}.${act.g}`
      const opened = `${st.tab}.g.${act.g}`
      if (act.open === undefined) return { state: { ...st, closed: toggle(st.closed, k) } }
      return act.open ? { state: { ...st, closed: [...st.closed.filter(x => x !== k), k], open: st.open.filter(x => x !== opened) } } : { state: { ...st, closed: st.closed.filter(x => x !== k), open: [...st.open.filter(x => x !== opened), opened] } }
    }
    case 'panel':
      return { state: { ...st, panel: act.p, dscroll: 0 } }
    case 'scroll': {
      const start = meta?.start ?? st.scroll
      return { state: { ...st, scroll: Math.max(0, start + act.d) } }
    }
    case 'zoom': {
      const k = String(st.tab)
      const zoom = { ...(st.zoom ?? {}) }
      if (act.t === null || !act.span) delete zoom[k]
      else {
        const [a, b] = zoom[k] ?? act.span
        const half = Math.max((b - a) / 4, (act.span[1] - act.span[0]) / 1000)
        const lo = Math.max(act.span[0], act.t - half)
        const hi = Math.min(act.span[1], lo + 2 * half)
        zoom[k] = [Math.max(act.span[0], hi - 2 * half), hi]
      }
      return { state: { ...st, zoom, scroll: 0 } }
    }
    case 'dscroll': {
      const room = meta ? meta.detail[1] - meta.detail[0] : 10
      const max = Math.max(0, (meta?.dlines ?? 0) - room)
      return { state: { ...st, dscroll: Math.max(0, Math.min(max, (meta?.dstart ?? st.dscroll) + act.d)) } }
    }
    case 'key':
      return key(spec, data, st, act, meta)
  }
}

function isNumeric(spec: ViewSpec, st: ViewState, field: string): boolean {
  const c = collectionOf(spec, spec.tabs[st.tab]?.collection ?? '')
  const t = fieldIn(c, field)?.type
  return t === 'number' || t === 'duration' || t === 'time'
}

// the names Claude Code gives special keys, which typing into the search does not take as text
const NAMED_KEYS = new Set(['up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'escape', 'pageup', 'pagedown', 'home', 'end', 'insert'])

function key(spec: ViewSpec, data: ViewData, st: ViewState, ev: { key: string; ctrl?: boolean; shift?: boolean }, meta?: ViewMeta): { state: ViewState; effect?: Effect } {
  const k = ev.key
  if (st.typing) {
    if (k === 'return' || k === 'enter' || k === 'tab') return { state: { ...st, typing: false } }
    if (k === 'backspace' || k === 'delete') return { state: { ...st, q: st.q.slice(0, -1), scroll: 0 } }
    if (ev.ctrl && k === 'u') return { state: { ...st, q: '', scroll: 0 } }
    if (k === 'up' || k === 'down') return key(spec, data, { ...st, typing: false }, ev, meta)
    if (k === 'space' && !ev.ctrl) return { state: { ...st, q: `${st.q} `, scroll: 0 } }
    // keys typed faster than the terminal reports them, or pasted, arrive as one key of several characters
    if (!ev.ctrl && !NAMED_KEYS.has(k) && !/[\u0000-\u001f\u007f]/.test(k)) return { state: { ...st, q: st.q + k, scroll: 0 } }
    return { state: st }
  }
  const order = meta?.order ?? []
  const at = st.sel ? order.findIndex(o => o.c === st.sel!.c && o.k === st.sel!.k) : -1
  const step = (d: number) => {
    if (!order.length) return { state: st }
    const i = at < 0 ? (d > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + d))
    return { state: { ...st, sel: order[i]!, back: [], dscroll: 0, panel: '' as const, scroll: meta?.start ?? st.scroll } }
  }
  switch (k) {
    case 'down':
    case 'j':
      return step(1)
    case 'up':
    case 'k':
      return step(-1)
    case 'pagedown':
      return step(Math.max(1, meta?.cap ?? 10))
    case 'pageup':
      return step(-Math.max(1, meta?.cap ?? 10))
    case 'home':
      return order.length ? { state: { ...st, sel: order[0]!, back: [], scroll: 0, dscroll: 0 } } : { state: st }
    case 'end':
      return order.length ? { state: { ...st, sel: order.at(-1)!, back: [], scroll: order.length, dscroll: 0 } } : { state: st }
    case 'left':
    case 'backspace':
      return reduce(spec, data, st, st.back.length || !spec.up ? { op: 'back' } : { op: 'up' })
    case 'tab':
      return reduce(spec, data, st, { op: 'tab', i: (st.tab + (ev.shift ? spec.tabs.length - 1 : 1)) % spec.tabs.length })
    case '/':
      return { state: { ...st, typing: true } }
    case ']':
      return reduce(spec, data, st, { op: 'dscroll', d: 5 }, meta)
    case '[':
      return reduce(spec, data, st, { op: 'dscroll', d: -5 }, meta)
    case '?':
      return st.sel ? { state: st, effect: { ask: st.sel } } : { state: st }
    case 'space':
    case ' ': {
      // the selected row's group folds (and the row is no longer shown)
      const tab = spec.tabs[st.tab]
      const g = (tab?.body.find(b => b.kind === 'table' || b.kind === 'list') as TableBody | ListBody | undefined)?.group
      const r = rowOf(spec, data, st.sel)
      const c = st.sel ? collectionOf(spec, st.sel.c) : undefined
      if (!g || !r || !c) return { state: st }
      const value = show(spec, data, c, fieldIn(c, g), r[g]) || '–'
      return reduce(spec, data, { ...st, sel: null }, { op: 'group', g: value, open: true })
    }
    case 'o':
    case 'return':
    case 'enter': {
      const file = opensFile(spec, data, st.sel)
      if (file) return { state: st, effect: { file } }
      const c = st.sel ? collectionOf(spec, st.sel.c) : undefined
      const r = rowOf(spec, data, st.sel)
      if (!c || !r || !refOf(c, r)) return { state: st }
      return { state: st, effect: { open: { ref: refOf(c, r), text: titleOf(spec, data, c, r) } } }
    }
    default:
      return { state: st }
  }
}
