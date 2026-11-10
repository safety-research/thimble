// The tour's example workspace, in memory: what thimble's server answers about the example folder, for the example
// panes (./main.tsx). The folder is made up: three Claude Code agents fix a bug in a tea shop's checkout. ./data.json
// holds its files and what the server answered about them once (every page, key and event of each file), the label
// "what the step does" with its rows, and the report main wrote about the folder (./report.ts). The routes here answer
// from it, as the server would.
//
// What the person changes in the panes is kept here for the frame's life: a label turned on or off, recolored or
// redefined, a record's value marked, a filter set, the Label tool switched, a check turned on or off, and what
// ./report.ts keeps of the report. Each change is told to the panes on the frame's own bus, as the server's stream
// tells a workspace. What needs Claude (running a label, defining a new one, building a view, a check's run, a thread)
// is refused with a line that says so. No request goes further than this module, but for the Timeline mode's page,
// which `timelinePage` gives.
import { bus } from '../lib/bus'
import { apiPath } from '../lib/browserKey'
import type { Check, ConceptDetail, Filters, FolderListing, LabelRowText, SourceEvents, SourceKey, SourceKeys, SourcePage, SourceRecord } from '../lib/types'
import raw from './data.json'
import { createReport, type ReportData } from './report'

/** A long per-bin array of data.json, coded as [value, count] pairs. */
type Runs = [number, number][]
type CodedKeys = Omit<SourceKeys, 'bytes' | 'keys'> & { bytes: Runs; keys: (Omit<SourceKey, 'at'> & { at: Runs })[] }
interface Data {
  name: string
  files: Record<string, string>
  folders: Record<string, FolderListing>
  stamps: Record<string, string>
  pages: Record<string, SourcePage>
  lines: Record<string, { path: string; total_lines: number; estimated: boolean; indexed: number }>
  keys: Record<string, CodedKeys | null>
  events: Record<string, SourceEvents | null>
  concept: ConceptDetail
  /** the label's last kept run, which the list of labels gives in place of every run (`applications`) */
  lastRun: ConceptDetail['last_run']
  rows: (LabelRowText & { source: string; ts: string })[]
  coverage: Record<string, unknown>
  settings: Record<string, unknown>
  checks: Check[]
  answerComments: unknown
  report: ReportData
}
const DATA = raw as unknown as Data

/** The example folder's name, which the panes show as their workspace. */
export const EXAMPLE = DATA.name

/** The line that answers what needs Claude. */
export const NEEDS_CLAUDE = "This is the tour's example data. Claude does this in your own workspace."

/** A page answers at most this many lines (backend corpus.PAGE_MAX), and an answer around a line this many each side. */
const PAGE_MAX = 500
const AROUND_MAX = 250
/** The rows a label's rows route answers by default and at most (backend concepts.ROWS_LIMIT, ROWS_MAX). */
const ROWS_LIMIT = 200
const ROWS_MAX = 2000
/** What the content search shows of each matching line (backend corpus SNIP_BEFORE, SNIP_AFTER, GREP_SHOWN). */
const SNIP_BEFORE = 48
const SNIP_AFTER = 120
const GREP_SHOWN = 5

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const unrun = (runs: Runs): number[] => runs.flatMap(([v, n]) => Array<number>(n).fill(v))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refused = (status: number, detail: string) => json({ detail }, status)
const isJsonl = (path: string) => path.endsWith('.jsonl')

/** Each file's lines as they are, from line 1. */
const LINES: Record<string, string[]> = Object.fromEntries(
  Object.entries(DATA.files).map(([path, text]) => [path, (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')]),
)
/** The files in the order the tree lists them: per folder its folders first, then its files. */
const ORDER: string[] = (() => {
  const out: string[] = []
  const walk = (folder: string) => {
    const f = DATA.folders[folder]
    if (!f) return
    for (const d of f.folders) walk(d.path)
    for (const s of f.files) out.push(s.path)
  }
  walk('')
  return out
})()

/** Where a file's records come from: its page of every line, as the server gave it. */
const pageOf = (path: string): SourcePage | null => DATA.pages[path] ?? null

/** Lines `start` to `end` of a file as the server pages them: its sniff on every page, the time key on the first. */
function slice(path: string, start: number, end: number): SourcePage {
  const full = pageOf(path)!
  const { records, time, ...rest } = full
  return { ...rest, start, records: records.filter((r) => r.line >= start && r.line <= end), ...(start === 1 && time ? { time } : {}) }
}

/** The lines of `path` past `after` that hold `q` (case-insensitive), as the server's find gives them; in a JSON lines
 * file also as JSON writes the words inside a string. With `snippets`, the part of each line around its first match. */
function findIn(path: string, q: string, after = 0, snippets = false) {
  const forms = new Set([q])
  if (isJsonl(path)) {
    forms.add(JSON.stringify(q).slice(1, -1))
    forms.add(JSON.stringify(q).slice(1, -1).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`))
  }
  const needles = [...forms].filter(Boolean).map((f) => f.toLowerCase())
  const lines: number[] = []
  const counts: number[] = []
  const snips: { text: string; hit: [number, number] }[] = []
  let matches = 0
  const all = LINES[path] ?? []
  all.forEach((text, i) => {
    const n = i + 1
    if (n <= after) return
    const low = text.toLowerCase()
    const at = new Set<number>()
    let first = -1
    let size = 0
    for (const needle of needles) {
      for (let pos = low.indexOf(needle); pos >= 0; pos = low.indexOf(needle, pos + needle.length)) {
        at.add(pos)
        if (first < 0 || pos < first) [first, size] = [pos, needle.length]
      }
    }
    if (!at.size) return
    lines.push(n)
    counts.push(at.size)
    matches += at.size
    if (snippets) {
      const a = Math.max(0, first - SNIP_BEFORE)
      const b = Math.min(text.length, first + size + SNIP_AFTER)
      const flat = (s: string) => s.replace(/\r/g, '').replace(/\t/g, ' ')
      const head = (a > 0 ? '…' : '') + flat(text.slice(a, first)).trimStart()
      const hit = flat(text.slice(first, first + size))
      const tail = flat(text.slice(first + size, b)).trimEnd() + (b < text.length ? '…' : '')
      snips.push({ text: head + hit + tail, hit: [head.length, head.length + hit.length] })
    }
  })
  return { lines, counts, total: lines.length, matches, complete: true, scanned: all.length, snippets: snips }
}

/** The files whose path holds every word of `q`, best first (backend corpus.find_paths, without its fuzzy fallback). */
function findPaths(q: string): string[] {
  const query = q.trim().toLowerCase()
  if (!query) return []
  const words = query.split(/\s+/)
  const rank = (path: string) => {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    return name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : words.every((w) => name.includes(w)) ? 3 : 4
  }
  return ORDER.filter((p) => words.every((w) => p.toLowerCase().includes(w))).sort((a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : 1))
}

/** The file's listing entry (FolderListing's SourceInfo). */
const infoOf = (path: string) => Object.values(DATA.folders).flatMap((f) => f.files).find((f) => f.path === path) ?? null

/** `?lines=a-b,c-d` as ranges; null without it. */
function spans(lines: string | null): [number, number][] | null {
  if (!lines || !lines.trim()) return null
  return lines.split(',').flatMap((part) => {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part)
    return m ? [[Number(m[1]), Number(m[2])] as [number, number]] : []
  })
}

/** A record ref's file and line (`path#L12`). */
function refLine(ref: string): { path: string; line: number } | null {
  const m = /^(.+)#L(\d+)$/.exec(ref)
  return m ? { path: m[1], line: Number(m[2]) } : null
}

/** Matches a label's glob, comma-separated patterns where * stands for any part of one name. */
function globFiles(pattern: string): string[] {
  const res = pattern
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`))
  return ORDER.filter((p) => res.some((r) => r.test(p)))
}

export interface ExampleServer {
  /** Whether `url` is a request for thimble's API, which this server answers. */
  answers: (url: string) => boolean
  /** The answer to one request, as thimble's server would give it for the example folder. */
  answer: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** The label as the example starts: turned off, its rows and definition as they were made, no filter. */
  reset: () => void
  /** The example label's id. */
  readonly labelId: string
}

/** A server for one frame. `timelinePage` gives the Timeline mode's page, the view kit's own page, which is the same for
 * every folder. */
export function createServer(opts: { timelinePage?: () => Promise<string> } = {}): ExampleServer {
  let concept: ConceptDetail
  let rows: Data['rows']
  let gone: boolean
  let filters: Filters
  let settings: Record<string, unknown>
  const reset = () => {
    concept = clone(DATA.concept)
    rows = clone(DATA.rows)
    gone = false
    filters = {}
    settings = clone(DATA.settings)
  }
  reset()
  const id = DATA.concept.id
  // the checks, each on or off, and the report with its drafts, comments and cards, as the frame changes them
  const checks: Check[] = clone(DATA.checks)
  const report = createReport(DATA.report, NEEDS_CLAUDE)

  const valueOf = (r: Data['rows'][number]) => r.analyst ?? r.label
  /** The label as the routes give it, its counts read from its rows now. */
  const label = (): ConceptDetail => {
    const counts: Record<string, number> = {}
    for (const r of rows) {
      const v = valueOf(r)
      if (v != null) counts[v] = (counts[v] ?? 0) + 1
    }
    const marked = rows.filter((r) => r.analyst != null).length
    return { ...concept, counts, n_labeled: rows.length, n_marked: marked, n_reviewed: marked }
  }
  const rowsOn = (path: string) => rows.filter((r) => r.ref.startsWith(`${path}#L`))
  /** A row as GET /labels gives it. */
  const plain = ({ text: _text, match: _match, ...r }: Data['rows'][number]) => r
  const group = (list: Data['rows']) =>
    gone || !list.length ? [] : [{ concept_id: id, name: concept.name, labels: concept.labels, unit: concept.unit, created_by: concept.created_by, rows: list.map(plain) }]
  const tell = (what: string, changedRows = true) => bus.emit('concepts', { concept: id, what, rows: changedRows })
  const tellFilter = (scope: 'files' | 'report' | 'canvas') => {
    const f = filters[scope as 'files' | 'report']
    bus.emit('filter', { scope, concept: f?.concept, value: f?.value })
  }

  /** A record's ref as the server resolves it: its record, blocks and meta, and the start of its words. */
  function resolve(ref: string) {
    const at = refLine(ref)
    const rec: SourceRecord | undefined = at ? pageOf(at.path)?.records.find((r) => r.line === at.line) : undefined
    if (!at || !rec) return refused(404, `no record ${ref}`)
    const { fields: _fields, ...meta } = rec.meta ?? {}
    const excerpt = (rec.blocks.find((b) => b.kind !== 'raw')?.text ?? rec.blocks[0]?.text ?? '').slice(0, 400)
    return json({ ref, kind: 'record', path: at.path, line: at.line, record: rec.record, blocks: rec.blocks, meta, excerpt })
  }

  function corpus(rest: string, q: URLSearchParams): Response | Promise<Response> {
    const path = q.get('path') ?? ''
    const known = path in DATA.files
    switch (rest) {
      case 'sources': {
        if (q.get('depth') == null) return json(ORDER.map(infoOf))
        const folder = path === '.' ? '' : path.replace(/^\/+|\/+$/g, '')
        const listing = DATA.folders[folder]
        return listing ? json(listing) : refused(404, `no such folder: '${folder}'`)
      }
      case 'sources/stamps':
        return json({ stamps: Object.fromEntries(q.getAll('path').map((p) => [p, DATA.stamps[p === '' ? '.' : p] ?? null])) })
      case 'sources/kinds':
        return json({ kinds: Object.fromEntries(q.getAll('path').map((p) => [p, p in DATA.files ? 'file' : p.replace(/\/+$/, '') in DATA.folders ? 'folder' : null])) })
      case 'sources/find': {
        const found = findPaths(q.get('q') ?? '')
        return json({ q: q.get('q') ?? '', files: found.map(infoOf).filter(Boolean), total: found.length })
      }
      case 'sources/grep': {
        const text = q.get('q') ?? ''
        if (!text.trim() || text.includes('\n')) return refused(400, 'q must be text on one line')
        const out: unknown[] = [{ progress: true, scanned: 0, of: ORDER.length }]
        let files = 0
        let hits = 0
        for (const p of ORDER) {
          const f = findIn(p, text, 0, true)
          if (!f.total) continue
          files += 1
          hits += f.matches
          out.push({ path: p, total: f.matches, complete: true, matches: f.lines.slice(0, GREP_SHOWN).map((line, i) => ({ line, ...f.snippets[i] })) })
        }
        out.push({ done: true, files, hits, scanned: ORDER.length, of: ORDER.length, complete: true })
        return new Response(out.map((o) => JSON.stringify(o)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson', 'x-search': '1' } })
      }
      case 'sources/grep/stop':
        return json({ stopped: false })
      case 'source': {
        if (!known) return refused(404, `no such file: ${path}`)
        const start = Math.max(1, Number(q.get('start') ?? 1) || 1)
        const count = Math.max(0, Math.min(PAGE_MAX, Number(q.get('count') ?? 100) || 0))
        return json(slice(path, start, start + count - 1))
      }
      case 'source/around': {
        if (!known) return refused(404, `no such file: ${path}`)
        const total = pageOf(path)!.total_lines
        const line = Number(q.get('line'))
        const before = Math.max(0, Math.min(AROUND_MAX, Number(q.get('before') ?? 50)))
        const after = Math.max(0, Math.min(AROUND_MAX, Number(q.get('after') ?? 50)))
        if (!(line >= 1 && line <= total)) {
          if (!(q.get('clamp') && line > total && total > 0)) return refused(404, `line ${line} out of range (${path} has ${total} lines)`)
          return json(slice(path, Math.max(1, total - before), total))
        }
        return json(slice(path, Math.max(1, line - before), line + after))
      }
      case 'source/lines':
        return known ? json(DATA.lines[path]) : refused(404, `no such file: ${path}`)
      case 'source/keys': {
        const k = DATA.keys[path]
        if (!k) return refused(404, `no such file: ${path}`)
        return json({ ...k, bytes: unrun(k.bytes), keys: k.keys.map((key) => ({ ...key, at: unrun(key.at) })) })
      }
      case 'source/events': {
        const e = DATA.events[path]
        return e && e.events.length ? json(e) : refused(415, `'${path}' has no records with a time`)
      }
      case 'source/timeline':
        return opts.timelinePage
          ? opts.timelinePage().then(
              (html) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
              (e: Error) => refused(502, `the Timeline page did not load: ${e.message}`),
            )
          : refused(404, 'no Timeline page here')
      case 'source/find': {
        if (!known) return refused(404, `no such file: ${path}`)
        const text = q.get('q') ?? ''
        if (!text.trim() || text.includes('\n')) return refused(400, 'q must be text on one line')
        const { snippets: _s, ...found } = findIn(path, text, Number(q.get('after') ?? 0) || 0)
        return json({ path, q: text, ...found, total_lines: LINES[path].length })
      }
      case 'source/speakers':
        return json({ names: {} })
      case 'ref': {
        // a ref the report cites, and a card, as the server resolved it; any other record from its file's page
        const ref = q.get('ref') ?? ''
        return Object.prototype.hasOwnProperty.call(DATA.report.refs, ref) ? json(DATA.report.refs[ref]) : resolve(ref)
      }
    }
    if (rest.startsWith('download/')) {
      const p = decodeURIComponent(rest.slice('download/'.length))
      return p in DATA.files ? new Response(DATA.files[p], { status: 200, headers: { 'content-type': 'application/octet-stream' } }) : refused(404, `no such file: ${p}`)
    }
    return refused(404, `not in the tour's example: ${rest}`)
  }

  async function workspace(method: string, rest: string, q: URLSearchParams, body: Record<string, unknown>): Promise<Response> {
    const ofReport = report.answer(method, rest, body)
    if (ofReport) return ofReport
    const conceptPath = new RegExp(`^concepts/${id}(/.*)?$`).exec(rest)
    if (conceptPath && gone) return refused(404, `no label ${id}`)
    if (method === 'GET') {
      switch (rest) {
        case 'concepts': {
          if (gone) return json([])
          const { applications: _runs, ...entry } = label()
          return json([{ ...entry, last_run: DATA.lastRun }])
        }
        case 'labels':
          return json(group(rowsOn(q.get('path') ?? '').filter((r) => {
            const s = spans(q.get('lines'))
            const line = refLine(r.ref)?.line ?? 0
            return !s || s.some(([a, b]) => line >= a && line <= b)
          })))
        case 'labels/presence': {
          if (gone) return json([])
          const paths: Record<string, Record<string, number>> = {}
          for (const r of rows) {
            const at = refLine(r.ref)
            const v = valueOf(r)
            if (!at || v == null) continue
            const per = (paths[at.path] ??= {})
            per[v] = (per[v] ?? 0) + 1
          }
          return json([{ concept_id: id, paths }])
        }
        case 'labels/ruler': {
          const path = q.get('path') ?? ''
          const total = pageOf(path)?.total_lines ?? 0
          const bins = Math.max(1, Math.min(2000, Number(q.get('bins') ?? 400) || 400))
          const on = gone ? [] : rowsOn(path)
          if (!on.length || !total) return json({ path, total, bins, labels: [] })
          const per: Record<string, Map<number, number>> = {}
          for (const r of on) {
            const v = valueOf(r)
            const line = refLine(r.ref)?.line
            if (v == null || line == null) continue
            const b = Math.min(bins - 1, Math.floor(((line - 1) * bins) / total))
            const m = (per[v] ??= new Map())
            m.set(b, (m.get(b) ?? 0) + 1)
          }
          const at = Object.fromEntries(Object.entries(per).map(([v, m]) => [v, [...m.keys()].sort((a, b) => a - b)]))
          const counts = Object.fromEntries(Object.entries(at).map(([v, bs]) => [v, bs.map((b) => per[v].get(b)!)]))
          return json({ path, total, bins, labels: [{ concept_id: id, bins: at, counts }] })
        }
        case 'labels/glob': {
          const files = globFiles(q.get('pattern') ?? '')
          return json({ files: files.slice(0, 200), total: files.length })
        }
        case 'filters':
          return json(filters)
        case 'settings':
          return json(settings)
        case 'checks':
          return json(checks)
        case 'answer-comments':
          return json(DATA.answerComments)
        case 'views':
        case 'views/proposals':
        case 'label-asks':
        case 'notices':
        case 'chats':
          return json([])
        case 'undo':
          return json({ undo: null, redo: null, held: null })
        case 'canvas/comments':
          return json({ comments: [] })
        case 'instance':
          return json({ stamp: null })
        case 'card-checks':
          return json({ on: false, running: [] })
      }
      if (conceptPath?.[1] == null && conceptPath) return json(label())
      if (conceptPath?.[1] === '/rows') {
        const value = q.get('value')?.trim() || null
        const list = rows.filter((r) => !value || valueOf(r) === value)
        const offset = Math.max(0, Number(q.get('offset') ?? 0) || 0)
        const limit = Math.max(1, Math.min(ROWS_MAX, Number(q.get('limit') ?? ROWS_LIMIT) || ROWS_LIMIT))
        const text = q.get('text') === '1' || q.get('text') === 'true'
        const page = list.slice(offset, offset + limit).map(({ source: _s, ts: _t, ...r }) => (text ? r : (({ text: _x, ...rest }) => rest)(r)))
        return json({ rows: page, total: list.length, next: null })
      }
      if (conceptPath?.[1] === '/coverage') return json(DATA.coverage)
    }
    if (method === 'POST' && rest === 'labels/refs') {
      const wanted = new Set(Array.isArray(body.refs) ? (body.refs as unknown[]).filter((r): r is string => typeof r === 'string') : [])
      return json(group(rows.filter((r) => wanted.has(r.ref))))
    }
    if (method === 'PUT' && conceptPath?.[1] == null && conceptPath) {
      // a change to its definition steps its version, as the server's does; the name, glob, colors and `shown` do not
      const before = JSON.stringify([concept.description, concept.spec, concept.labels, concept.kind, concept.unit, concept.marks, concept.model])
      const nameBefore = concept.name
      if (typeof body.name === 'string' && body.name.trim()) concept.name = body.name.trim().replace(/\s+/g, ' ')
      if (typeof body.description === 'string') concept.description = body.description
      if (typeof body.spec === 'string') concept.spec = body.spec
      if (typeof body.glob === 'string') concept.glob = body.glob
      if (typeof body.model === 'string') concept.model = body.model.trim()
      if (typeof body.shown === 'boolean') concept.shown = body.shown
      if (Array.isArray(body.classes) && body.classes.length) {
        const was = new Map((concept.classes ?? []).map((c) => [c.name, c]))
        concept.classes = (body.classes as { name: string; color?: number | null; highlight?: boolean }[]).map((c) => ({
          name: c.name,
          color: c.color ?? was.get(c.name)?.color ?? 0,
          highlight: c.highlight ?? was.get(c.name)?.highlight ?? true,
        }))
        concept.labels = concept.classes.map((c) => c.name)
      } else if (Array.isArray(body.labels)) concept.labels = (body.labels as unknown[]).filter((v): v is string => typeof v === 'string')
      const redefined = JSON.stringify([concept.description, concept.spec, concept.labels, concept.kind, concept.unit, concept.marks, concept.model]) !== before
      if (redefined) concept.version = (concept.version ?? 1) + 1
      if (body.shown === false && filters.files?.concept === id) {
        delete filters.files
        tellFilter('files')
      }
      tell('changed', redefined || concept.name !== nameBefore)
      return json(label())
    }
    if (method === 'DELETE' && conceptPath?.[1] == null && conceptPath) {
      gone = true
      if (filters.files?.concept === id) {
        delete filters.files
        tellFilter('files')
      }
      tell('deleted')
      return json({ ok: true })
    }
    if (method === 'POST' && conceptPath?.[1] === '/labels') {
      // the person's own value for one record, which the label's run then keeps
      const row = rows.find((r) => r.ref === body.ref)
      if (!row) return refused(404, `no record ${String(body.ref)} with a value of ${concept.name}`)
      row.analyst = typeof body.label === 'string' && body.label ? body.label : null
      concept.rev = (concept.rev ?? 0) + 1
      tell('changed')
      return json({ row: plain(row), calibration: concept.calibration })
    }
    if (method === 'PUT' && rest === 'filters') {
      const scope = body.scope === 'report' ? 'report' : 'files'
      filters = { ...filters, [scope]: { concept: String(body.concept ?? ''), value: String(body.value ?? '') } }
      tellFilter(scope)
      return json(filters)
    }
    if (method === 'DELETE' && rest.startsWith('filters/')) {
      const scope = rest.slice('filters/'.length) as 'files' | 'report' | 'canvas'
      const next = { ...filters }
      delete next[scope]
      filters = next
      tellFilter(scope)
      return json(filters)
    }
    if (method === 'PUT' && rest === 'settings') {
      const next = { ...settings }
      for (const [k, v] of Object.entries(body)) {
        if (v == null) delete next[k]
        else next[k] = v
      }
      settings = next
      return json(settings)
    }
    if (method === 'POST' && rest === 'views/suggest') return json({ slug: null })
    // a check turned on or off, as its switch does; one that has not commented on the report yet would run on it then,
    // which needs Claude
    const checkPath = /^checks\/([^/]+)$/.exec(rest)
    const check = checkPath && checks.find((c) => c.id === decodeURIComponent(checkPath[1]))
    if (method === 'PATCH' && check && typeof body.shown === 'boolean' && Object.keys(body).length === 1 && (!body.shown || check.runs?.report?.status === 'done')) {
      check.shown = body.shown
      bus.emit('wsEvent', { type: 'checks', id: check.id } as never)
      bus.emit('checks', { id: check.id })
      return json(check)
    }
    // a new label, a run, a label drafted from words, a view, a message to Claude, a thread, a new check or a check's run
    // or new prompt: each needs Claude
    if (method !== 'GET' && (rest === 'concepts' || rest === 'concepts/draft' || rest === 'events' || rest.startsWith('views') || conceptPath?.[1] === '/apply' || rest === 'chats' || rest === 'checks' || check || rest.startsWith('checks/')))
      return refused(403, NEEDS_CLAUDE)
    return refused(404, `not in the tour's example: ${method} ${rest}`)
  }

  async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://example.invalid/')
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const path = apiPath(url.pathname).replace(/^\/api/, '')
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        return refused(400, 'the body is no JSON')
      }
    }
    const enc = encodeURIComponent(EXAMPLE)
    if (path === '/ui/paired') return json({ paired: true, id: 'example', at: '' })
    if (path === '/tour') return json({ seen: true })
    const c = new RegExp(`^/corpora/(?:${enc}|${EXAMPLE})/(.+)$`).exec(path)
    if (c) return corpus(c[1], url.searchParams)
    const w = new RegExp(`^/ws/(?:${enc}|${EXAMPLE})/(.+)$`).exec(path)
    if (w) return workspace(method, w[1], url.searchParams, body)
    return refused(404, `not in the tour's example: ${path}`)
  }

  return {
    answers: (u: string) => {
      try {
        return /^\/api(\/|$)/.test(apiPath(new URL(u, 'http://example.invalid/').pathname))
      } catch {
        return false
      }
    },
    answer,
    reset,
    labelId: id,
  }
}
