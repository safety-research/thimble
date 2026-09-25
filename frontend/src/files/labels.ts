// How labels show in the Files pane, as pure functions: which labels the list holds, colours and classes, the dots and
// stripes a file row carries, the marks over the columns of the labels that are on and the focused one, a record's
// gutter cells and marks, the marks a custom view's records take, and a text cut into segments at its spans. A class's
// colour is an index into the label palette, --label-1..LABEL_COLOURS; 0 is --label-none, the grey of "no match".
import type { Concept, ConceptPatch, ConceptRun, ConceptUnit, LabelClass, LabelDraft, LabelMarks, LabelRow } from '../lib/types'

const FILE_UNITS = new Set(['record', 'agent', 'run'])

/** Whether a label is over files (records, files or runs), so the Files pane lists it. */
export const isFilesLabel = (k: Pick<Concept, 'unit'>): boolean => FILE_UNITS.has(k.unit)

/** Whether the Files pane's Labels list shows a label: any label that is no trial, since a trial a chat ran on a few
 * units with `limit` is no label until it runs on everything (backend concepts.py, Trials), and a trial over files
 * that is on, since its marks in the reader and the views need their row. Labels over cards and report sentences are
 * listed too: the pane is where labels are made and edited, whatever they label (LabelsPane). */
export const listedInFiles = (k: Pick<Concept, 'unit' | 'trial' | 'shown'>): boolean => !k.trial || (isFilesLabel(k) && !!k.shown)

/** What a label labels, as the edit card's Over names it: records or files (`files`), canvas cards, report sentences. */
export type LabelOver = 'files' | 'cards' | 'sentences'

export const overOf = (k: Pick<Concept, 'unit'>): LabelOver => (k.unit === 'cell' ? 'cards' : k.unit === 'span' ? 'sentences' : 'files')

/** The unit a new label is created with: a label over files takes the one its marks imply (the server's MARKS_UNIT). */
export const unitOfOver = (over: LabelOver, marks: LabelMarks): ConceptUnit => (over === 'cards' ? 'cell' : over === 'sentences' ? 'span' : marks === 'file' ? 'agent' : 'record')

/** What a label over files marks; a server that predates `marks` implies it from the unit. */
export const marksOf = (k: Pick<Concept, 'unit' | 'marks'>): LabelMarks => k.marks ?? (k.unit === 'record' ? 'record' : 'file')

/** What a label over files marks, as the canvas label card's chip says it: `marks spans`, `marks records`, `marks files`. */
export const marksWord = (k: Pick<Concept, 'unit' | 'marks'>): string => `marks ${marksOf(k)}s`

/** The patterns of a label's glob, comma-separated as the server keeps them. */
export const globPatterns = (glob: string | null | undefined): string[] => (glob ?? '').split(',').map((p) => p.trim()).filter(Boolean)

/** How many colours the label palette has, --label-1..12 (tokens.css; the server's concepts.PALETTE). */
export const LABEL_COLOURS = 12

/** The name of the token that carries a class colour. */
export const colourToken = (n: number | null | undefined): string => (n != null && n >= 1 && n <= LABEL_COLOURS ? `--label-${n}` : '--label-none')

/** A class colour as the token that carries it. */
export const colourVar = (n: number | null | undefined): string => `var(${colourToken(n)})`

const QUIET = new Set(['no', 'none', 'other', 'no match', 'not', 'neither', 'n/a', 'unknown'])

/** Whether a value is a label's negative: a quiet word, or the second of two (the server's rule). */
export const isNegative = (name: string, i: number, n: number): boolean => QUIET.has(name.trim().toLowerCase()) || (n === 2 && i === 1)

const QUIET_LEAD = /^(no|not|none|other|neither)\b/i

/** The values a label's card counts as not matched: its negatives (isNegative), and a value that begins with a quiet
 * word (`no refund`, `not a merge`, `other record`). */
export const unmatchedValues = (labels: readonly string[]): Set<string> =>
  new Set(labels.filter((v, i) => isNegative(v, i, labels.length) || QUIET_LEAD.test(v.trim())))

/** How many units matched, as the label's card states it and the Labels pane repeats it: the units of every value
 * that is not an unmatched one (unmatchedValues), or all `total` units when the label has no such value. */
export function matchedCount(labels: readonly string[], counts: Readonly<Record<string, number>> | null | undefined, total: number): number {
  const unmatched = unmatchedValues(labels)
  if (!unmatched.size) return total
  return Object.entries(counts ?? {}).reduce((n, [v, c]) => (v && !unmatched.has(v) ? n + (c ?? 0) : n), 0)
}

/** The labels that are on, in the order they were turned on: `order` holds known ids in that order, and labels it does
 * not hold follow in the order of `on`. Every place that numbers the labels that are on follows this order. Pure. */
export function turnedOnOrder<T extends { id: string }>(on: readonly T[], order: readonly string[]): T[] {
  const at = new Map(order.map((id, i) => [id, i]))
  const known = on.filter((k) => at.has(k.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!)
  return [...known, ...on.filter((k) => !at.has(k.id))]
}

/** A label's classes: the server's, else one per value with the positive highlighted in the first colour. */
export function classesOf(k: Pick<Concept, 'labels' | 'classes'>): LabelClass[] {
  if (k.classes && k.classes.length) return k.classes
  return k.labels.map((name, i) => ({ name, color: isNegative(name, i, k.labels.length) ? 0 : (i % LABEL_COLOURS) + 1, highlight: !isNegative(name, i, k.labels.length) }))
}

/** Whether classes are a multi-class label's: more than one of them takes a colour (a negative's grey aside). Such a
 * label, where it is marked as a whole, is the label glyph in the plain ink, with no colour of its own. Pure. */
export const isMultiClass = (classes: readonly Pick<LabelClass, 'color'>[]): boolean => classes.filter((c) => !!c.color).length > 1

/** The ink of a multi-class label as a whole: the plain ink, no colour of its own (tokens.css). */
export const MULTI_COLOUR = 'var(--label-multi)'

/** A label's own colour: its first class's, or MULTI_COLOUR for a multi-class label. */
export const mainColour = (k: Pick<Concept, 'labels' | 'classes'>): string => {
  const classes = classesOf(k)
  return isMultiClass(classes) ? MULTI_COLOUR : colourVar(classes[0]?.color)
}

/** The value a row reads as: the analyst's verdict when there is one, else the classifier's. */
export const valueOf = (row: Pick<LabelRow, 'label' | 'analyst'>): string | null => row.analyst ?? row.label ?? null

/** The class of a value when the label highlights it, else undefined. */
export function litClass(k: Pick<Concept, 'labels' | 'classes'>, value: string | null | undefined): LabelClass | undefined {
  if (value == null) return undefined
  const c = classesOf(k).find((x) => x.name === value)
  return c && c.highlight ? c : undefined
}

/** The label whose spans the reader highlights in full colour: `focus` while it is on, else the label turned on last
 * (the last of `lanes`, the labels on in turnedOnOrder); null while no label is on. Pure. */
export function focusOf(lanes: readonly Pick<Concept, 'id'>[], focus: string | null | undefined): string | null {
  if (focus && lanes.some((k) => k.id === focus)) return focus
  return lanes.length ? lanes[lanes.length - 1].id : null
}

/** A label that is on, as the mark over its column shows it (LabelMark). */
export interface LaneTag {
  id: string
  name: string
  /** its class colour for a single-class label, MULTI_COLOUR for a multi-class one */
  colour: string
  multi: boolean
  /** a multi-class label's number among those that are on, from 1, in turn-on order; 0 for a single-class label */
  n: number
}

/** The marks over the columns of the labels that are on, `lanes` being them in the order they were turned on. Pure. */
export function laneTags(lanes: readonly Concept[]): LaneTag[] {
  let n = 0
  return lanes.map((k) => {
    const multi = isMultiClass(classesOf(k))
    return { id: k.id, name: k.name, colour: mainColour(k), multi, n: multi ? ++n : 0 }
  })
}

/** One class of a label present in a unit, with its colour. */
export interface LaneValue {
  value: string
  colour: string
}

/** A record's cell in one label's column: the highlighted classes the label gave it (none for an empty cell; more
 * than one where a file's records carry several, drawn split). */
export interface LaneCell {
  id: string
  name: string
  values: LaneValue[]
}

/** The highlighted classes of a label among a file's value counts, in the label's class order. */
function litValues(k: Pick<Concept, 'labels' | 'classes'>, counts: Readonly<Record<string, number>> | undefined): LaneValue[] {
  if (!counts) return []
  return classesOf(k)
    .filter((c) => c.highlight && (counts[c.name] ?? 0) > 0)
    .map((c) => ({ value: c.name, colour: colourVar(c.color) }))
}

/** A record's cells, one per label that is on in the order of `lanes`: a label over records or spans gives the class
 * of the record's row (`rowOf`) when it is highlighted, a label over files the highlighted classes of the file the
 * record is in (`fileOf`, its value counts), since each of the file's records carries the file's value. Pure. */
export function laneCells(
  lanes: readonly Concept[],
  rowOf: (conceptId: string) => LabelRow | undefined,
  fileOf: (conceptId: string) => Readonly<Record<string, number>> | undefined,
): LaneCell[] {
  return lanes.map((k) => {
    let values: LaneValue[] = []
    if (marksOf(k) === 'file') values = litValues(k, fileOf(k.id))
    else {
      const row = rowOf(k.id)
      const value = row ? valueOf(row) : null
      const c = litClass(k, value)
      if (c && value != null) values = [{ value, colour: colourVar(c.color) }]
    }
    return { id: k.id, name: k.name, values }
  })
}

/** A cell's fill as a CSS background: its one colour, or its colours side by side in equal parts. '' when empty. */
export function cellFill(values: readonly LaneValue[]): string {
  if (values.length <= 1) return values[0]?.colour ?? ''
  const w = 100 / values.length
  return `linear-gradient(90deg, ${values.map((v, i) => `${v.colour} ${+(i * w).toFixed(3)}% ${+((i + 1) * w).toFixed(3)}%`).join(', ')})`
}

export interface Presence {
  id: string
  name: string
  colour: string
  /** a multi-class label, drawn as the label glyph rather than a dot */
  multi?: boolean
}

/** The marks a file row carries: a dot per label that is on and marks spans or records, when one of its highlighted
 * values is on the file (the label glyph for a multi-class label); a stripe per file label that is on, when the file's
 * value is highlighted, in that value's colour. */
export function presenceOf(on: Concept[], presence: ReadonlyMap<string, Record<string, Record<string, number>>>, path: string): { dots: Presence[]; stripes: Presence[] } {
  const dots: Presence[] = []
  const stripes: Presence[] = []
  for (const k of on) {
    const values = presence.get(k.id)?.[path]
    if (!values) continue
    const classes = classesOf(k)
    const lit = classes.find((c) => c.highlight && (values[c.name] ?? 0) > 0)
    if (!lit) continue
    const multi = isMultiClass(classes)
    if (marksOf(k) === 'file') stripes.push({ id: k.id, name: k.name, colour: multi ? colourVar(lit.color) : mainColour(k) })
    else dots.push({ id: k.id, name: k.name, colour: mainColour(k), multi })
  }
  return { dots, stripes }
}

/** The dots of folder rows, per path: a dot per label that is on and has a highlighted value on a file under it (the
 * path itself too), in the order of `on`. Computed by walking each lit path's ancestors. */
export function folderPresence(on: Concept[], presence: ReadonlyMap<string, Record<string, Record<string, number>>>): Map<string, Presence[]> {
  const out = new Map<string, Presence[]>()
  for (const k of on) {
    const byPath = presence.get(k.id)
    if (!byPath) continue
    const lit = classesOf(k).filter((c) => c.highlight).map((c) => c.name)
    if (!lit.length) continue
    const p = { id: k.id, name: k.name, colour: mainColour(k), multi: isMultiClass(classesOf(k)) }
    const seen = new Set<string>()
    for (const [path, values] of Object.entries(byPath)) {
      if (!lit.some((v) => (values[v] ?? 0) > 0)) continue
      // bottom up: a folder already seen had its own ancestors added when it was
      for (let dir = path; dir && !seen.has(dir); dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
        seen.add(dir)
        const got = out.get(dir)
        if (got) got.push(p)
        else out.set(dir, [p])
      }
    }
  }
  return out
}

const UNIT_WORDS: Record<string, [string, string]> = { record: ['record', 'records'], agent: ['file', 'files'], run: ['run', 'runs'], cell: ['card', 'cards'], span: ['sentence', 'sentences'] }

/** A label's unit as a count says it: records, files (a file label's unit, `agent`), runs, cards or sentences. */
export const unitWord = (unit: string, n: number): string => (UNIT_WORDS[unit] ?? [unit, `${unit}s`])[n === 1 ? 0 : 1]

/** Where a label over files stands, for its row in the Labels pane: an apply running (done of total units, or of the
 * files while they are indexed and the total is not known), the last run's outcome, or a failed run with its message. */
export type LabelStatus =
  | { state: 'running'; done: number; total: number | null; unit: string }
  | { state: 'done'; matches: number; total: number; failed: number; ts: string; unit: string }
  | { state: 'error'; message: string }

const later = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const ta = a ? Date.parse(a) : NaN
  const tb = b ? Date.parse(b) : NaN
  return Number.isNaN(tb) || (!Number.isNaN(ta) && ta > tb)
}

/** A label's status from the run the pane last saw (`live`, else the concepts list's run record) and the last run kept
 * on the label. A run that ended after the kept one stands in for it until the list is read again (a failed run sends
 * no `concepts` event). The kept run's count is matchedCount over the label's counts; before counts are known, the
 * run's `matches`. */
export function labelStatus(k: Pick<Concept, 'unit' | 'labels' | 'counts' | 'last_run' | 'run'>, live?: ConceptRun | null): LabelStatus | null {
  const run = live ?? k.run ?? null
  if (run?.status === 'running') {
    if (run.total != null) return { state: 'running', done: run.done ?? 0, total: run.total, unit: k.unit }
    if (run.files_total) return { state: 'running', done: run.files_indexed ?? 0, total: run.files_total, unit: 'agent' }
    return { state: 'running', done: 0, total: null, unit: k.unit }
  }
  const last = k.last_run ?? null
  if (run && (run.status === 'error' || run.status === 'done') && (!last || later(run.started, last.ts))) {
    if (run.status === 'error') return { state: 'error', message: run.message || 'the run failed' }
    const total = run.total ?? 0
    return { state: 'done', matches: run.matches ?? 0, total, failed: run.failed ?? 0, ts: run.started ?? '', unit: k.unit }
  }
  if (!last) return null
  if (last.status === 'error') return { state: 'error', message: last.message || 'the run failed' }
  const total = last.total ?? last.matched_total ?? last.labeled
  const matches = k.counts ? matchedCount(k.labels, k.counts, total) : last.matches ?? 0
  return { state: 'done', matches, total, failed: last.failed ?? 0, ts: last.ts, unit: k.unit }
}

/** An outcome as the label row says it: "468 of 2,392,002 records", with "· 3 failed" when units failed; the time
 * follows it on the row. */
export function outcomeText(s: Extract<LabelStatus, { state: 'done' }>): string {
  const text = `${s.matches.toLocaleString()} of ${s.total.toLocaleString()} ${unitWord(s.unit, s.total)}`
  return s.failed > 0 ? `${text} · ${s.failed.toLocaleString()} failed` : text
}

/** A running apply as the label row says it: "1,204/2,392,002 records"; '' before any total is known. */
export function progressText(s: Extract<LabelStatus, { state: 'running' }>): string {
  return s.total == null ? '' : `${s.done.toLocaleString()}/${s.total.toLocaleString()} ${unitWord(s.unit, s.total)}`
}

export interface SpanMark {
  /** the text to highlight, as the record spells it */
  text: string
  colour: string
  concept: string
  name: string
  /** a label other than the focused one: an underline in the colour rather than a fill */
  under?: boolean
}

export interface RecordMarks {
  /** the bar beside the record: the first record label that is on and highlights the record's value; the texts its
   * row names (`spans`) are highlighted as well */
  bar?: { colour: string; concept: string; name: string; value: string }
  /** a span label that is on and highlights the record's value, with no text to mark (the negative): the record's text
   * takes a tint of that colour; with a focused label, only that label's */
  tint?: { colour: string; concept: string; name: string; value: string }
  /** the texts to mark; with a focused label, its own come first, so it wins where two labels' texts overlap, and the
   * others' are `under` */
  spans: SpanMark[]
  /** every label that is on and highlights the record's value, in the order they are on */
  lit: { colour: string; concept: string; name: string; value: string }[]
}

/** The marks of one record from the rows of the labels that are on (each label's row for the record, if any). With
 * `focus` given (focusOf), the reader's focused label: only its texts are filled and only it tints the record. */
export function recordMarks(on: readonly Concept[], rowOf: (conceptId: string) => LabelRow | undefined, focus?: string | null): RecordMarks {
  const out: RecordMarks = { spans: [], lit: [] }
  const focused = focus !== undefined
  const first: SpanMark[] = []
  for (const k of on) {
    const marks = marksOf(k)
    if (marks === 'file') continue
    const row = rowOf(k.id)
    if (!row) continue
    const value = valueOf(row)
    const c = litClass(k, value)
    if (!c || value == null) continue
    const colour = colourVar(c.color)
    const mine = !focused || k.id === focus
    const into = focused && mine ? first : out.spans
    const span = (text: string): SpanMark => (mine ? { text, colour, concept: k.id, name: k.name } : { text, colour, concept: k.id, name: k.name, under: true })
    out.lit.push({ colour, concept: k.id, name: k.name, value })
    if (marks === 'record') {
      out.bar ??= { colour, concept: k.id, name: k.name, value }
      // A regex's matches, or the texts a code label returned, say which words made the record match, so they are
      // highlighted inside the record as well as the bar marking it.
      for (const text of row.spans ?? []) into.push(span(text))
    } else if (row.spans && row.spans.length) {
      for (const text of row.spans) into.push(span(text))
    } else if (mine) {
      out.tint ??= { colour, concept: k.id, name: k.name, value }
    }
  }
  if (first.length) out.spans = [...first, ...out.spans]
  return out
}

export interface Segment {
  text: string
  mark?: SpanMark
  /** where the segment starts in the text */
  start: number
}

/** A span's pieces to look for in one block of text: the span, or its paragraphs when it crosses a blank line (a
 * record's blocks are joined by one), each at least three characters. */
export function needles(span: string): string[] {
  if (!/\n\s*\n/.test(span)) return span ? [span] : []
  return span.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 3)
}

/** The text cut at every occurrence of each span's text; where two spans overlap, the one listed first wins. The
 * segments' texts join to the text. */
export function markSegments(text: string, marks: readonly SpanMark[], find: (span: string) => string[] = needles): Segment[] {
  if (!text || !marks.length) return [{ text, start: 0 }]
  const owner: (SpanMark | undefined)[] = new Array(text.length)
  for (const m of marks) {
    for (const needle of find(m.text)) {
      if (!needle) continue
      let i = text.indexOf(needle)
      while (i >= 0) {
        for (let j = i; j < i + needle.length; j++) owner[j] ??= m
        i = text.indexOf(needle, i + needle.length)
      }
    }
  }
  const out: Segment[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || owner[i] !== owner[start]) {
      out.push({ text: text.slice(start, i), mark: owner[start], start })
      start = i
    }
  }
  return out
}

/** The file and line of a record's ref, `<path>#L<n>`; null for any other ref (a span, a range, a view key). */
export function recordRef(ref: string): { path: string; line: number } | null {
  const m = /^(.+)#L([1-9]\d*)$/.exec(ref)
  return m ? { path: m[1], line: Number(m[2]) } : null
}

export interface ViewMark {
  /** the bar's colour: that of the first label that is on and highlights the record, whatever it marks */
  bar: string
  /** the names of the labels that highlight the record, in the order of `on` */
  names: string[]
  /** the texts to highlight in the record's element, each span cut into the pieces `needles` looks for */
  spans: { text: string; colour: string }[]
}

/** The marks a custom view's page draws (viewer_bridge.js `labels` message), keyed by record ref: for each ref, the
 * labels that are on and highlight the record's value (`rows`: ref -> label id -> row). A view may not show the record's
 * text verbatim, so every highlighting label gives it the bar, and its texts are highlighted wherever the page shows
 * them. Refs that name no highlighted record are left out. */
export function viewMarks(on: readonly Concept[], rows: { get(ref: string): ReadonlyMap<string, LabelRow> | undefined }, refs: Iterable<string>): Record<string, ViewMark> {
  const out: Record<string, ViewMark> = {}
  if (!on.length) return out
  const rank = new Map(on.map((k, i) => [k.id, i]))
  for (const ref of refs) {
    if (!recordRef(ref)) continue
    const mine = rows.get(ref)
    if (!mine) continue
    const m = recordMarks(on, (id) => mine.get(id))
    const lit = [m.bar, m.tint, ...m.spans].filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => rank.get(a.concept)! - rank.get(b.concept)!)
    if (!lit.length) continue
    const names = [...new Map(lit.map((x) => [x.concept, x.name])).values()]
    out[ref] = { bar: lit[0].colour, names, spans: m.spans.flatMap((s) => needles(s.text).map((text) => ({ text, colour: s.colour }))) }
  }
  return out
}

/** A span as it reads inside a raw JSON line: its text JSON-escaped, so Raw highlights it where the record holds it. */
export function jsonNeedles(span: string): string[] {
  return needles(span).map((n) => JSON.stringify(n).slice(1, -1))
}

/** The next palette colour after `n` (1..LABEL_COLOURS, then the grey) that no other class of the label has (`others`), for the
 * edit card's colour square: each value keeps its own colour, as the server's fill_colours gives them. Pure. */
export function nextColour(n: number, others: readonly number[] = []): number {
  for (let m = n >= LABEL_COLOURS ? 0 : n + 1, j = 0; j <= LABEL_COLOURS; m = m >= LABEL_COLOURS ? 0 : m + 1, j++) if (m === 0 || !others.includes(m)) return m
  return 0
}

/** `want`, or the first palette colour after it that no class in `taken` has; `want` when every colour is taken or it
 * is the grey (the server's own_colour). Pure. */
export function ownColour(want: number, taken: readonly number[]): number {
  if (!want || !taken.includes(want)) return want
  for (let j = 1; j < LABEL_COLOURS; j++) {
    const m = ((want - 1 + j) % LABEL_COLOURS) + 1
    if (!taken.includes(m)) return m
  }
  return want
}

/** The classes a drafted label is created with: the first value highlighted in `colour`, a negative value (isNegative)
 * in the grey and not highlighted, any other in the colours after `colour`, highlighted. Pure. */
export function draftClasses(values: readonly string[], colour: number): LabelClass[] {
  return values.map((name, i) =>
    isNegative(name, i, values.length) && i > 0 ? { name, color: 0, highlight: false } : { name, color: ((colour - 1 + i) % LABEL_COLOURS) + 1, highlight: true },
  )
}

/** The body POST /concepts takes for a drafted label, as the edit card's Run sends it for a new one: a label over files
 * marks and applies to what the draft says and is created on in Files; a prompt's text is its description, a regex's
 * or code's its spec. Pure. */
export function draftBody(d: LabelDraft, colour: number): ConceptPatch & { name: string; unit: ConceptUnit } {
  const files = d.over === 'files'
  const marks = d.marks ?? 'span'
  return {
    name: d.name,
    unit: unitOfOver(d.over, marks),
    ...(files ? { marks, glob: d.glob } : {}),
    kind: d.kind,
    model: '',
    classes: draftClasses(d.values, colour),
    ...(d.kind === 'prompt' ? { description: d.text, spec: '' } : { spec: d.text }),
    shown: files,
  }
}

/** Whether a corpus path is one a view's claim names, as the server matches claims (backend views.glob_matches): the
 * glob against the whole path or its file name, `*` spanning folders as fnmatch's does; '' or '*' names every file.
 * Pure. */
export function claimMatches(path: string, claim: string): boolean {
  if (!claim || claim === '*') return true
  let re = ''
  for (let i = 0; i < claim.length; i++) {
    const ch = claim[i]
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else if (ch === '[' && claim.indexOf(']', i + 2) > i) {
      const end = claim.indexOf(']', i + 2)
      const body = claim.slice(i + 1, end)
      re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
      i = end
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  const full = new RegExp(`^${re}$`)
  return full.test(path) || full.test(path.slice(path.lastIndexOf('/') + 1))
}

/** The labels over files that mark a view's files: those whose rows fall in a file the view claims (their presence,
 * GET /labels/presence). Pure. */
export function viewLabels(all: readonly Concept[], presence: ReadonlyMap<string, Record<string, Record<string, number>>>, claims: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const k of all) {
    if (!isFilesLabel(k)) continue
    const files = Object.keys(presence.get(k.id) ?? {})
    if (files.some((f) => claims.some((c) => claimMatches(f, c)))) out.add(k.id)
  }
  return out
}

/** The labels a view turns on the first time it is opened, so its records open coloured: while no label that marks its
 * files is on, the orientation's labels over files that mark them (made by one of `orientChats`), oldest first, at most
 * `max`; none once any is on. Pure. */
export function viewDefaults(all: readonly Concept[], presence: ReadonlyMap<string, Record<string, Record<string, number>>>, claims: readonly string[], orientChats: ReadonlySet<string>, max = 2): string[] {
  const marking = viewLabels(all, presence, claims)
  const mine = all.filter((k) => marking.has(k.id))
  if (mine.some((k) => k.shown)) return []
  return mine
    .filter((k) => !k.trial && k.created_by.startsWith('chat:') && orientChats.has(k.created_by.slice(5)))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .slice(0, max)
    .map((k) => k.id)
}

/** A label's name made unique among `names`: the name, else it with the first free number after it. Pure. */
export function freeName(name: string, names: Iterable<string>): string {
  const taken = new Set([...names].map((n) => n.trim().toLowerCase()))
  if (!taken.has(name.trim().toLowerCase())) return name
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`
}
