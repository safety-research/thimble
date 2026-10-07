// A thimble card (a cell of a group file, workspaces/<c>/notebooks/<group>.json, as `thimble state card` prints it) in
// thimble-cc-mod's drawing form (hooks/draw.ts CardData), so the mod's layouts draw it in the terminal. No `$`.
//
// The map of card kinds (the two-modes study): a table, a timeline, a diagram, an example and a label draw directly; a
// simple bar or line chart (one Altair layer, x and y fields) draws as text; any other chart draws as a table of its
// rows; a note is prose; a code card, a card type's card and a matplotlib figure draw as their printed text; a custom
// HTML card draws as its text. A label card's counts and records come from the label (`thimble state label`).
import type { TermLinks } from '../types'
import type { BarRow, CardData, CardExample, Cell, DiagramEdge, DiagramNode } from './draw'

/** A cell as the workspace stores it: the fields the drawing reads. */
export type ThimbleCell = {
  id: string
  kind?: string
  title?: string
  takeaway?: string
  status?: string
  text?: string
  code?: string
  notebook?: string
  created_by?: string
  labels?: string[]
  payload?: Record<string, unknown> | null
  outputs?: Record<string, unknown>[]
  run?: { state?: string; by?: string; script?: string }
  check?: string
  regenerating_for?: string[]
  label_revs?: Record<string, number>
  verification?: { status?: string; links?: { status?: string; checked?: boolean; resolved?: unknown[]; broken?: unknown[] } | null } | null
}

/** One run of a label as the concept keeps it: the records it ran over (`total`), those its scope holds
 *  (`matched_total`), those labeled, its sample size (`limit`, none for every record), when it began. */
export type LabelRun = { total?: number; matched_total?: number | null; labeled?: number; status?: string; paths?: string[]; limit?: number | null; ts?: string }

/** A label (`thimble state label <id>`, the concept route's shape), with a page of its rows when the backend gives
 *  one (`rows`, as GET /concepts/<id>/rows?text=1 answers). */
export type ThimbleLabel = {
  id: string
  name?: string
  kind?: string
  unit?: string
  glob?: string
  labels?: string[]
  trial?: boolean
  label_stats?: { counts?: Record<string, number>; n_labeled?: number }
  description?: string
  spec?: string
  applications?: LabelRun[]
  last_run?: LabelRun | null
  rows?: { ref?: string; label?: string; rationale?: string; analyst?: unknown; text?: string; confidence?: number }[]
  /** its revision, which steps whenever its rows or its definition change (concepts.note_change) */
  rev?: number
}

export const FRAME = 'application/vnd.thimble.frame+json'
export const DIAGRAM = 'application/vnd.thimble.diagram+json'
export const TIMELINE = 'application/vnd.thimble.timeline+json'
export const ERROR = 'application/vnd.thimble.error+json'
export const CARD_TYPE = 'application/vnd.thimble.card+json'
const READS = 'application/vnd.thimble.reads+json'

type Frame = { columns?: string[]; index?: string | null; label?: string; rows?: Cell[][]; total?: number; view?: { columns?: string[] } }
type Enc = { field?: string; type?: string; aggregate?: string }
type VegaLite = {
  mark?: string | { type?: string }
  encoding?: Record<string, Enc | undefined>
  data?: { name?: string; values?: Record<string, unknown>[] }
  datasets?: Record<string, Record<string, unknown>[]>
  layer?: VegaLite[]
  facet?: unknown
  spec?: VegaLite
  hconcat?: VegaLite[]
  vconcat?: VegaLite[]
  concat?: VegaLite[]
}

export type Drawn = { card: CardData; error: string }

function blank(cell: ThimbleCell, kind: string): CardData {
  return { id: cell.id, kind, question: cell.title ?? '', x: '', y: '', note: '', source: {} }
}

function bundles(cell: ThimbleCell): Record<string, unknown>[] {
  return (cell.outputs ?? []).filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object' && !(READS in b))
}

function first(cell: ThimbleCell, pick: (k: string) => boolean): unknown {
  for (const b of bundles(cell)) for (const [k, v] of Object.entries(b)) if (pick(k)) return v
  return undefined
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(x => String(x)).join('')
  return ''
}

/** What the cell printed: its streams and plain text outputs that are not a chart's fallback, in order. */
export function printed(cell: ThimbleCell): string {
  const out: string[] = []
  for (const b of bundles(cell)) {
    if (ERROR in b) continue
    const rich = Object.keys(b).some(k => k !== 'text/plain' && k.includes('/') && !k.startsWith('text/'))
    if (rich) continue
    if ('text/html' in b && !('_stream' in b)) continue
    const t = asText(b['text/plain'])
    if (t && !/^<(VegaLite|Figure|AxesSubplot|matplotlib)\b/.test(t.trim())) out.push(t.replace(/\s+$/, ''))
  }
  return out.join('\n')
}

function unquote(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The rows of the first HTML table in `html` (pandas' DataFrame display), its header row first; [] for none. */
export function htmlTable(html: string): string[][] {
  const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0]
  if (!table) return []
  const rows: string[][] = []
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<(t[dh])[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => unquote(m[2]!.replace(/<[^>]+>/g, '')).trim())
    if (cells.length) rows.push(cells)
  }
  // pandas writes the index's name on a second header row of its own (`<tr><th>name</th><th></th>…`): fold it in
  if (rows.length > 1 && rows[1]!.slice(1).every(c => c === '') && rows[0]![0] === '') rows.splice(0, 2, [rows[1]![0]!, ...rows[0]!.slice(1)])
  return rows
}

function numberOr(s: string): Cell {
  const t = s.replace(/,/g, '')
  return t !== '' && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : s
}

function frameCard(cell: ThimbleCell, f: Frame): CardData {
  const cols = f.columns ?? []
  const label = f.label && cols.includes(f.label) ? f.label : cols[0] ?? ''
  const shown = (f.view?.columns ?? cols).filter(c => c !== label && cols.includes(c))
  const order = [label, ...shown].filter(Boolean)
  const at = order.map(c => cols.indexOf(c))
  const unnamed = !f.label || /^(index|level_\d+)$/.test(f.label) ? label === f.index : false
  return { ...blank(cell, 'table'), columns: order.map((c, i) => (i === 0 && unnamed ? '' : c)), rows: (f.rows ?? []).map(r => at.map(j => (r[j] ?? null) as Cell)), total: f.total }
}

function vegaRows(spec: VegaLite, root: VegaLite): Record<string, unknown>[] {
  if (Array.isArray(spec.data?.values)) return spec.data!.values!
  const name = spec.data?.name
  const sets = root.datasets ?? spec.datasets ?? {}
  if (name && sets[name]) return sets[name]!
  return []
}

/** Every dataset a chart holds, the first that has rows. */
function anyRows(spec: VegaLite, root: VegaLite = spec): Record<string, unknown>[] {
  const own = vegaRows(spec, root)
  if (own.length) return own
  for (const sub of [spec.spec, ...(spec.layer ?? []), ...(spec.hconcat ?? []), ...(spec.vconcat ?? []), ...(spec.concat ?? [])]) {
    if (!sub) continue
    const got = anyRows(sub, root)
    if (got.length) return got
  }
  const sets = Object.values(root.datasets ?? {})
  return sets.find(s => s.length) ?? []
}

function markOf(spec: VegaLite): string {
  return typeof spec.mark === 'string' ? spec.mark : spec.mark?.type ?? ''
}

/** A one-layer bar or line chart as a bar or line card; null for any other chart. */
export function chartCard(cell: ThimbleCell, spec: VegaLite): CardData | null {
  if (spec.layer || spec.facet || spec.hconcat || spec.vconcat || spec.concat || spec.spec) return null
  const mark = markOf(spec)
  const x = spec.encoding?.x
  const y = spec.encoding?.y
  const color = spec.encoding?.color
  if (!x?.field || !y?.field || x.aggregate || y.aggregate) return null
  const rows = vegaRows(spec, spec)
  if (!rows.length) return null
  if (mark === 'bar') {
    // the quantitative axis is the value, the other the label
    const [lab, val] = x.type === 'quantitative' && y.type !== 'quantitative' ? [y.field, x.field] : [x.field, y.field]
    const bars: BarRow[] = rows.map(r => ({ label: String(r[lab] ?? ''), value: Number(r[val] ?? 0), group: color?.field ? String(r[color.field] ?? '') : '' }))
    if (bars.some(b => !Number.isFinite(b.value))) return null
    return { ...blank(cell, 'bar'), x: lab, y: val, rows: bars }
  }
  if (mark === 'line' || mark === 'point' || mark === 'area' || mark === 'circle') {
    const by = new Map<string, [string | number, number][]>()
    for (const r of rows) {
      const s = color?.field ? String(r[color.field] ?? '') : y.field
      const xv = r[x.field]
      by.set(s, [...(by.get(s) ?? []), [typeof xv === 'number' ? xv : String(xv ?? ''), Number(r[y.field] ?? 0)]])
    }
    return { ...blank(cell, 'line'), x: x.field, y: y.field, series: [...by].map(([name, points]) => ({ name, points })) }
  }
  return null
}

function rowsTable(cell: ThimbleCell, rows: Record<string, unknown>[]): CardData | null {
  const columns = rows.length ? Object.keys(rows[0]!) : []
  if (!columns.length) return null
  const cellOf = (v: unknown): Cell => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : (v as Cell))
  return { ...blank(cell, 'table'), columns, rows: rows.map(r => columns.map(c => cellOf(r[c]))), total: rows.length }
}

function diagramOf(cell: ThimbleCell, d: { nodes?: unknown[]; edges?: unknown[] }): CardData {
  const nodes: DiagramNode[] = (d.nodes ?? []).map(n => {
    if (typeof n === 'string') return { id: n, label: n }
    const o = n as { id?: unknown; label?: unknown; name?: unknown; detail?: unknown }
    const id = String(o.id ?? o.name ?? o.label ?? '')
    return { id, label: String(o.label ?? id), ...(typeof o.detail === 'string' && o.detail ? { detail: o.detail } : {}) }
  })
  const edges: DiagramEdge[] = (d.edges ?? []).flatMap(e => {
    const o = (Array.isArray(e) ? { source: e[0], target: e[1], label: e[2] } : e) as { source?: unknown; target?: unknown; from?: unknown; to?: unknown; label?: unknown }
    const source = o.source ?? o.from
    const target = o.target ?? o.to
    if (source === undefined || target === undefined) return []
    return [{ source: String(source), target: String(target), ...(o.label !== undefined && o.label !== null && String(o.label) ? { label: String(o.label) } : {}) }]
  })
  // a node an edge names but the list leaves out is drawn by its name
  const known = new Set(nodes.map(n => n.id))
  for (const e of edges) for (const id of [e.source, e.target]) if (!known.has(id)) (known.add(id), nodes.push({ id, label: id }))
  return { ...blank(cell, 'diagram'), nodes, edges }
}

function timelineOf(cell: ThimbleCell, t: { events?: unknown[] }): CardData {
  const events = (t.events ?? []).flatMap(e => {
    const o = (Array.isArray(e) ? { time: e[0], label: e[1] } : e) as { time?: unknown; label?: unknown; ref?: unknown }
    return o.time === undefined ? [] : [{ time: String(o.time), label: String(o.label ?? ''), ref: typeof o.ref === 'string' ? o.ref : '' }]
  })
  return { ...blank(cell, 'timeline'), events }
}

/** HTML as its words: tags dropped, blocks on lines of their own. */
export function htmlText(html: string): string {
  return unquote(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|h\d|li|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** The card a cell draws as, and the error its last run ended in ('' for none). */
export function cardOfCell(cell: ThimbleCell, label?: ThimbleLabel | null): Drawn {
  const err = first(cell, k => k === ERROR) as { ename?: string; evalue?: string } | undefined
  const error = err ? `${err.ename ?? 'Error'}: ${err.evalue ?? ''}`.trim() : ''
  const kind = cell.kind ?? 'code'
  const payload = cell.payload && typeof cell.payload === 'object' ? cell.payload : null
  if (kind === 'note') return { card: { ...blank(cell, 'note'), note: String(payload?.text ?? cell.text ?? '') }, error }
  if (kind === 'custom') return { card: { ...blank(cell, 'note'), note: htmlText(String(payload?.html ?? '')) || 'a custom card: the browser draws it' }, error }
  if (kind === 'example') {
    const refs = Array.isArray(payload?.refs) ? (payload!.refs as unknown[]) : []
    const examples: CardExample[] = refs.map(r =>
      typeof r === 'string' ? { ref: r.replace(/^\[\[|\]\]$/g, ''), quote: '', note: '' } : { ref: String((r as { ref?: unknown }).ref ?? ''), quote: String((r as { quote?: unknown }).quote ?? ''), note: '' },
    )
    return { card: { ...blank(cell, 'example'), examples }, error }
  }
  if (kind === 'label') return { card: labelCard(cell, label ?? null), error }
  if (payload && (kind === 'diagram' || kind === 'timeline')) {
    const ds = (payload.dataset ?? {}) as { nodes?: unknown[]; edges?: unknown[]; events?: unknown[] }
    return { card: kind === 'diagram' ? diagramOf(cell, ds) : timelineOf(cell, ds), error }
  }
  const frame = first(cell, k => k === FRAME) as Frame | undefined
  if (frame?.columns) return { card: frameCard(cell, frame), error }
  const dg = first(cell, k => k === DIAGRAM) as { nodes?: unknown[]; edges?: unknown[] } | undefined
  if (dg?.nodes) return { card: diagramOf(cell, dg), error }
  const tl = first(cell, k => k === TIMELINE) as { events?: unknown[] } | undefined
  if (tl?.events) return { card: timelineOf(cell, tl), error }
  const vl = first(cell, k => k.startsWith('application/vnd.vegalite')) as VegaLite | undefined
  if (vl && typeof vl === 'object') {
    const chart = chartCard(cell, vl)
    if (chart) return { card: chart, error }
    const table = rowsTable(cell, anyRows(vl))
    if (table) return { card: table, error }
  }
  // a card type's card and a figure: the listing they print
  const typed = bundles(cell).find(b => CARD_TYPE in b)
  if (typed) return { card: { ...blank(cell, 'text'), note: asText(typed['text/plain']) || 'a card of a card type: the browser draws it' }, error }
  const html = first(cell, k => k === 'text/html')
  if (typeof html === 'string' || Array.isArray(html)) {
    const rows = htmlTable(asText(html))
    if (rows.length > 1) return { card: { ...blank(cell, 'table'), columns: rows[0]!, rows: rows.slice(1).map(r => r.map(numberOr)), total: rows.length - 1 }, error }
  }
  const text = printed(cell)
  const figure = bundles(cell).some(b => Object.keys(b).some(k => k.startsWith('image/')))
  if (text || error) return { card: { ...blank(cell, 'text'), note: [text, figure ? '(a figure: the browser draws it)' : ''].filter(Boolean).join('\n') || error }, error }
  if (figure) return { card: { ...blank(cell, 'note'), note: 'A figure: the browser draws it.' }, error }
  return { card: { ...blank(cell, 'text'), note: '' }, error }
}

/** A label card: its count per value in the label's order, with the records of the label's rows (each its value, its
 *  words and why, and whether the analyst set it), as thimble-cc-mod's label card draws them. */
export function labelCard(cell: ThimbleCell, label: ThimbleLabel | null): CardData {
  const card = blank(cell, 'label')
  if (!label) return { ...card, kind: 'note', note: 'The label is being read.' }
  const counts = label.label_stats?.counts ?? {}
  const values = [...(label.labels ?? []), ...Object.keys(counts).filter(k => !(label.labels ?? []).includes(k))]
  const rows: BarRow[] = values.map(v => ({ label: v, value: counts[v] ?? 0, group: '' }))
  const run = label.last_run ?? label.applications?.at(-1) ?? null
  const labeled = label.label_stats?.n_labeled ?? rows.reduce((a, r) => a + r.value, 0)
  const total = typeof run?.total === 'number' ? run.total : labeled
  const examples: CardExample[] = (label.rows ?? [])
    .filter(r => r.ref)
    .slice(0, 6)
    .map(r => {
      const set = Boolean(r.analyst)
      const value = set && typeof r.analyst === 'string' ? r.analyst : String(r.label ?? '')
      return { ref: r.ref!, quote: String(r.text ?? ''), note: '', value, why: String(r.rationale ?? ''), set, ...(set && r.label && r.label !== value ? { was: String(r.label) } : {}) }
    })
  const paths = run?.paths ?? (label.glob ? label.glob.split(/,\s*/).filter(Boolean) : [])
  return {
    ...card,
    question: card.question || label.name || '',
    x: 'value',
    y: label.unit ?? 'record',
    rows,
    total: labeled,
    examples,
    label: { slug: label.id, name: label.name ?? label.id, kind: label.kind ?? '', values, labeled, total, trial: Boolean(label.trial), paths },
  }
}

/** What thimble's links check left of a card's takeaway (backend verify.py), or undefined when it never ran. */
export function linksOf(cell: ThimbleCell): TermLinks | undefined {
  const l = cell.verification?.links
  if (!l || typeof l !== 'object') return undefined
  const entries = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : [])
  const key = (x: Record<string, unknown>) => `${x.value === null || x.value === undefined ? '' : String(x.value)}|${String(x.ref ?? '')}`
  return {
    pending: l.status === 'pending',
    checked: Boolean(l.checked),
    ok: entries(l.resolved).map(key),
    broken: entries(l.broken).map(b => ({ key: key(b), why: String(b.why ?? ''), source: b.source === null || b.source === undefined ? '' : String(b.source) })),
  }
}

/** The words the card's title row says about it while it is not done: its run waits or runs, or it runs again because
 *  a label it read changed. */
export function busyWords(cell: ThimbleCell): string {
  const st = cell.run?.state
  if (st === 'waiting') return 'waiting for its run'
  if (st === 'running' || cell.status === 'running' || cell.status === 'queued') return '◌ running'
  if (cell.regenerating_for?.length) return '◌ running again'
  if (cell.check === 'pending') return '◌ checking'
  return ''
}
