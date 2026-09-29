// The labels a file's records carry in the reader, for the labels that are on: a gutter cell per label (labels.ts
// laneCells), a span label's texts highlighted in place, or a tint (labels.ts recordMarks). Each record asks for its
// line (`want`) and the hook fetches the LABEL_BLOCK-line block that holds it (GET /labels?path=&lines=a-b), so a large
// labelled file costs one small request per page shown. Cached per path; a bus `concepts` event re-reads the shown
// blocks and swaps them in once all have arrived. Provided through a context; a custom view's frame reads the same
// cache through watchPathLabels and wantLabels.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { scaleApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { Concept, LabelRow, LabelsForPath } from '../lib/types'
import { laneCells, recordMarks, type LaneCell, type RecordMarks } from './labels'

/** lines per labels request: the source route's largest page, so one block covers a reader page and its neighbours */
export const LABEL_BLOCK = 500

export const blockOf = (line: number): number => Math.floor((Math.max(1, Math.floor(line)) - 1) / LABEL_BLOCK)
export const blockRange = (block: number): [number, number] => [block * LABEL_BLOCK + 1, (block + 1) * LABEL_BLOCK]

/** `into` with `more` merged in: per concept the rows of both, deduped by ref (a whole-file row comes with every
 * block), the concept's name and values from the newer answer. A new array; the inputs are left alone. */
export function mergeLabels(into: LabelsForPath[], more: LabelsForPath[]): LabelsForPath[] {
  const out = new Map<string, LabelsForPath>()
  for (const l of into) out.set(l.concept_id, { ...l, rows: [...l.rows] })
  for (const l of more) {
    const have = out.get(l.concept_id)
    if (!have) {
      out.set(l.concept_id, { ...l, rows: [...l.rows] })
      continue
    }
    const seen = new Set(have.rows.map((r) => r.ref))
    const rows = [...have.rows]
    for (const r of l.rows) {
      if (seen.has(r.ref)) continue
      seen.add(r.ref)
      rows.push(r)
    }
    out.set(l.concept_id, { ...have, name: l.name, labels: l.labels, unit: l.unit, rows })
  }
  return [...out.values()]
}

/** Every label's row per record ref: ref -> concept id -> the row. */
export function rowsByRef(list: LabelsForPath[]): Map<string, Map<string, LabelRow>> {
  const out = new Map<string, Map<string, LabelRow>>()
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.rows)) continue
    for (const row of entry.rows) {
      if (!row || typeof row.ref !== 'string') continue
      const ref = row.ref.trim()
      let m = out.get(ref)
      if (!m) out.set(ref, (m = new Map()))
      if (!m.has(entry.concept_id)) m.set(entry.concept_id, row)
    }
  }
  return out
}

interface PathLabels {
  list: LabelsForPath[]
  /** blocks fetched or in flight */
  blocks: Set<number>
  listeners: Set<(list: LabelsForPath[]) => void>
  /** bumped when the cache is dropped, so an answer in flight for the old contents is ignored */
  gen: number
  /** after a drop, while blocks are read again: the new answers so far and the blocks still to come; `list` keeps the
   * old contents until none are left */
  next: { list: LabelsForPath[]; waiting: Set<number> } | null
}

const cache = new Map<string, PathLabels>()
const cacheKey = (ws: string, path: string) => `${ws}|${path}`

function entry(key: string): PathLabels {
  let e = cache.get(key)
  if (!e) {
    e = { list: [], blocks: new Set(), listeners: new Set(), gen: 0, next: null }
    cache.set(key, e)
  }
  return e
}

function notify(e: PathLabels): void {
  for (const fn of e.listeners) fn(e.list)
}

function fetchBlock(ws: string, path: string, block: number): void {
  const e = entry(cacheKey(ws, path))
  if (e.blocks.has(block)) return
  e.blocks.add(block)
  const gen = e.gen
  e.next?.waiting.add(block)
  const [a, b] = blockRange(block)
  const settle = (more: LabelsForPath[]) => {
    const next = e.next
    if (!next) {
      e.list = mergeLabels(e.list, more)
      return notify(e)
    }
    next.list = mergeLabels(next.list, more)
    next.waiting.delete(block)
    if (next.waiting.size) return
    e.list = next.list
    e.next = null
    notify(e)
  }
  scaleApi
    .labelsForLines(ws, path, a, b)
    .then((more) => {
      if (e.gen === gen) settle(more)
    })
    .catch(() => {
      /* labels are a convenience; the file reads without them, and the next record asks again */
      if (e.gen !== gen) return
      e.blocks.delete(block)
      if (e.next) settle([])
    })
}

/** Drop every path's labels; the paths shown re-read their blocks and keep their old labels until every block is read,
 * so the marks change once. */
function invalidate(): void {
  for (const [key, e] of cache) {
    const blocks = [...e.blocks]
    e.gen += 1
    e.blocks.clear()
    e.next = null
    if (!e.listeners.size || !blocks.length) {
      e.list = []
      if (e.listeners.size) notify(e)
      continue
    }
    e.next = { list: [], waiting: new Set() }
    const [ws, ...rest] = key.split('|')
    const path = rest.join('|')
    for (const b of blocks) fetchBlock(ws, path, b)
  }
}

let watchers = 0
let offConcepts: (() => void) | null = null

/** Keep the cache listening for `concepts` while anything reads it: one subscription however many readers and frames
 * are open, so an event drops the cache once and each shown block is read again once. Returns the release. */
function holdInvalidation(): () => void {
  if (watchers++ === 0) offConcepts = bus.on('concepts', invalidate)
  let held = true
  return () => {
    if (!held) return
    held = false
    if (--watchers === 0) {
      offConcepts?.()
      offConcepts = null
    }
  }
}

const REFRESH_MIN_MS = 2500
let refreshed = 0

/** Read the shown blocks again, as a `concepts` event does, at most once per REFRESH_MIN_MS: a running label sends no
 * event per batch, so a page that shows it asks for its new rows this way. */
export function refreshLabels(): void {
  const now = Date.now()
  if (now - refreshed < REFRESH_MIN_MS) return
  refreshed = now
  invalidate()
}

/** Follow the labels on one file outside React: `fn` gets every label's row per record ref now and after each block
 * that arrives or each `concepts` event, until the returned function is called. The rows come for the lines asked for
 * with wantLabels. */
export function watchPathLabels(ws: string, path: string, fn: (rows: Map<string, Map<string, LabelRow>>) => void): () => void {
  const e = entry(cacheKey(ws, path))
  const listener = (l: LabelsForPath[]) => fn(rowsByRef(l))
  e.listeners.add(listener)
  const release = holdInvalidation()
  if (e.list.length) listener(e.list)
  return () => {
    e.listeners.delete(listener)
    release()
  }
}

/** Ask for the block of labels that holds `line` of `path`, once; the watchers of the path get it when it arrives. */
export function wantLabels(ws: string, path: string, line: number): void {
  fetchBlock(ws, path, blockOf(line))
}

/** The labels on one file, block by block as its records ask for them (`want`), cached per path; a `concepts` event
 * reads the shown blocks again. */
export function usePathLabels(ws: string, path: string): { rows: Map<string, Map<string, LabelRow>>; want: (line: number) => void } {
  const key = cacheKey(ws, path)
  const [list, setList] = useState<LabelsForPath[]>(() => entry(key).list)
  useEffect(() => {
    const e = entry(key)
    const fn = (l: LabelsForPath[]) => setList(l)
    e.listeners.add(fn)
    setList(e.list)
    const release = holdInvalidation()
    return () => {
      e.listeners.delete(fn)
      release()
    }
  }, [key])
  const want = useCallback((line: number) => fetchBlock(ws, path, blockOf(line)), [ws, path])
  return { rows: useMemo(() => rowsByRef(list), [list]), want }
}

export interface ReaderLabels {
  path: string
  /** the labels that are on and mark spans or records on this file, in the order they were turned on */
  on: Concept[]
  /** every label over files that is on, in the order they were turned on: a column each in a record's gutter */
  lanes?: Concept[]
  /** the label whose texts are filled; the others' are underlined */
  focus?: string | null
  /** a label over files' value counts on this file, which each of its records carries */
  fileOf?: (conceptId: string) => Readonly<Record<string, number>> | undefined
  rows: Map<string, Map<string, LabelRow>>
  want: (line: number) => void
}

export const ReaderLabelsContext = createContext<ReaderLabels | null>(null)

export function useReaderLabels(ws: string, path: string, on: Concept[], lanes?: Concept[], focus?: string | null, fileOf?: ReaderLabels['fileOf']): ReaderLabels {
  const { rows, want } = usePathLabels(ws, path)
  return useMemo(() => ({ path, on, lanes, focus, fileOf, rows, want }), [path, on, lanes, focus, fileOf, rows, want])
}

/** A record's marks and its gutter's cells (none while no label is on). */
export type MarksAt = RecordMarks & { cells: LaneCell[] }

const NO_CELLS: LaneCell[] = []
const NONE: MarksAt = { spans: [], lit: [], cells: NO_CELLS }
const noFile = () => undefined

/** The marks of the record at `line`; mounting a record asks for its block of labels. */
export function useMarksAt(path: string, line: number): MarksAt {
  const ctx = useContext(ReaderLabelsContext)
  const want = ctx?.want
  useEffect(() => {
    if (line >= 1) want?.(line)
  }, [want, line])
  return useMemo(() => {
    if (!ctx) return NONE
    const mine = ctx.rows.get(`${path}#L${line}`)
    const rowOf = (id: string) => mine?.get(id)
    const cells = ctx.lanes?.length ? laneCells(ctx.lanes, rowOf, ctx.fileOf ?? noFile) : NO_CELLS
    if (!ctx.on.length || !mine) return cells === NO_CELLS ? NONE : { ...NONE, cells }
    return { ...recordMarks(ctx.on, rowOf, ctx.focus), cells }
  }, [ctx, path, line])
}
