// ready.ts: a card call of a ready kind (kinds.js: example, table, chart, timeline, diagram, note), as the data thimble
// draws it from. tool.ts keeps that data as the version's rows file, and kinds.js STUB as its view. One call's data:
//
//   - the call's fields over those of the card's last call, so a call with `id` changes only what it gives (a new
//     answer, new rows, a new mark), as `edits` change only what they name in a custom card's view
//   - for a field the call leaves out, the `data` file the call names, which Claude's code wrote from the records: a
//     list (the kind's rows, events, edges or records), JSON Lines, or an object of the kind's fields
//   - for an example, each record it cites read from its file (a line or lines of a file in this folder or the temp
//     folder, as the card tool reads its data file) and each quote found in it, so the card shows the record's own words
//     around the passage, and a quote the record does not hold is refused with the record's place
//
// The checks say what to fix in one line, as the card tool's other refusals do.
//
//   FIELDS                  the fields a call gives a ready kind's data in
//   CONTENT                 the fields that change a card: a call with `id` and none of them moves the card as it is
//   readyData($, o)         {data} or {bad}: the version's data, or what to fix
//   kindWords(data)         what the card shows in words, "a table of 12 rows"
import type { EngineInterface } from 'claude-code'

import { KINDS } from './kinds.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Each ready kind's fields, besides its answer: what a call, a data file or the last call gives it. */
const OWN: Record<string, string[]> = {
  table: ['rows'],
  chart: ['rows', 'mark', 'x', 'y', 'x2', 'color'],
  timeline: ['events'],
  diagram: ['nodes', 'edges'],
  example: ['refs'],
  note: ['text'],
}
/** The field a list in a data file fills, by kind. */
const LIST: Record<string, string> = { table: 'rows', chart: 'rows', timeline: 'events', diagram: 'edges', example: 'refs' }
export const FIELDS = ['answer', ...new Set(Object.values(OWN).flat())]
export const CONTENT = ['title', 'data', 'view', 'kind', ...FIELDS]
const MARKS = ['bar', 'line', 'scatter', 'dots', 'range', 'heatmap']
/** A file larger than this is read a line range or a search at a time, not whole. */
const WHOLE_BYTES = 4 * 1024 * 1024
/** The records an example shows at most, and the characters of a record it keeps around its passages. */
const MAX_REFS = 12
const KEEP_CHARS = 4000
const SEARCH_MS = 20000

const isObj = (v: unknown): v is Record<string, Any> => !!v && typeof v === 'object' && !Array.isArray(v)
const given = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')
const said = (v: unknown, n = 80) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

/** What the card shows, in words: "a table of 12 rows", "a timeline of 6 events". */
export function kindWords(data: Any): string {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0)
  const of = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  switch (data?.kind) {
    case 'table': return `a table of ${of(n(data.rows), 'row', 'rows')}`
    case 'chart': return `a ${data.mark || 'bar'} chart of ${of(n(data.rows), 'row', 'rows')}`
    case 'timeline': return `a timeline of ${of(n(data.events), 'event', 'events')}`
    case 'diagram': return `a diagram of ${of(n(data.nodes) || new Set((data.edges ?? []).flatMap((e: Any) => (Array.isArray(e) ? e.slice(0, 2) : [e?.source, e?.target]))).size, 'node', 'nodes')} and ${of(n(data.edges), 'edge', 'edges')}`
    case 'example': return `an example of ${of(n(data.refs), 'record', 'records')}`
    case 'note': return 'a note'
    default: return 'a card'
  }
}

/** A data file's content: JSON, or JSON Lines. */
function parseFile(text: string): { value?: unknown; bad?: string } {
  try { return { value: JSON.parse(text) } } catch { /* JSON Lines, perhaps */ }
  const out: unknown[] = []
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { return { bad: `the data file is not JSON, and its line ${i + 1} is not a JSON Lines record` } }
  }
  return { value: out }
}

export type ReadyIn = {
  input: Any
  kind: string
  /** the data of the card's last call, when it was of a ready kind */
  last: Any | null
  /** the data file the call names, its real path and its name as the call gave it */
  file: { path: string; name: string } | null
  /** the folders a record's relative path is read from, in order: the shell's working folder (a `cd` moves it), then
   *  the folder the session started in */
  cwd: string
  start: string
  /** the folders a record may be in, each a real path */
  roots: string[]
  /** why the person's permission rules refuse reading a file, or null */
  refused: (path: string) => Promise<string | null>
}

/** The version's data from a call of a ready kind: {data}, or {bad}, what to fix. */
export async function readyData($: Engine, o: ReadyIn): Promise<{ data?: Any; bad?: string }> {
  const { input, kind } = o
  if (Array.isArray(input.edits) && input.edits.length) return { bad: `\`edits\` change a custom card's view; a ${kind} card changes by its fields: give the ones that change (${['answer', ...OWN[kind]!].join(', ')})` }
  let fromFile: Record<string, unknown> = {}
  if (o.file) {
    let text = ''
    try { text = String(await $.fs.read(o.file.path)) } catch (err) { return { bad: `${o.file.name} cannot be read (${said((err as Error)?.message || err, 160)}): a ${kind} reads a data file of at most 4 MB, so write only what it shows` } }
    const parsed = parseFile(text)
    if (parsed.bad) return { bad: parsed.bad }
    fromFile = Array.isArray(parsed.value) ? { [LIST[kind] ?? 'rows']: parsed.value } : isObj(parsed.value) ? parsed.value : {}
    if (!Object.keys(fromFile).length) return { bad: `${o.file.name} holds neither a list nor an object of the ${kind}'s fields` }
  }
  // the last call's fields this kind has too: all of them, or a table's rows that a chart draws now
  const last = o.last ?? {}
  const data: Any = { kind }
  for (const f of ['answer', ...OWN[kind]!]) {
    const v = given(input[f]) ? input[f] : given(fromFile[f]) ? fromFile[f] : last[f]
    if (given(v)) data[f] = v
  }
  if (typeof data.answer !== 'string' && data.answer !== undefined) data.answer = String(data.answer)
  const bad = check(data)
  if (bad) return { bad }
  if (kind === 'example') {
    // a call that gives new refs reads them again; refs kept from the last call are the records read then
    if (!given(input.refs) && !given(fromFile.refs) && Array.isArray(last.refs)) return { data }
    const read = await readRecords($, data.refs, o)
    if (read.bad) return { bad: read.bad }
    data.refs = read.refs
  }
  return { data }
}

/** What a ready kind's data lacks or holds wrongly, in one line; '' when it can be drawn. */
function check(d: Any): string {
  const listOf = (f: string, what: string) => (Array.isArray(d[f]) && d[f].length ? '' : `${/^[aeiou]/.test(d.kind) ? 'an' : 'a'} ${d.kind} needs \`${f}\`, ${what}`)
  switch (d.kind) {
    case 'table': return listOf('rows', 'a list of rows, each an object of its columns') || (d.rows.some((r: unknown) => Array.isArray(r)) ? 'each of a table\'s `rows` is an object of its columns, not a list' : '')
    case 'chart': {
      const no = listOf('rows', 'a list of rows, each an object of the columns its x, y and color name')
      if (no) return no
      if (d.rows.some((r: unknown) => !isObj(r))) return 'each of a chart\'s `rows` is an object of its columns'
      const mark = String(d.mark ?? 'bar')
      if (!MARKS.includes(mark)) return `a chart's \`mark\` is one of ${MARKS.join(', ')}, not ${said(d.mark, 40)}`
      const need: Record<string, string[]> = { bar: ['x'], line: ['x', 'y'], scatter: ['x', 'y'], dots: ['x', 'y'], range: ['y', 'x', 'x2'], heatmap: ['x', 'y'] }
      const lacking = need[mark]!.filter(f => !given(d[f]))
      if (lacking.length) return `a ${mark} chart needs ${lacking.map(f => `\`${f}\``).join(' and ')}: the ${lacking.length > 1 ? 'columns' : 'column'} of its rows to draw there`
      const cols = new Set(d.rows.flatMap((r: Any) => Object.keys(r)))
      const unknown = ['x', 'y', 'x2', 'color'].filter(f => given(d[f]) && !cols.has(String(d[f])))
      if (unknown.length) return `the chart's ${unknown.map(f => `${f}, "${said(d[f], 40)}",`).join(' ')} ${unknown.length > 1 ? 'name columns' : 'names a column'} no row has; the rows' columns are ${[...cols].slice(0, 20).join(', ')}`
      return ''
    }
    case 'timeline': {
      const no = listOf('events', 'a list of events, each {time, label}, with a lane or an end when it has one')
      if (no) return no
      const at = d.events.findIndex((e: Any) => !(Array.isArray(e) ? given(e[0]) : isObj(e) && given(e.time)))
      return at >= 0 ? `event ${at + 1} of the timeline has no \`time\`: each event is {time, label}, or [time, label]` : ''
    }
    case 'diagram': {
      const edges = Array.isArray(d.edges) ? d.edges : []
      if (!edges.length && !(Array.isArray(d.nodes) && d.nodes.length)) return 'a diagram needs `edges`, each [source, target, label] or {source, target, label}, and `nodes` for the labels of their ends'
      const at = edges.findIndex((e: Any) => !(Array.isArray(e) ? given(e[0]) && given(e[1]) : isObj(e) && given(e.source ?? e.from) && given(e.target ?? e.to)))
      return at >= 0 ? `edge ${at + 1} of the diagram has no source or no target: each edge is [source, target, label] or {source, target, label}` : ''
    }
    case 'example': {
      const no = listOf('refs', 'the records it shows: "path#L12", "path#L3-L9", or {ref, quote}')
      if (no) return no
      if (d.refs.length > MAX_REFS) return `an example shows about three records, and at most ${MAX_REFS}; it was given ${d.refs.length}`
      const at = d.refs.findIndex((r: Any) => !(typeof r === 'string' ? r.trim() : isObj(r) && typeof r.ref === 'string' && r.ref.trim()))
      return at >= 0 ? `refs[${at + 1}] is neither a place ("path#L12") nor {ref, quote}` : ''
    }
    case 'note': return typeof d.text === 'string' && d.text.trim() ? '' : 'a note needs `text`, a few sentences'
    default: return `no kind ${said(d.kind, 40)}: the kinds are ${KINDS.join(', ')}, or custom with a \`view\``
  }
}

// ------------------------------------------------------------------------------------------------- an example's records

/** A record's place: its file, and its first and last line (none: the quote says where). */
function placeOf(ref: string): { path: string; line?: number; end?: number } {
  const r = ref.trim().replace(/^\[\[|\]\]$/g, '').trim()
  const m = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(r) ?? /^(.*?):(\d+)(?:-(\d+))?$/.exec(r)
  if (!m) return { path: r }
  const line = Number(m[2])
  const end = m[3] ? Number(m[3]) : undefined
  return { path: m[1]!, line, ...(end && end > line ? { end } : {}) }
}

/** Text in the form a quote is found in it: white space as one space, curly quotes straight. `at[i]` is where the
 *  i-th character of the folded text stands in the text. */
function folded(text: string): { s: string; at: number[] } {
  let s = ''
  const at: number[] = []
  let space = false
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!
    if (/\s/.test(ch)) { if (!space && s) { s += ' '; at.push(i) } space = true; continue }
    space = false
    if (ch === '‘' || ch === '’') ch = "'"
    else if (ch === '“' || ch === '”') ch = '"'
    s += ch
    at.push(i)
  }
  return { s, at }
}

/** Where a quote stands in a text: one span for each of its parts (a quote may leave words out with … or ...), the
 *  parts in order; null when the text does not hold it. */
function spansOf(text: string, quote: string): number[][] | null {
  const t = folded(text)
  const parts = quote.split(/\s*(?:…|\.\.\.)\s*/).map(p => folded(p).s.trim()).filter(Boolean)
  if (!parts.length) return null
  const out: number[][] = []
  let from = 0
  for (const p of parts) {
    const i = t.s.indexOf(p, from)
    if (i < 0) return null
    out.push([t.at[i]!, t.at[i + p.length - 1]! + 1])
    from = i + p.length
  }
  return out
}

/** A JSON record's strings, each with the path of its field ("content", "messages[2].text"). */
function stringsOf(v: unknown, path = '', out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  if (typeof v === 'string') out.push({ path, text: v })
  else if (Array.isArray(v)) v.forEach((x, i) => stringsOf(x, `${path}[${i}]`, out))
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) stringsOf(x, path ? `${path}.${k}` : k, out)
  return out
}

/** A line of a JSON record's other short fields, which say whose and when it is: names and times first. */
function contextOf(rec: Record<string, unknown>, skip: string): string {
  // an id or a hash (a run of 16 or more letters and digits, mixed, with no space) says nothing to the analyst
  const opaque = (v: string) => /^[0-9a-f-]{20,}$/i.test(v) || (v.length >= 16 && !/\s/.test(v) && /\d/.test(v) && /[a-z]/i.test(v) && !/^\d{4}-\d{2}-\d{2}/.test(v))
  const short = Object.entries(rec).filter(([k, v]) => k !== skip && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.trim() && v.length <= 40 && !opaque(v))))
  const rank = (k: string) => (/time|date|_at$|^at$|^ts$/i.test(k) ? 0 : /name|role|speaker|author|user|agent|sender|from|model|type|kind|status/i.test(k) ? 1 : 2)
  return short.sort((a, b) => rank(a[0]) - rank(b[0])).slice(0, 4).map(([k, v]) => `${k} ${String(v).replace(/\s+/g, ' ')}`).join(' · ')
}

/** A text cut to KEEP_CHARS around its spans, the spans moved with it. */
function kept(text: string, spans: number[][]): { text: string; spans: number[][] } {
  if (text.length <= KEEP_CHARS) return { text, spans }
  const a = spans.length ? Math.max(0, spans[0]![0]! - KEEP_CHARS / 4) : 0
  const b = Math.min(text.length, a + KEEP_CHARS)
  return { text: text.slice(a, b), spans: spans.map(s => [s[0]! - a, s[1]! - a]).filter(s => s[0]! >= 0 && s[1]! <= b - a) }
}

/** Lines `from` to `to` (from 1) of a file: read whole when small (`count`, its number of lines), else with sed; none
 *  when the file is shorter. */
async function linesOf($: Engine, path: string, size: number, from: number, to: number): Promise<{ lines: string[]; count?: number }> {
  if (size <= WHOLE_BYTES) {
    const all = String(await $.fs.read(path)).split('\n')
    if (all.length && all[all.length - 1] === '') all.pop()
    return from <= all.length ? { lines: all.slice(from - 1, to), count: all.length } : { lines: [], count: all.length }
  }
  const r = await $.process.run(['sed', '-n', `${from},${to}p;${to}q`, '--', path], { timeoutMs: SEARCH_MS })
  if (r.exitCode !== 0) throw new Error(String(r.stderr).trim().slice(0, 160) || 'sed failed')
  const lines = String(r.stdout).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return { lines }
}

/** The lines of a large file that may hold a quote: grep for its longest plain run of words, up to 50 lines. */
async function candidates($: Engine, path: string, quote: string): Promise<number[] | null> {
  const runs = folded(quote).s.split(/[^A-Za-z0-9 ,.;:!?()$%#@+=/_-]+/).map(x => x.trim()).sort((a, b) => b.length - a.length)
  const needle = runs[0] ?? ''
  if (needle.length < 8) return null
  const r = await $.process.run(['grep', '-n', '-F', '-m', '50', '--', needle, path], { timeoutMs: SEARCH_MS }).catch(() => null)
  if (!r || (r.exitCode !== 0 && r.exitCode !== 1)) return null
  return String(r.stdout).split('\n').map(l => Number(/^(\d+):/.exec(l)?.[1])).filter(n => n > 0)
}

type Passage = { ref: string; path: string; line: number; end?: number; text: string; spans: number[][]; field?: string; context?: string }

/** One record's passage: where `quote` stands in the lines `from` to `to` (a JSON record's field, or the lines' text),
 *  or the record whole when no quote is given; null when the lines do not hold the quote. */
function passageIn(ref: string, path: string, from: number, lines: string[], quote: string): Passage | null {
  // a range that a quote names: the line that holds it, as a record of its own (a JSON line by its field), unless the
  // quote runs across lines
  if (quote && lines.length > 1) {
    for (const [i, l] of lines.entries()) {
      const one = passageIn(ref, path, from + i, [l], quote)
      if (one) return one
    }
  }
  const end = from + lines.length - 1
  const one = lines.length === 1 ? lines[0]! : null
  let rec: unknown = null
  if (one && /^\s*[[{]/.test(one)) { try { rec = JSON.parse(one) } catch { rec = null } }
  if (rec !== null && typeof rec === 'object') {
    const strings = stringsOf(rec)
    if (!quote) {
      // no passage: the record's longest text, under its field's name
      const longest = strings.sort((a, b) => b.text.length - a.text.length)[0]
      if (!longest) return { ref, path, line: from, text: one!, spans: [] }
      const k = kept(longest.text, [])
      return { ref, path, line: from, field: longest.path, text: k.text, spans: [], context: isObj(rec) ? contextOf(rec, longest.path) : '' }
    }
    for (const s of strings) {
      const spans = spansOf(s.text, quote)
      if (!spans) continue
      const k = kept(s.text, spans)
      return { ref, path, line: from, field: s.path, text: k.text, spans: k.spans, context: isObj(rec) ? contextOf(rec, s.path.split(/[.[]/)[0]!) : '' }
    }
  }
  const text = lines.join('\n')
  if (!quote) return { ref, path, line: from, ...(end > from ? { end } : {}), ...kept(text, []) }
  const spans = spansOf(text, quote)
  if (!spans) return null
  return { ref, path, line: from, ...(end > from ? { end } : {}), ...kept(text, spans) }
}

/** The records an example cites, read from their files: each its passage, the passages of one record in that record. */
async function readRecords($: Engine, refs: Any[], o: ReadyIn): Promise<{ refs?: Passage[]; bad?: string }> {
  const out: Passage[] = []
  for (const [k, item] of refs.entries()) {
    const name = `refs[${k + 1}]`
    const ref = String(typeof item === 'string' ? item : item.ref).trim()
    const quote = typeof item === 'string' ? '' : String(item.quote ?? '').trim()
    const place = placeOf(ref)
    let st: { kind: string; size: number; realPath?: string } | null = null
    for (const dir of place.path.startsWith('/') ? [''] : [o.cwd, o.start]) {
      st = await $.fs.stat(dir ? `${dir}/${place.path}` : place.path, { resolve: true }).catch(() => null)
      if (st?.kind === 'file') break
    }
    if (!st || st.kind !== 'file' || !st.realPath) return { bad: `${name}: there is no file at ${place.path}` }
    const real = st.realPath
    if (!o.roots.some(r => real === r || real.startsWith(`${r}/`))) return { bad: `${name}: ${place.path} is outside this folder and the temp folder ($TMPDIR)` }
    const no = await o.refused(real)
    if (no) return { bad: `${name}: ${no}` }
    let found: Passage | null = null
    try {
      if (place.line) {
        const to = Math.min(place.end ?? place.line, place.line + 199)
        const got = await linesOf($, real, st.size, place.line, to)
        if (!got.lines.length) return { bad: `${name}: ${place.path} has ${got.count === undefined ? `fewer than ${place.line} lines` : `${got.count} lines, not ${place.line}`}` }
        found = passageIn(ref, place.path, place.line, got.lines, quote)
        if (!found) return { bad: `${name}: the quote "${said(quote)}" is not in ${place.path} at line${got.lines.length > 1 ? `s ${place.line}-${place.line + got.lines.length - 1}` : ` ${place.line}`}. Quote the record's words exactly, or cite the record without a quote` }
      } else if (!quote) {
        const got = await linesOf($, real, st.size, 1, 8)
        found = got.lines.length ? passageIn(ref, place.path, 1, got.lines, '') : null
        if (!found) return { bad: `${name}: ${place.path} is empty` }
      } else if (st.size <= WHOLE_BYTES) {
        const text = String(await $.fs.read(real))
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && !found; i++) found = passageIn(ref, place.path, i + 1, [lines[i]!], quote)
        // a quote across lines: the lines it stands on
        const spans = found ? null : spansOf(text, quote)
        if (spans) {
          const first = text.slice(0, spans[0]![0]).split('\n').length
          const last = text.slice(0, spans[spans.length - 1]![1]).split('\n').length
          found = passageIn(ref, place.path, first, lines.slice(first - 1, Math.min(last, first + 199)), quote)
        }
        if (!found) return { bad: `${name}: the quote "${said(quote)}" is not in ${place.path}. Quote the record's words exactly, or cite the record without a quote` }
      } else {
        const lines = await candidates($, real, quote)
        if (lines === null) return { bad: `${name}: ${place.path} is too large to search for the quote; give the record's line as well, ${place.path}#L<line>` }
        for (const n of lines) {
          const got = await linesOf($, real, st.size, n, n)
          if (got.lines.length) found = passageIn(ref, place.path, n, got.lines, quote)
          if (found) break
        }
        if (!found) return { bad: `${name}: the quote "${said(quote)}" is not in ${place.path}. Quote the record's words exactly, or give the record's line, ${place.path}#L<line>` }
      }
    } catch (err) {
      return { bad: `${name}: ${place.path} could not be read (${said((err as Error)?.message || err, 160)})` }
    }
    // the passages of one record show in that record
    const same = out.find(p => p.path === found!.path && p.line === found!.line && p.end === found!.end && p.field === found!.field && p.text === found!.text)
    if (same) same.spans = [...same.spans, ...found.spans].sort((a, b) => a[0]! - b[0]!)
    else out.push(found)
  }
  return { refs: out }
}
