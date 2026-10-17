// A file in the panel (SPEC.md, section 7, "The file browser", a file), opened only to verify a place: a citation's,
// a label's record, a card's source. The terminal has no file browser (Matt, 10-16: people view files their own way;
// Coverage lists the files). A file shows in the modes that fit it (Table for records, CSV rows and a database's rows,
// Transcript, Text, JSON, Raw), as the browser offers them; the labels that are on mark the records they labeled in
// their values' hues.
//
//   file    a file's records in a mode, the chosen one lit, its place a link and a blue `?` under the header; a
//           database's tables, then a table's rows
//
// It draws through the panel's frame (panel.tsx drawsView) and reads through term.ts (loadsView): `thimble state
// files <path>`, `turns`, `marks`, `tables`, `rows` and `labels`, the routes the browser's Files reads.
import type { RenderElement } from 'claude-code'

import type { TermFilesUi, TermPanel } from './types'
import { LINK, MARGIN_W, headerEls, lineEl, linkSeg, marginKey, pointed, ruleEl, spread, subLine } from './chrome'
import type { Ctx } from './ctx'
import { amount, cut, demojibake, lineWidth, placeWords, turnTimes, valueColour, width, wrapRows } from './draw'
import type { Line, Seg } from './draw'
import { csvCells, delimiterOf, fileType, isDatabase, jsonOf, labelCovers, onLabels, readsAsText, recordMarks, tableScore, turnsRead, wholeJson } from './files'
import type { FileEntry, FileMode, GrepFile, OnLabel, TreeRow } from './files'
import { labelHue } from './home'
import { clip, cutLine, middleCut, noControls } from './lib'
import { linesEl, setListKeys } from './lines'
import type { LineHit } from './lines'
import { labelsOf } from './model'
import { COLORS } from './paint'
import { RELAY, bottomRows, drawsView, fieldHintsRow, hiddenKeys, hintHeight, hintsRow, none, openAsk, openCite, openFile, openLabel, panelHasKeys, paneRows, relayField, windowList } from './panel'
import type { PaneEvent } from './panel'
import { loadsView, navBack, openPanel, readFilePage, readSurface, rt, surfaceValue } from './term'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const num = (n: number) => Math.round(n).toLocaleString('en-US')
const plural = (n: number, w: string, many = `${w}s`) => `${num(n)} ${n === 1 ? w : many}`
const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

// ------------------------------------------------------------------------------------------------ state

// the page of a file the file view read last, which a choice moved on it does not read again
let lastPage = ''
// the file view's find (the browser's find bar): the file it is in, its words, whether its field takes typing, the
// generation of its reads
let inFile = { path: '', text: '', typing: false, gen: 0 }
// the labels area's stamp (data.ts signature) each label read was made at: read again once the labels changed
const readAt = new Map<string, string>()

/** The labels list, read again once the labels changed on disk since it was read (show_label turned one on). */
async function readLabels(cx: Ctx): Promise<void> {
  const stamp = rt.sig?.labels ?? ''
  if ((await cx.surface('labels')) && readAt.get('labels') === stamp) return
  await readSurface(cx, 'labels', 'labels')
  readAt.set('labels', stamp)
}

/** The labels over files that are on. */
async function labelsOn(cx: Ctx): Promise<OnLabel[]> {
  const got = await surfaceValue(cx, 'labels')
  return got?.ok ? onLabels(labelsOf(got.value) as unknown as Obj[]) : []
}

const marksKey = (path: string, a: number, b: number) => `marks:${path}:${a}-${b}`

/** The rows of the labels that are on over lines a..b of a file, while one of them covers it. */
async function readMarks(cx: Ctx, path: string, a: number, b: number): Promise<void> {
  if (!(await labelsOn(cx)).some(l => labelCovers(l, path))) return
  const key = marksKey(path, a, b)
  const stamp = rt.sig?.labels ?? ''
  if ((await cx.surface(key)) && readAt.get(key) === stamp) return
  await readSurface(cx, key, 'marks', [path, '--lines', `${a}-${b}`])
  readAt.set(key, stamp)
}

// ------------------------------------------------------------------------------------------------ a page's records

/** The text of a file page's records, one per line as written. */
function pageLines(page: Obj): { n: number; text: string }[] {
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const first = typeof page.start === 'number' ? page.start : 1
  return records.map((r, i) => ({
    n: typeof r.line === 'number' ? r.line : first + i,
    text: noControls(demojibake((Array.isArray(r.blocks) ? (r.blocks as Obj[]).map(b => str(b.text)).join(' ') : str(r.text ?? r.raw ?? (isObj(r.record) ? JSON.stringify(r.record) : r.record))))).replace(/\s+/g, ' ').slice(0, 2000),
  }))
}

/** A value as JSON in the form a JSON lines file is most often written in (Python's json.dumps: `, ` and `: ` between
 *  parts), so a line of the file reads as written. */
function jsonLine(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonLine).join(', ')}]`
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${jsonLine(x)}`).join(', ')}}`
  return JSON.stringify(v) ?? 'null'
}

/** A file page's lines as the file holds them (the Raw tab): a JSON record as its JSON line, a line of text as written,
 *  never the words a transcript's turn shows. */
function rawLines(page: Obj): { n: number; text: string }[] {
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const first = typeof page.start === 'number' ? page.start : 1
  return records.map((r, i) => {
    const rec = r.record
    // a page that gives no record (an older backend's) as its blocks' words
    const words = Array.isArray(r.blocks) ? (r.blocks as Obj[]).map(b => str(b.text)).join(' ') : str(r.text ?? r.raw)
    const text = isObj(rec) && typeof rec._raw === 'string' ? rec._raw : isObj(rec) && Object.keys(rec).length === 1 && typeof rec.text === 'string' ? rec.text : rec !== undefined ? jsonLine(rec) : words
    return { n: typeof r.line === 'number' ? r.line : first + i, text: noControls(demojibake(text.replace(/\t/g, '  '))).slice(0, 4000) }
  })
}

/** turns of a whole-file JSON transcript one read gives (backend local.py TURNS_PAGE) */
const TURNS_PAGE = 200

// the keys a transcript's record names its speaker, its words and its time by, in the order tried, where thimble's sniff
// names none
const SPEAKER_KEYS = ['speaker', 'role', 'author', 'agent', 'sender', 'from', 'user', 'name']
const TEXT_KEYS = ['text', 'content', 'message', 'body', 'msg', 'comment']
const TIME_KEYS = ['time', 'timestamp', 'ts', 'created_at', 'date', 'at']

/** A turn of a transcript: its line, who speaks, the words, when; a tool call folded to one line (`tool`); a whole-file
 *  JSON transcript's turn its index (`i`), the title of the conversation it is in (`group`), and the first line of the
 *  record that is its one turn (`rec`), where a citation of that record by its pointer opens. */
type Turn = { n: number; who: string; text: string; time: string; tool?: boolean; i?: number; group?: string; rec?: number }

/** A dotted key's value in a record (`data.speakerId`). */
function dotted(o: Obj, key: string): unknown {
  let v: unknown = o
  for (const k of key.split('.')) v = isObj(v) ? v[k] : undefined
  return v
}

/** Words held as a string, or as a list of blocks with text. */
function wordsOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(b => (typeof b === 'string' ? b : isObj(b) ? str(b.text) : '')).filter(Boolean).join(' ')
  return ''
}

/** A page's records as a transcript's turns: by the keys thimble's sniff named (`page.transcript`), a text log's turns
 *  (each record's `meta.turn`), else when most records name a speaker and hold words; else null. */
function turnsOf(page: Obj): Turn[] | null {
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const hint = isObj(page.transcript) ? page.transcript : null
  const out: Turn[] = []
  const lineOf = (r: Obj, i: number) => (typeof r.line === 'number' ? r.line : (typeof page.start === 'number' ? page.start : 1) + i)
  if (hint?.format === 'text') {
    records.forEach((r, i) => {
      const text = isObj(r.record) ? str(r.record.text) : str(r.text)
      const turn = isObj(r.meta) && isObj(r.meta.turn) ? r.meta.turn : null
      if (turn) out.push({ n: lineOf(r, i), who: demojibake(str(turn.speaker)), text: demojibake(text.slice(typeof turn.at === 'number' ? turn.at : 0).trim()), time: str(turn.time) })
      else if (out.length && text.trim()) out.at(-1)!.text += ` ${demojibake(text.trim())}`
    })
    return out.length ? out : null
  }
  const keys = hint && isObj(hint.keys) ? hint.keys : null
  for (const [i, r] of records.entries()) {
    const o = isObj(r.record) ? r.record : null
    if (!o) continue
    const who = keys ? str(keys.speaker).split('|').map(k => dotted(o, k)).find(v => typeof v === 'string' && v.trim()) : SPEAKER_KEYS.map(k => o[k]).find(v => typeof v === 'string' && v.trim())
    const text = keys ? wordsOf(dotted(o, str(keys.text))) : TEXT_KEYS.map(k => o[k]).find(v => typeof v === 'string' && v.trim())
    const time = keys && keys.time ? dotted(o, str(keys.time)) : TIME_KEYS.map(k => o[k]).find(v => typeof v === 'string' || typeof v === 'number')
    if (typeof who !== 'string' || typeof text !== 'string' || !text.trim()) {
      // a tool record of an agent's transcript: one dim line
      if (hint?.tools && (o.tool_use_id || o.tool || o.name || o.type === 'tool_use' || o.type === 'tool_result')) out.push({ n: lineOf(r, i), who: '', text: str(o.name ?? o.tool ?? o.type ?? 'tool call'), time: '', tool: true })
      continue
    }
    out.push({ n: lineOf(r, i), who: noControls(demojibake(who.trim())), text: noControls(demojibake(text)).replace(/\s+/g, ' ').trim(), time: time === undefined ? '' : String(time) })
  }
  const spoken = out.filter(t => !t.tool).length
  if (hint) return spoken ? out : null
  return records.length && spoken >= Math.ceil(records.length * 0.6) ? out : null
}

/** A page of a whole-file JSON transcript's turns (`thimble state turns`, the parse of the whole file) as the view's
 *  turns: each with its line and index, its conversation's title where the file holds several or titles one, a turn
 *  with no words left out as the browser leaves it out; null when the parse found none (`none`), so the view opens its
 *  other tab. */
function turnsOfPage(tp: Obj): Turn[] | null {
  const groups = isObj(tp.groups) ? tp.groups : {}
  const titleOf = (g: unknown) => (typeof g === 'number' && isObj(groups[String(g)]) ? str((groups[String(g)] as Obj).title) : '')
  const list = (Array.isArray(tp.turns) ? tp.turns : []).filter(isObj)
  const titled = (typeof tp.n_groups === 'number' && tp.n_groups > 1) || list.some(t => titleOf(t.group))
  const out: Turn[] = []
  for (const t of list) {
    const text = noControls(demojibake(str(t.text))).replace(/\s+/g, ' ').trim()
    if (!text) continue
    const g = typeof t.group === 'number' ? t.group : null
    out.push({ n: typeof t.line === 'number' ? t.line : 1, i: typeof t.i === 'number' ? t.i : out.length, ...(typeof t.rec_line === 'number' ? { rec: t.rec_line } : {}), who: noControls(demojibake(str(t.speaker) || str(t.role))), text, time: str(t.time), ...(titled && g !== null ? { group: noControls(titleOf(g)) || `Conversation ${g + 1}` } : {}) })
  }
  return out.length ? out : null
}

/** The records of a page that are objects (JSON lines, a JSON list's items), each with its line. */
function recordsOf(page: Obj): { n: number; o: Obj }[] {
  const records = (Array.isArray(page.records) ? page.records : []) as Obj[]
  const first = typeof page.start === 'number' ? page.start : 1
  const out = records.flatMap((r, i) => (isObj(r.record) && !('text' in r.record && Object.keys(r.record).length === 1) && !('_raw' in r.record) ? [{ n: typeof r.line === 'number' ? r.line : first + i, o: r.record }] : []))
  return out.length * 2 >= records.length ? out : []
}

/** A record's value as a table's cell: words as written, a number, anything else as JSON. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return noControls(demojibake(v.replace(/\s+/g, ' ')))
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v === 'number' ? amount(v) : String(v)
  return noControls(JSON.stringify(v))
}

/** A table of a page: its column names and its rows, each with its line (a record's, a CSV row's); a database's
 *  primary key. */
type Table = { heads: string[]; rows: { n: number; cells: unknown[] }[]; pk?: string }

/** Whether a column's numbers name things (an id, a number, a line, a year), which read as written, with no thousands
 *  separators (SPEC.md, section 5, "Words that recur"). */
const namesThings = (head: string, pk = '') => head === pk || /(?:^|_)(?:id|number|no|num|line|year|pk|rowid)$/i.test(head)

/** The table a page's records make: the records' keys as columns (the first 8 any of them hold); a delimited file's
 *  rows under the names its first line gives (`header`, the first line of the file, from its first page). */
function tableOf(path: string, page: Obj, header: string | null): Table | null {
  const sep = delimiterOf(path)
  if (sep) {
    const ls = rawLines(page)
    const head = header ?? (ls[0]?.n === 1 ? ls[0].text : null)
    if (head === null) return null
    const heads = csvCells(head, sep).slice(0, 12)
    return { heads, rows: ls.filter(l => l.n !== 1).map(l => ({ n: l.n, cells: csvCells(l.text, sep).slice(0, heads.length).map(c => (/^-?\d+(?:\.\d+)?$/.test(c.trim()) ? Number(c) : c)) })) }
  }
  const recs = recordsOf(page)
  if (!recs.length) return null
  const heads = [...new Set(recs.flatMap(r => Object.keys(r.o)))].slice(0, 8)
  return { heads, rows: recs.map(r => ({ n: r.n, cells: heads.map(h => r.o[h]) })) }
}

/** The JSON a page's records hold, by line: a JSON record, or a line of a `.json` file that holds an object or a list. */
function jsonRecords(page: Obj): Map<number, unknown> {
  const out = new Map<number, unknown>()
  for (const r of recordsOf(page)) out.set(r.n, r.o)
  if (out.size) return out
  for (const l of rawLines(page)) {
    const v = jsonOf(l.text)
    if (v !== undefined) out.set(l.n, v)
  }
  return out.size * 2 >= Math.max(1, rawLines(page).length) ? out : new Map()
}

/** The modes a file's page reads in, as the browser's Files offers them, and the one it opens in, the best by the
 *  browser's scores (frontend views/registry.ts): a transcript the sniff is sure of (0.95), a text file (Markdown, a
 *  .txt, a prompt: 0.9), uniform records or a CSV file as a table (0.85, 0.7), else its lines (Raw, 0.1). JSON, one
 *  record at a time, is offered for JSON records and opens first never. */
function modesOf(path: string, page: Obj, turns: Turn[] | null, table: Table | null): { modes: FileMode[]; first: FileMode } {
  const hint = isObj(page.transcript) ? page.transcript : null
  const json = jsonRecords(page)
  const recs = recordsOf(page)
  const scores: [FileMode, number][] = []
  if (table) scores.push(['table', delimiterOf(path) ? 0.85 : tableScore(recs.map(r => r.o))])
  if (turns?.length) scores.push(['transcript', typeof hint?.score === 'number' ? hint.score : 0.5])
  if (readsAsText(path, str(page.kind)) && !json.size) scores.push(['text', 0.9])
  if (json.size) scores.push(['json', 0])
  scores.push(['raw', 0.1])
  const first = scores.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  return { modes: scores.map(s => s[0]), first }
}

/** What a file opens in, by its first page, as its view opens it; a database by its tables; a binary file not at all. */
function opensAs(path: string, page: Obj | undefined): string {
  if (isDatabase(path)) return 'tables'
  if (!page) return ''
  if (page.binary) return 'raw bytes: not shown'
  const turns = wholeJson(page) ? null : turnsOf(page)
  const m = modesOf(path, page, wholeJson(page) ? [{ n: 1, who: '', text: '', time: '' }] : turns, tableOf(path, page, null)).first
  return m === 'raw' ? 'lines' : m
}

const TAB_NAME: Record<FileMode, string> = { table: 'Table', transcript: 'Transcript', text: 'Text', json: 'JSON', raw: 'Raw' }

// ------------------------------------------------------------------------------------------------ drawing a mode

/** A mode's rows: its lines, the hits a click runs, and the unit each row of it chooses (a line, or a whole-file JSON
 *  transcript's turn by its index), the first row of each in `at`. */
type Drawn = { lines: Line[]; hits: LineHit[]; units: number[]; at: Map<number, number>; fixed: number }

/** The gutter of the labels that are on, before a record's row: a `●` per label in its value's hue, a space where it
 *  gave the record none, then a gutter; nothing while no label marks the file. */
function gutterOf(on: readonly OnLabel[], marks: Map<number, Map<string, string>>): (n: number | null) => Seg[] {
  if (!on.length) return () => []
  return n => {
    const vs = n === null ? undefined : marks.get(n)
    return [...on.flatMap((l, i): Seg[] => {
      const v = vs?.get(l.id)
      return [...(i ? [{ s: ' ' }] : []), v ? { s: '●', fg: valueColour(l.values, v, l.colors) ?? COLORS.text } : { s: ' ' }]
    }), { s: '  ' }]
  }
}

type DrawOpts = { cols: number; chosen: number; gutter: (n: number | null) => Seg[]; pick: (n: number) => () => Promise<void> | void; sort?: string; onSort?: (next: string) => () => Promise<void> | void; labeled: boolean; max?: number; presorted?: boolean }

/** A transcript: per turn its clock dim in a column at A0 (the day on a dim row where it changes), then `●` in the
 *  speaker's hue (the text color while a label is the region's color field) and the speaker bold; its words 2 cells
 *  in under the name, up to three rows; a tool call one dim line. */
function drawTranscript(turns: readonly Turn[], o: DrawOpts & { byIndex: boolean; isChosen: (t: Turn) => boolean; compact?: boolean }): Drawn {
  const d: Drawn = { lines: [], hits: [], units: [], at: new Map(), fixed: 0 }
  const speakers = [...new Set(turns.filter(t => !t.tool).map(t => t.who))]
  const times = turnTimes(turns.map(t => (t.tool ? '' : t.time)))
  const tw = Math.min(22, Math.max(0, ...times.map(x => width(x.clock))))
  const gw = lineWidth(o.gutter(null))
  for (const [ti, t] of turns.entries()) {
    if (o.max !== undefined && d.lines.length >= o.max) break
    const when = times[ti]!
    // the conversation's title and the day on rows of their own, on the clock's column
    if (t.group && t.group !== turns[ti - 1]?.group) d.lines.push(pointed([{ s: ' '.repeat(gw) }, dim(cut(t.group, o.cols - gw))], false))
    if (when.day) d.lines.push(pointed([{ s: ' '.repeat(gw) }, dim(when.day)], false))
    const y = d.lines.length
    const unit = o.byIndex ? t.i! : t.n
    d.at.set(unit, y)
    d.units.push(unit)
    if (t.tool) {
      d.lines.push(pointed([...o.gutter(t.n), ...(tw ? [{ s: ' '.repeat(tw + 2) }] : []), dim(`  ⎿ ${cut(t.text, Math.max(10, o.cols - tw - gw - 8))}`)], false))
      d.hits.push({ y, x0: MARGIN_W, x1: o.cols + MARGIN_W, row: true, run: o.pick(unit) })
      continue
    }
    const hue = o.labeled ? COLORS.text : COLORS.series[speakers.indexOf(t.who) % COLORS.series.length]!
    const name: Line = [...o.gutter(t.n), ...(tw ? [dim(`${cut(when.clock, tw).padEnd(tw)}  `)] : []), { s: '●', fg: hue }, { s: ' ' }, { s: t.who, b: true }]
    // a preview's turn on one row: its words after the name, cut at a word
    if (o.compact) {
      d.lines.push(pointed([...name, { s: '  ' }, { s: cut(t.text, Math.max(4, o.cols - lineWidth(name) - 2)) }], false))
      continue
    }
    d.lines.push(pointed(name, o.isChosen(t), true))
    const lead = gw + (tw ? tw + 2 : 0) + 2
    for (const r of wrapRows(t.text, Math.max(10, o.cols - lead), 3)) d.lines.push(pointed([{ s: ' '.repeat(lead) }, { s: r }], false))
    for (let k = y; k < d.lines.length; k++) d.hits.push({ y: k, x0: MARGIN_W, x1: o.cols + MARGIN_W, row: true, run: o.pick(unit) })
  }
  return d
}

/** A table: the column names dim on the row above (`▼` or `▲` after the sorted one, a click on one sorts by it), each
 *  row's cells 2 cells apart, numbers right-aligned with separators, the chosen row in the accent across. */
function drawTable(t: Table, o: DrawOpts): Drawn {
  const d: Drawn = { lines: [], hits: [], units: [], at: new Map(), fixed: 1 }
  const [sortKey, sortDir] = (o.sort ?? '').split(':')
  const rows = t.rows.slice()
  if (sortKey && t.heads.includes(sortKey) && !o.presorted) {
    const k = t.heads.indexOf(sortKey)
    rows.sort((a, b) => {
      const x = a.cells[k]
      const y = b.cells[k]
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : cellText(x).localeCompare(cellText(y), undefined, { numeric: true })
      return sortDir === 'desc' ? -c : c
    })
  }
  const gutter = o.gutter(null)
  const gw = lineWidth(gutter)
  const numeric = t.heads.map((_h, k) => rows.some(r => typeof r.cells[k] === 'number') && rows.every(r => typeof r.cells[k] === 'number' || r.cells[k] === null || r.cells[k] === undefined || r.cells[k] === ''))
  const named = t.heads.map(h => namesThings(h, t.pk))
  const text = (v: unknown, k: number) => (named[k] && typeof v === 'number' ? String(v) : cellText(v))
  const natural = t.heads.map((h, k) => Math.max(width(h) + 2, ...rows.map(r => width(text(r.cells[k], k)))))
  const room = o.cols - gw - 2 * (t.heads.length - 1)
  const ws = natural.slice()
  while (ws.reduce((a, b) => a + b, 0) > room && Math.max(...ws) > 6) ws[ws.indexOf(Math.max(...ws))]!--
  const cellSeg = (v: string, k: number): string => (numeric[k] ? cut(v, ws[k]!).padStart(ws[k]!) : cut(v, ws[k]!).padEnd(ws[k]!))
  const headLine: Line = [{ s: ' '.repeat(gw) }]
  let x = gw
  t.heads.forEach((h, k) => {
    if (k) {
      headLine.push({ s: '  ' })
      x += 2
    }
    const mark = sortKey === h ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''
    headLine.push(dim(cellSeg(`${h}${mark}`, k)))
    if (o.onSort) d.hits.push({ y: 0, x0: MARGIN_W + x, x1: MARGIN_W + x + ws[k]!, row: false, run: o.onSort(sortKey === h && sortDir !== 'desc' ? `${h}:desc` : `${h}:asc`) })
    x += ws[k]!
  })
  d.lines.push(pointed(headLine, false))
  for (const r of rows) {
    if (o.max !== undefined && d.lines.length >= o.max) break
    d.at.set(r.n, d.lines.length)
    d.units.push(r.n)
    d.hits.push({ y: d.lines.length, x0: MARGIN_W, x1: o.cols + MARGIN_W, row: true, run: o.pick(r.n) })
    d.lines.push(pointed([...o.gutter(r.n), ...r.cells.flatMap((v, k): Seg[] => [...(k ? [{ s: '  ' }] : []), { s: cellSeg(text(v, k), k) }])], r.n === o.chosen, true))
  }
  return d
}

/** A file's lines: each line's number right-aligned in a dim column, then the line, the chosen one on the selection
 *  background; Raw cuts each at the cell edge as the file holds it, a Markdown file's headings bold and its blank lines
 *  left out; Text wraps each over the rows it needs, a Markdown heading bold without its marks. */
/** A row's words with each place they hold `find` (in any case) on the selection background. */
function withFound(r: string, find: string, base: Partial<Seg> = {}): Seg[] {
  if (!find) return [{ s: r || ' ', ...base }]
  const out: Seg[] = []
  const low = r.toLowerCase()
  const f = find.toLowerCase()
  let at = 0
  for (let i = low.indexOf(f); i >= 0 && f; i = low.indexOf(f, i + f.length)) {
    if (i > at) out.push({ s: r.slice(at, i), ...base })
    out.push({ s: r.slice(i, i + f.length), ...base, bg: COLORS.selected })
    at = i + f.length
  }
  if (at < r.length || !out.length) out.push({ s: r.slice(at) || ' ', ...base })
  return out
}

function drawLines(ls: readonly { n: number; text: string }[], o: DrawOpts & { wrap: boolean; md: boolean; find?: string }): Drawn {
  const d: Drawn = { lines: [], hits: [], units: [], at: new Map(), fixed: 0 }
  const gw = Math.max(1, ...ls.map(l => String(l.n).length))
  const gut = lineWidth(o.gutter(null))
  const room = Math.max(10, o.cols - gw - 2 - gut)
  for (const l of ls) {
    if (o.max !== undefined && d.lines.length >= o.max) break
    if (o.md && !l.text.trim()) continue
    const head = o.md && /^#{1,6}\s/.test(l.text)
    const text = o.wrap && head ? l.text.replace(/^#{1,6}\s+/, '') : l.text
    const rows = o.wrap ? wrapRows(text, room, 40) : [cutLine(text, room)]
    d.at.set(l.n, d.lines.length)
    d.units.push(l.n)
    const lit = l.n === o.chosen
    rows.forEach((r, k) => {
      d.hits.push({ y: d.lines.length, x0: MARGIN_W, x1: o.cols + MARGIN_W, row: true, run: o.pick(l.n) })
      const numCol = k ? ' '.repeat(gw + 2) : `${String(l.n).padStart(gw)}  `
      // the chosen line on the selection background; elsewhere the words the file's find holds
      const body: Seg[] = lit ? [{ s: r || ' ', bg: COLORS.selected }] : withFound(r, o.find ?? '', head ? { b: true } : {})
      d.lines.push(pointed([...(k ? [{ s: ' '.repeat(gut) }] : o.gutter(l.n)), lit && !k ? { s: numCol } : dim(numCol), ...body], false))
    })
  }
  return d
}

// ------------------------------------------------------------------------------------------------ a file

const rowsKey = (p: TermPanel) => `rows:${p.path}:${p.table}:${p.start ?? 1}:${p.sort ?? ''}`
const rowsArgs = (p: TermPanel) => [p.path ?? '', '--table', p.table ?? '', ...((p.start ?? 1) > 1 ? ['--start', String(p.start)] : []), ...(p.sort ? ['--order', p.sort.replace(':', ' ')] : [])]

/** The file view's find: its words typed, and the lines of the whole file that hold them read once typing pauses; the
 *  first of them at or after the chosen line is chosen. */
async function findInFile(cx: Ctx, p: TermPanel, text: string): Promise<void> {
  const gen = ++inFile.gen
  inFile = { ...inFile, path: p.path ?? '', text }
  await cx.bumpPanel()
  const words = text.trim()
  if (!words) return
  cx.later(250, () => {
    if (gen !== inFile.gen) return
    void (async () => {
      const key = `findin:${p.path}:${words}`
      if (!(await cx.surface(key))) await readSurface(cx, key, 'findin', [p.path ?? '', words])
      if (gen !== inFile.gen) return
      const got = await surfaceValue<Obj>(cx, key)
      const lines = got?.ok && Array.isArray(got.value.lines) ? (got.value.lines as number[]) : []
      const cur = (await cx.panel()) ?? p
      const next = lines.find(n => n >= (cur.line ?? 0)) ?? lines[0]
      if (next !== undefined && next !== cur.line) await matchAt(cx, cur, next)
      else await cx.bumpPanel()
    })()
  })
}

/** A file's line chosen, its page read when it is not on the page shown. */
async function matchAt(cx: Ctx, p: TermPanel, line: number): Promise<void> {
  const page = await surfaceValue<Obj>(cx, `file:${p.path}:${p.start ?? 1}`)
  const ls = page?.ok ? pageLines(page.value) : []
  const onPage = ls.length && line >= ls[0]!.n && line <= ls.at(-1)!.n
  await openPanel(cx, { ...p, line, turn: undefined, ...(onPage ? {} : { start: Math.max(1, line - 5) }) }, { replace: true })
}

/** A file (SPEC.md, "The file browser", a file), opened to verify a place (a citation's, a label's record, a card's
 *  source): its name as the title; under it its type, its records and the lines shown of how many, `earlier  later` at
 *  R; the tabs of the modes it reads in (1 2 3); the chosen record (a citation's, a click's, ↑↓) lit, its place a link
 *  and a blue `?` under the header; a row per label that is on and labeled the file, its values in their hues, which
 *  mark each record they labeled in a column before it; b back where it was opened from (Backspace too, where the
 *  list has the key). The terminal
 *  has no file browser (Matt, 10-16). A database: its tables, then a table's rows. */
async function drawFile(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  if (p.path && isDatabase(p.path)) return drawDatabase(cx, e, p)
  const els = cx.els(e)
  const { Box, Text, Button, Code } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const start = p.start ?? 1
  const got = await surfaceValue<Obj>(cx, `file:${p.path}:${start}`)
  if (!got) return none(cx, e, `◌ reading ${p.title}`)
  if (!got.ok) {
    if (!rt.toasted.has(`${p.path}:${got.error}`)) {
      rt.toasted.add(`${p.path}:${got.error}`)
      cx.toast(`thimble: could not read ${p.title}: ${got.error}`)
    }
    return <Box flexDirection="column"><Text color={COLORS.problem} wrap="wrap">{`× ${got.error}`}</Text></Box>
  }
  const page = got.value
  const path = p.path ?? ''
  // the file's find: its words while the view shows this file; Esc gave the keys to the prompt, so it types no more
  if (inFile.path !== path) inFile = { path, text: '', typing: false, gen: inFile.gen + 1 }
  if (!panelHasKeys()) inFile.typing = false
  const findText = inFile.text.trim()
  const findGot = findText ? await surfaceValue<Obj>(cx, `findin:${path}:${findText}`) : undefined
  const found = findGot?.ok && Array.isArray(findGot.value.lines) ? (findGot.value.lines as number[]) : []
  const ls = pageLines(page)
  const total = typeof page.total_lines === 'number' ? page.total_lines : 0
  const first = ls[0]?.n ?? start
  const last = ls.at(-1)?.n ?? first
  // a whole-file JSON transcript: the page of turns thimble parsed from the whole file; where the parse found none,
  // the view opens its other tab and the type column no longer says transcript
  const whole = wholeJson(page)
  const tgot = whole ? await surfaceValue<Obj>(cx, turnsRead(p).key) : undefined
  if (whole && !tgot) return none(cx, e, `◌ reading ${p.title}`)
  const tpage = tgot?.ok ? tgot.value : null
  const turns = whole ? (tpage ? turnsOfPage(tpage) : null) : turnsOf(page)
  if (whole && !turns) {
    const o = rt.opens.get(path)
    if (o?.as) rt.opens.set(path, { ...o, as: '' })
  }
  const head1 = delimiterOf(path) && start > 1 ? await surfaceValue<Obj>(cx, `file:${path}:1`) : undefined
  const table = tableOf(path, page, head1?.ok ? (rawLines(head1.value)[0]?.text ?? null) : null)
  const { modes, first: firstTab } = modesOf(path, page, turns, table)
  const wanted = p.mode === 'lines' ? 'raw' : (p.mode as FileMode | undefined)
  const mode: FileMode = wanted && modes.includes(wanted) ? wanted : firstTab
  // the Transcript tab of a whole-file JSON transcript pages through its turns, and tells its turns apart by index
  const jsonMode = whole && mode === 'transcript'
  const tstart = tpage && typeof tpage.start === 'number' ? tpage.start : 0
  const tcount = tpage && Array.isArray(tpage.turns) ? tpage.turns.length : 0
  const ttotal = tpage && typeof tpage.total === 'number' ? tpage.total : 0
  // the labels that are on and labeled this file, and the values they gave its records on this page
  const covering = (await labelsOn(cx)).filter(l => labelCovers(l, path))
  const marksGot = ls.length && covering.length ? await surfaceValue(cx, marksKey(path, first, last)) : undefined
  const rm = recordMarks(marksGot?.ok ? marksGot.value : [], covering, path)
  const marking = marksGot?.ok ? covering : []
  const gutter = gutterOf(covering.filter(l => [...rm.lines.values()].some(m => m.has(l.id))), rm.lines)
  // b goes back where the file was opened from (Backspace too, where the list has the key): ← reaches no element of a
  // pane (listKeysEl)
  const finds = !jsonMode && ls.length > 0
  const fileHints = inFile.typing ? ['↑↓ for the lines it found', 'Enter to stay there'] : [...(modes.length > 1 ? [`${modes.map((_m, i) => i + 1).join(' ')} for the tabs`] : []), '↑↓ to choose', 'Enter to open', ...(finds ? ['f to find'] : [])]
  const tab = (m: FileMode) =>
    m === mode ? <Text key={`tab-${m}`} inverse>{` ${TAB_NAME[m]} `}</Text> : <Button key={`tab-${m}`} label={` ${TAB_NAME[m]} `} plain onPress={() => void openPanel(cx, { ...p, mode: m }, { replace: true })} />
  // a page, a tab, a sort or a line chosen in place: back leads where the file was opened from (live check term-fix9,
  // quirk 12)
  const here = (q: TermPanel) => openPanel(cx, q, { replace: true })
  const earlier = jsonMode ? (tstart > 0 ? () => void here({ ...p, from: Math.max(0, tstart - TURNS_PAGE), turn: undefined }) : null) : first > 1 ? () => void here({ ...p, start: Math.max(1, first - 200) }) : null
  const later = jsonMode ? (tstart + tcount < ttotal ? () => void here({ ...p, from: tstart + tcount, turn: undefined }) : null) : total && last < total ? () => void here({ ...p, start: last + 1 }) : null
  const records = table?.rows.length ?? recordsOf(page).length
  const shownWords = jsonMode ? `turns ${num(tstart + 1)}-${num(tstart + tcount)} of ${num(ttotal)}` : ls.length ? `lines ${num(first)}-${num(last)}${total ? ` of ${num(total)}` : ''}` : page.binary ? 'raw bytes: not shown' : ''
  const subWords = [fileType(path, str(page.kind), firstTab === 'transcript' ? 'transcript' : ''), records ? plural(records, delimiterOf(path) ? 'row' : 'record') : '', shownWords]
  const subW = lineWidth(subLine(subWords))
  const navW = (earlier ? 7 : 0) + (later ? 5 : 0) + (earlier && later ? 2 : 0)
  const pagesEl = (
    <Box key="file-pages" flexShrink={0} flexDirection="row" columnGap={2}>
      {earlier ? <Button key="file-earlier" label="earlier" plain onPress={earlier} /> : null}
      {later ? <Button key="file-later" label="later" plain onPress={later} /> : null}
    </Box>
  )
  const oneRow = !navW || subW + 2 + navW <= cols
  const subRows: RenderElement[] = oneRow
    ? [
        <Box key="file-sub" flexDirection="row">
          <Box flexShrink={1}>{lineEl(els, subLine(subWords))}</Box>
          <Box flexGrow={1} minWidth={navW ? 2 : 0} />
          {navW ? pagesEl : null}
        </Box>,
      ]
    : [<Box key="file-sub">{lineEl(els, subLine(subWords), undefined, true)}</Box>, <Box key="file-sub-pages" flexDirection="row">{pagesEl}</Box>]
  // the header's rows under the title row (which holds the file's name): the subtitle's
  const headRows = oneRow ? 1 : Math.max(1, Math.ceil(subW / cols)) + 1
  // each tab's name with a cell of space at each side, the selected one inverse, so choosing a tab moves none; the row
  // starts one cell left of the edge, so the first tab's name starts at the edge, where the title starts
  const tabsRow = (
    <Box key={marginKey('file-tabs')} flexDirection="row" paddingLeft={MARGIN_W - 1}>
      {modes.map(m => tab(m))}
    </Box>
  )
  // the find's field: its words, the cursor after them while it takes typing, and how many lines hold them against R
  const at = found.indexOf(p.line ?? 0)
  const complete = findGot?.ok ? findGot.value.complete !== false : true
  const findFacts = !findText ? '' : !findGot ? '◌ finding' : !findGot.ok ? `× ${findGot.error}` : !found.length ? 'none' : `${at >= 0 ? `${num(at + 1)} of ` : ''}${plural(found.length, 'line')}${complete ? '' : '+'}`
  const findRow =
    inFile.typing || findText ? (
      <Box key="file-find" flexDirection="row">
        <Text dimColor>{'find  '}</Text>
        <Text>{clip(inFile.text, Math.max(4, cols - 30))}</Text>
        {inFile.typing ? <Text inverse>{' '}</Text> : null}
        <Box flexGrow={1} />
        <Text {...(findGot && !findGot.ok ? { color: COLORS.problem } : { dimColor: true })}>{findFacts}</Text>
      </Box>
    ) : null
  const more = [...subRows, ...(modes.length > 1 ? [tabsRow] : []), ...(findRow ? [findRow] : [])]
  const body: RenderElement[] = [...headerEls(els, { title: p.title || path, cols, more })]
  // the record chosen, by its line; a whole-file JSON transcript's turn by its index. JSON shows one record: the chosen,
  // else the first
  // a citation's line: the turn on it, or whose record starts there (a record cited by its pointer), else the last before
  const pickedTurn = jsonMode ? (turns!.find(t => t.i === p.turn) ?? (p.line ? (turns!.find(t => t.n === p.line || t.rec === p.line) ?? turns!.filter(t => t.n < p.line!).at(-1)) : undefined)) : undefined
  const jsonRecs = mode === 'json' ? jsonRecords(page) : new Map<number, unknown>()
  const inPage = p.line && p.line >= first && p.line <= last ? p.line : 0
  const chosen = jsonMode ? (pickedTurn?.n ?? 0) : mode === 'json' ? (jsonRecs.has(inPage) ? inPage : ([...jsonRecs.keys()][0] ?? 0)) : inPage
  const choose = (n: number) => () => here({ ...p, line: n })
  const chooseTurn = (t: Turn) => () => here({ ...p, line: t.n, turn: t.i, from: tstart })
  // Backspace: where the file was opened from, as b
  const back = async () => {
    inFile = { path: '', text: '', typing: false, gen: inFile.gen + 1 }
    return navBack(cx)
  }
  // while the find's field takes typing ↑↓ choose among the lines it found, the one before or after the chosen line
  const stepFound = (dd: number) => {
    const cur = p.line ?? 0
    const next = dd > 0 ? found.find(n => n > cur) : [...found].reverse().find(n => n < cur)
    return next !== undefined ? matchAt(cx, p, next) : undefined
  }
  if (inFile.typing) relayField({ text: inFile.text, send: t => findInFile(cx, p, t), enter: async () => {
    inFile.typing = false
    await cx.bumpPanel()
  } })
  // the record chosen, right under the header so it shows however long the view: its place a link to the citation
  // panel, and a blue "?" that asks a thread about it
  if (chosen) {
    const ref = `${path}#L${chosen}`
    const words = jsonMode ? (pickedTurn?.text ?? '') : (ls.find(l => l.n === chosen)?.text ?? '')
    const place = `↗ ${placeWords(ref)}`
    const ask = () => openAsk(cx, { kind: 'record', ref, text: clip(words, 600), label: `${placeWords(ref)}: ${clip(words, 200)}` })
    body.push(linesEl(cx, e, 'file-detail', [[{ s: '↗', fg: LINK }, { s: ' ' }, linkSeg(placeWords(ref)), { s: '  ' }, { s: '?', fg: LINK }]], [{ y: 0, x0: 0, x1: width(place), row: false, run: () => openCite(cx, ref, null) }, { y: 0, x0: width(place) + 2, x1: width(place) + 3, row: false, run: ask }], width(place) + 3))
  }
  // a row per label that is on and labeled the file: `label`, its name a link with `↗`, its values after their `●`;
  // the value it gave the file whole after `file`
  const labelRows = marking.map((l, i) => labelRow(cx, e, l, rm.file.get(l.id), cols, i))
  body.push(...labelRows)
  const lit = (t: Turn) => (jsonMode ? t.i === pickedTurn?.i : t.n === chosen)
  const o: DrawOpts = { cols, chosen, gutter, pick: n => (jsonMode ? chooseTurn(turns!.find(t => t.i === n)!) : choose(n)), sort: p.sort, onSort: next => () => here({ ...p, sort: next }), labeled: rm.lines.size > 0 }
  let d: Drawn | null = null
  let jsonEl: RenderElement | null = null
  if (!ls.length) {
    if (!page.binary) body.push(none(cx, e))
  } else if (mode === 'transcript') d = drawTranscript(turns!, { ...o, byIndex: jsonMode, isChosen: lit })
  else if (mode === 'table') d = drawTable(table!, o)
  else if (mode === 'text') d = drawLines(rawLines(page), { ...o, wrap: true, md: /\.(md|markdown)$/i.test(path), find: findText })
  else if (mode === 'json') {
    // one record as JSON, indented, colored as Claude Code colors JSON; ↑↓ the record before or after it
    const units = [...jsonRecs.keys()]
    const src = JSON.stringify(jsonRecs.get(chosen) ?? null, null, 2) ?? 'null'
    const room = Math.max(4, paneRows() ? paneRows() - 1 - headRows - (modes.length > 1 ? 1 : 0) - (findRow ? 1 : 0) - 1 - 1 - labelRows.length - hintHeight(fileHints, cols) - 1 : 400)
    // its lines wrapped at the pane's edge, so a long value reads whole, as many as the rows left hold
    const srcLines = src.split('\n').map(noControls)
    const shown: string[] = []
    let used = 0
    for (const l of srcLines) {
      const n = Math.max(1, Math.ceil(width(l) / cols))
      if (used + n > room - (shown.length < srcLines.length ? 1 : 0) && shown.length) break
      shown.push(l)
      used += n
    }
    jsonEl = (
      <Box key="file-json" flexDirection="column">
        <Code source={shown.join('\n').slice(0, 9000) || ' '} language="json" wrap="wrap" />
        {srcLines.length > shown.length ? <Text dimColor>{`… ${num(srcLines.length - shown.length)} more`}</Text> : null}
      </Box>
    )
    setListKeys(k => {
      if (inFile.typing && (k === 'up' || k === 'down')) return stepFound(k === 'up' ? -1 : 1)
      if (k === 'backspace' || k === 'delete') return back()
      if (k === 'up' || k === 'k' || k === 'down' || k === 'j') {
        const at = units.indexOf(chosen)
        const next = units[Math.max(0, Math.min(units.length - 1, at + (k === 'up' || k === 'k' ? -1 : 1)))]
        return next !== undefined ? choose(next)() : undefined
      }
      if ((k === 'return' || k === 'enter') && chosen) return openCite(cx, `${path}#L${chosen}`, null)
      return undefined
    })
  } else d = drawLines(rawLines(page), { ...o, wrap: false, md: /\.(md|markdown)$/i.test(path), find: findText })
  if (jsonEl) body.push(jsonEl)
  if (d && d.lines.length) {
    const unit = jsonMode ? (pickedTurn ? pickedTurn.i! : -1) : chosen || -1
    const at = d.units.indexOf(unit)
    const onKey = (k: string) => {
      if (inFile.typing && (k === 'up' || k === 'down')) return stepFound(k === 'up' ? -1 : 1)
      if (k === 'backspace' || k === 'left' || k === 'delete') return back()
      if ((k === 'up' || k === 'k' || k === 'down' || k === 'j') && d!.units.length) {
        const dd = k === 'up' || k === 'k' ? -1 : 1
        const next = d!.units[Math.max(0, Math.min(d!.units.length - 1, at < 0 ? 0 : at + dd))]!
        return o.pick(next)()
      }
      if ((k === 'return' || k === 'enter') && chosen) return openCite(cx, `${path}#L${chosen}`, null)
      if (k === 'tab') return here({ ...p, mode: modes[(modes.indexOf(mode) + 1) % modes.length]! })
      return undefined
    }
    // the lines cut to the rows the title row, the header, the chosen record's row, the label rows and the hint rows
    // leave (live check term-fix8, quirk 1: ↓ scrolled the header away and chose no line), a table's column names kept
    const used = 1 + headRows + (modes.length > 1 ? 1 : 0) + (findRow ? 1 : 0) + 1 + (chosen ? 1 : 0) + labelRows.length + d.fixed + hintHeight(fileHints, cols)
    const chosenY = at >= 0 ? (d.at.get(unit) ?? -1) : -1
    // a whole-file JSON transcript's window counts the turns cut off, those of its other pages too, as its header counts
    // them (bug hunt B29: `turns 1-200 of 440` over `↓ 695 more`, the rows below)
    const starts = d.units.map(u => ({ i: u, y: (d!.at.get(u) ?? 0) - d!.fixed }))
    const turnCount = jsonMode
      ? (top: number, end: number) => {
          const shown = starts.filter(s => s.y >= top && s.y < end)
          const first = shown[0]?.i ?? starts.find(s => s.y >= end)?.i ?? ttotal
          const last = shown.at(-1)?.i ?? first - 1
          return { above: first, below: Math.max(0, ttotal - 1 - last) }
        }
      : undefined
    const win = windowList(`file:${path}`, d.lines.slice(d.fixed), d.hits.map(h => ({ ...h, y: h.y - d!.fixed })).filter(h => h.y >= 0), chosenY - d.fixed, paneRows() - used, () => cx.bumpPanel(), undefined, turnCount)
    body.push(linesEl(cx, e, marginKey('file-body'), [...d.lines.slice(0, d.fixed), ...win.lines], [...d.hits.filter(h => h.y < d!.fixed), ...win.hits.map(h => ({ ...h, y: h.y + d!.fixed }))], cols + MARGIN_W, onKey))
  }
  // the tabs by their digits
  // the tabs by their digits, `f` for the find; none while its field takes typing, where every key is the field's
  const startFind = async () => {
    inFile = { ...inFile, path, typing: true }
    await cx.focus(RELAY.pick).catch(() => false)
    await cx.bumpPanel()
  }
  const keys = inFile.typing ? [] : [...(modes.length > 1 ? modes.map((m, i) => ({ key: `tab${i}`, hotkey: String(i + 1), onPress: () => void here({ ...p, mode: m }) })) : []), ...(finds ? [{ key: 'find', hotkey: 'f', onPress: () => void startFind() }] : [])]
  body.push(...(inFile.typing ? [fieldHintsRow(els, fileHints, cols)] : bottomRows(cx, e, cols, [], [], fileHints)))
  const hk = hiddenKeys(cx, e, keys)
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

/** A label row of a file (SPEC.md, "Cards", the label row): `label` dim, the label's name in blue and underlined, then
 *  `↗` (either opens the label's panel), then each value after its `●` in its hue; `file` and the value it gave the
 *  file whole, for a label over files. */
function labelRow(cx: Ctx, e: PaneEvent, l: OnLabel, fileValue: string | undefined, cols: number, i: number): RenderElement {
  const line: Line = [dim('label  '), linkSeg(l.name), { s: ' ' }, { s: '↗', fg: LINK }]
  const x1 = lineWidth(line)
  // a value the label does not highlight dim, as the browser's Files shows its toggle off
  const value = (v: string): Seg[] => (l.lit.includes(v) ? [{ s: '●', fg: valueColour(l.values, v, l.colors) ?? COLORS.text }, { s: ` ${v}` }] : [dim('●'), dim(` ${v}`)])
  for (const v of l.values) line.push({ s: '  ' }, ...value(v))
  if (fileValue) line.push(dim('  ·  file  '), ...value(fileValue))
  const open = () => openLabel(cx, l.id, l.name)
  return linesEl(cx, e, `file-label-${i}`, [cutLineSegs(line, cols)], [{ y: 0, x0: width('label  '), x1, row: false, run: open }], cols)
}

/** A line cut to `n` cells, segment by segment. */
function cutLineSegs(l: Line, n: number): Line {
  const out: Line = []
  let left = n
  for (const s of l) {
    if (left <= 0) break
    const w = width(s.s)
    out.push(w <= left ? s : { ...s, s: cut(s.s, left) })
    left -= w
  }
  return out
}

/** A database file (the browser's Database view): its tables, each with its rows against R, Enter opening one; a
 *  table's rows as a table (paged 100 at a time, `earlier  later`; a click on a column's name sorts by it), the chosen
 *  row lit; Backspace from a table to its tables, from the tables where the file was opened from. */
async function drawDatabase(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box, Text, Button } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const path = p.path ?? ''
  const here = (q: TermPanel) => openPanel(cx, q, { replace: true })
  const tgot = await surfaceValue(cx, `tables:${path}`)
  if (!tgot) return none(cx, e, `◌ reading ${p.title}`)
  if (!tgot.ok) return <Box flexDirection="column"><Text color={COLORS.problem} wrap="wrap">{`× ${tgot.error}`}</Text></Box>
  const tables = (Array.isArray(tgot.value) ? tgot.value : []).filter(isObj).map(t => ({ name: str(t.name), rows: Number(t.row_count) || 0 }))
  const back = async () => {
    if (p.table) return here({ ...p, table: undefined, start: 1, line: undefined, sort: undefined })
    return navBack(cx)
  }
  const hints = ['↑↓ to choose', 'Enter to open', ...(p.table ? ['Backspace for the tables'] : [])]
  if (!p.table) {
    const body: RenderElement[] = [...headerEls(els, { title: p.title || path, cols, sub: subLine(['database', plural(tables.length, 'table')]) })]
    const pick = tables.find(t => t.name === p.slug)?.name ?? tables[0]?.name ?? ''
    const nw = Math.max(4, ...tables.map(t => width(num(t.rows))))
    const lines: Line[] = []
    const hits: LineHit[] = []
    tables.forEach((t, i) => {
      hits.push({ y: i, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: t.name === pick ? () => here({ ...p, table: t.name, start: 1, slug: t.name }) : () => here({ ...p, slug: t.name }) })
      lines.push(pointed(spread([{ s: t.name }], [dim(`${num(t.rows).padStart(nw)} rows`)], cols), t.name === pick))
    })
    if (!tables.length) lines.push(pointed([{ s: '  ' }, dim('none')], false))
    const at = tables.findIndex(t => t.name === pick)
    const onKey = (k: string) => {
      if (k === 'backspace' || k === 'delete') return back()
      if ((k === 'up' || k === 'k' || k === 'down' || k === 'j') && tables.length) return here({ ...p, slug: tables[Math.max(0, Math.min(tables.length - 1, at + (k === 'up' || k === 'k' ? -1 : 1)))]!.name })
      if ((k === 'return' || k === 'enter') && pick) return here({ ...p, table: pick, start: 1, slug: pick })
      return undefined
    }
    const win = windowList(`db:${path}`, lines, hits, at, paneRows() - 1 - body.length - hintHeight(hints, cols), () => cx.bumpPanel())
    body.push(linesEl(cx, e, marginKey('file-body'), win.lines, win.hits, cols + MARGIN_W, onKey))
    body.push(hintsRow(els, hints, cols))
    return <Box flexDirection="column">{body}</Box>
  }
  const rgot = await surfaceValue(cx, rowsKey(p))
  const start = p.start ?? 1
  const v = rgot?.ok && isObj(rgot.value) ? rgot.value : null
  const total = v && typeof v.total === 'number' ? v.total : 0
  const columns = v && Array.isArray(v.columns) ? (v.columns as unknown[]).map(String) : []
  const pk = v ? str(v.pk) : ''
  const raw = v && Array.isArray(v.rows) ? (v.rows as unknown[][]) : []
  const last = start + raw.length - 1
  const earlier = start > 1 ? () => void here({ ...p, start: Math.max(1, start - 100), line: undefined }) : null
  const later = last < total ? () => void here({ ...p, start: last + 1, line: undefined }) : null
  const navEl =
    earlier || later ? (
      <Box key="file-pages" flexShrink={0} flexDirection="row" columnGap={2}>
        {earlier ? <Button key="file-earlier" label="earlier" plain onPress={earlier} /> : null}
        {later ? <Button key="file-later" label="later" plain onPress={later} /> : null}
      </Box>
    ) : null
  const sub = subLine(['database', `table ${p.table}`, ...(raw.length ? [`rows ${num(start)}-${num(last)} of ${num(total)}`] : [])])
  const body: RenderElement[] = [
    ...headerEls(els, {
      title: p.title || path,
      cols,
      more: [
        <Box key="file-sub" flexDirection="row">
          <Box flexShrink={1}>{lineEl(els, sub)}</Box>
          <Box flexGrow={1} minWidth={navEl ? 2 : 0} />
          {navEl}
        </Box>,
      ],
    }),
  ]
  if (!rgot) {
    body.push(none(cx, e, `◌ reading ${p.table}`))
    body.push(hintsRow(els, hints, cols))
    return <Box flexDirection="column">{body}</Box>
  }
  if (!rgot.ok) {
    body.push(<Text key="rows-err" color={COLORS.problem} wrap="wrap">{`× ${rgot.error}`}</Text>)
    body.push(hintsRow(els, hints, cols))
    return <Box flexDirection="column">{body}</Box>
  }
  // a row by its number in the table (from 1), as the page reads them
  const table: Table = { heads: columns, rows: raw.map((r, i) => ({ n: start + i, cells: Array.isArray(r) ? r : [] })), pk }
  const chosen = p.line && p.line >= start && p.line <= last ? p.line : 0
  // the rows as the server sorted them, by the column a click on its name chose
  const d = drawTable(table, { cols, chosen, gutter: () => [], pick: n => () => here({ ...p, line: n }), sort: p.sort, presorted: true, onSort: next => () => here({ ...p, sort: next, start: 1, line: undefined }), labeled: false })
  let rowRef = ''
  if (chosen) {
    const row = raw[chosen - start] ?? []
    const key = pk && columns.includes(pk) ? row[columns.indexOf(pk)] : chosen
    const ref = `${path}#${p.table}/${str(key)}`
    rowRef = ref
    const words = columns.map((c, i) => `${c}: ${cellText(row[i])}`).join(' · ')
    const place = `↗ ${path} · ${p.table} · ${str(key)}`
    const ask = () => openAsk(cx, { kind: 'record', ref, text: clip(words, 600), label: `${p.table} ${str(key)}: ${clip(words, 200)}` })
    body.push(linesEl(cx, e, 'file-detail', [[{ s: '↗', fg: LINK }, { s: ' ' }, linkSeg(place.slice(2)), { s: '  ' }, { s: '?', fg: LINK }]], [{ y: 0, x0: 0, x1: width(place), row: false, run: () => openCite(cx, ref, null) }, { y: 0, x0: width(place) + 2, x1: width(place) + 3, row: false, run: ask }], width(place) + 3))
  }
  const at = d.units.indexOf(chosen || -1)
  const onKey = (k: string) => {
    if (k === 'backspace' || k === 'delete') return back()
    if ((k === 'up' || k === 'k' || k === 'down' || k === 'j') && d.units.length) return here({ ...p, line: d.units[Math.max(0, Math.min(d.units.length - 1, at < 0 ? 0 : at + (k === 'up' || k === 'k' ? -1 : 1)))]! })
    if ((k === 'return' || k === 'enter') && rowRef) return openCite(cx, rowRef, null)
    return undefined
  }
  const used = 1 + body.length + d.fixed + hintHeight(hints, cols)
  const win = windowList(`db:${path}:${p.table}`, d.lines.slice(d.fixed), d.hits.map(h => ({ ...h, y: h.y - d.fixed })).filter(h => h.y >= 0), (d.at.get(chosen) ?? -1) - d.fixed, paneRows() - used, () => cx.bumpPanel())
  body.push(linesEl(cx, e, marginKey('file-body'), [...d.lines.slice(0, d.fixed), ...win.lines], [...d.hits.filter(h => h.y < d.fixed), ...win.hits.map(h => ({ ...h, y: h.y + d.fixed }))], cols + MARGIN_W, onKey))
  body.push(hintsRow(els, hints, cols))
  return <Box flexDirection="column">{body}</Box>
}

/** A file registered with the panel (views.ts registerPanelViews calls it once): its reads (term.ts loadsView) and its
 *  drawing (panel.tsx drawsView). */
export function registerFilesView(): void {
  loadsView('file', async (cx, p) => {
    if (!p.path) return
    await readLabels(cx)
    if (isDatabase(p.path)) {
      await readSurface(cx, `tables:${p.path}`, 'tables', [p.path])
      if (p.table) await readSurface(cx, rowsKey(p), 'rows', rowsArgs(p))
      return
    }
    const start = p.start ?? 1
    const key = `file:${p.path}:${start}`
    if (lastPage !== key || !(await cx.surface(key))) await readFilePage(cx, p.path, start)
    lastPage = key
    const page = await surfaceValue<Obj>(cx, key)
    // a whole-file JSON transcript: a page of the turns thimble parses from the whole file, for its Transcript tab
    if (page?.ok && wholeJson(page.value)) {
      const { key: tkey, args } = turnsRead(p)
      await readSurface(cx, tkey, 'turns', args)
    }
    // a delimited file's later page: its first, whose first line names the columns
    if (page?.ok && delimiterOf(p.path) && start > 1 && !(await cx.surface(`file:${p.path}:1`))) await readFilePage(cx, p.path, 1)
    if (page?.ok) {
      const ls = pageLines(page.value)
      if (ls.length) await readMarks(cx, p.path, ls[0]!.n, ls.at(-1)!.n)
    }
  })
  drawsView('file', drawFile)
}

