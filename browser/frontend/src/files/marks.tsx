// The labels a file's records carry in the reader, for the labels that are on: a gutter cell per label (labels.ts
// laneCells), a span label's texts highlighted in place, or a tint (labels.ts recordMarks). Each record asks for its
// line (`want`) and the hook fetches the LABEL_BLOCK-line block that holds it, so a large labelled file costs one page
// of rows per page shown. A record that is no line (a database row, a PDF page, a JSON value, a CSV row), and any record
// a view's page shows, is asked for by its ref instead (POST /labels/refs). What is asked for in one turn goes out
// together: a file's blocks BLOCKS_PER_ASK to a request (GET /labels?path=&lines=a-b,c-d,...), refs REFS_PER_ASK to one,
// never more than ASKS_IN_FLIGHT requests at once, and what records in view want (`soon`) before the rest. Cached per
// path; a bus `concepts` event that changed rows re-reads the shown blocks and refs and swaps them in once all have
// arrived. Provided through a context; a custom view's frame reads the same cache through watchPathLabels, wantLabels
// and wantRecordLabels.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { scaleApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { Concept, LabelRow, LabelsForPath } from '../lib/types'
import { recordKey, recordOf } from '../lib/refs'
import { laneCells, recordMarks, type LaneCell, type LaneValue, type RecordMarks } from './labels'

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

/** Every label's row per record ref: ref (recordKey) -> concept id -> the row. A row of a record that starts on a line
 * of its file without naming it (a CSV row, a JSON document's record: `line`) is found at that line's ref as well,
 * where the reader's line views look for it, unless a row of that line's own is there. */
export function rowsByRef(list: LabelsForPath[]): Map<string, Map<string, LabelRow>> {
  const out = new Map<string, Map<string, LabelRow>>()
  const at = (ref: string) => {
    let m = out.get(ref)
    if (!m) out.set(ref, (m = new Map()))
    return m
  }
  const aliases: [string, string, LabelRow][] = []
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.rows)) continue
    for (const row of entry.rows) {
      if (!row || typeof row.ref !== 'string') continue
      const ref = recordKey(row.ref)
      const m = at(ref)
      if (!m.has(entry.concept_id)) m.set(entry.concept_id, row)
      const file = typeof row.line === 'number' && row.line >= 1 ? recordOf(ref) : null
      if (file && file.line == null) aliases.push([`${file.path}#L${row.line}`, entry.concept_id, row])
    }
  }
  for (const [ref, concept, row] of aliases) {
    const m = at(ref)
    if (!m.has(concept)) m.set(concept, row)
  }
  return out
}

interface PathLabels {
  list: LabelsForPath[]
  /** blocks fetched, in flight or waiting to be asked for */
  blocks: Set<number>
  /** the refs of records asked for by ref (wantRecordLabels), fetched, in flight or waiting */
  refs: Set<string>
  /** the blocks and the refs whose labels have arrived at least once */
  arrived: Set<number>
  arrivedRefs: Set<string>
  listeners: Set<(list: LabelsForPath[]) => void>
  /** bumped when the cache is dropped, so an answer in flight for the old contents is ignored */
  gen: number
  /** after a drop, while the blocks and refs that had arrived are read again: the new answers so far and those still
   * to come; `list` keeps the old contents until none are left, and takes the rows of the others as they arrive */
  next: { list: LabelsForPath[]; waiting: Set<number | string> } | null
}

const cache = new Map<string, PathLabels>()
const cacheKey = (ws: string, path: string) => `${ws}|${path}`

function entry(key: string): PathLabels {
  let e = cache.get(key)
  if (!e) {
    e = { list: [], blocks: new Set(), refs: new Set(), arrived: new Set(), arrivedRefs: new Set(), listeners: new Set(), gen: 0, next: null }
    cache.set(key, e)
  }
  return e
}

function notify(e: PathLabels): void {
  for (const fn of e.listeners) fn(e.list)
}

/** `more`, the answer for `tokens` (blocks, and refs by their key), merged into the path's labels: at once, or while
 * the labels that had arrived are read again (invalidate) into the new contents, which replace the old once the last
 * of them is in; an answer for blocks or refs read for the first time shows at once either way. */
function settle(e: PathLabels, more: LabelsForPath[], tokens: readonly (number | string)[]): void {
  const next = e.next
  if (!next) {
    e.list = mergeLabels(e.list, more)
    return notify(e)
  }
  next.list = mergeLabels(next.list, more)
  let fresh = false
  for (const t of tokens) if (!next.waiting.delete(t)) fresh = true
  if (!next.waiting.size) {
    e.list = next.list
    e.next = null
    return notify(e)
  }
  if (fresh && more.length) {
    e.list = mergeLabels(e.list, more)
    notify(e)
  }
}

/** blocks one request asks for at most (LABEL_BLOCK lines each) */
export const BLOCKS_PER_ASK = 32
/** records asked for by ref in one request at most */
export const REFS_PER_ASK = 1000
/** labels requests in flight at once, over every file, reader and view: a browser refuses a page that opens too many */
export const ASKS_IN_FLIGHT = 4
/** times a block's or a ref's request is sent before it is left for the next record that asks */
const ASK_TRIES = 3
const RETRY_MS = 1500

interface Wanted {
  soon: boolean
  tries: number
}

/** The blocks asked for and not yet requested, per path. */
const waitingBlocks = new Map<string, { ws: string; path: string; blocks: Map<number, Wanted> }>()
/** The refs asked for and not yet requested, per workspace, then per path. */
const waitingRefs = new Map<string, Map<string, Map<string, Wanted>>>()

let inFlight = 0
let pumpTimer: ReturnType<typeof setTimeout> | null = null

function schedulePump(): void {
  if (pumpTimer == null) pumpTimer = setTimeout(pump, 0)
}

/** `blocks` as ascending line spans, the blocks next to each other in one span. Pure. */
export function blockSpans(blocks: readonly number[]): [number, number][] {
  const out: [number, number][] = []
  for (const b of [...blocks].sort((x, y) => x - y)) {
    const [a, z] = blockRange(b)
    const last = out[out.length - 1]
    if (last && last[1] + 1 === a) last[1] = z
    else out.push([a, z])
  }
  return out
}

function want(held: Map<string | number, Wanted>, key: string | number, soon: boolean, tries = 0): void {
  const w = held.get(key)
  if (w) w.soon ||= soon
  else held.set(key, { soon, tries })
}

function fetchBlock(ws: string, path: string, block: number, soon = false): void {
  const key = cacheKey(ws, path)
  const e = entry(key)
  let w = waitingBlocks.get(key)
  if (e.blocks.has(block)) {
    const held = w?.blocks.get(block)
    if (soon && held) held.soon = true
    return
  }
  e.blocks.add(block)
  if (e.next && e.arrived.has(block)) e.next.waiting.add(block)
  if (!w) waitingBlocks.set(key, (w = { ws, path, blocks: new Map() }))
  want(w.blocks as Map<string | number, Wanted>, block, soon)
  schedulePump()
}

function fetchRefs(ws: string, path: string, refs: Iterable<string>, soon = false): void {
  const e = entry(cacheKey(ws, path))
  let byPath = waitingRefs.get(ws)
  let held = byPath?.get(path)
  for (const ref of refs) {
    const key = recordKey(ref)
    if (e.refs.has(key)) {
      const w = held?.get(key)
      if (soon && w) w.soon = true
      continue
    }
    // a line whose block is read already, or on its way, has its labels from there
    const line = recordOf(key)?.line
    if (line != null && e.blocks.has(blockOf(line))) continue
    e.refs.add(key)
    if (e.next && e.arrivedRefs.has(key)) e.next.waiting.add(key)
    if (!byPath) waitingRefs.set(ws, (byPath = new Map()))
    if (!held) byPath.set(path, (held = new Map()))
    want(held as Map<string | number, Wanted>, key, soon)
  }
  if (held?.size) schedulePump()
}

/** The next path's blocks to ask for, BLOCKS_PER_ASK at most, in file order, taken off the waiting ones: with
 * `soonOnly` only blocks wanted soon, so the records in view do not wait behind the rest. */
function takeBlocks(soonOnly: boolean): { ws: string; path: string; blocks: [number, Wanted][] } | null {
  for (const [key, w] of waitingBlocks) {
    const picked = [...w.blocks]
      .filter(([, b]) => !soonOnly || b.soon)
      .sort(([n], [m]) => n - m)
      .slice(0, BLOCKS_PER_ASK)
    if (!picked.length) {
      if (!w.blocks.size) waitingBlocks.delete(key)
      continue
    }
    for (const [n] of picked) w.blocks.delete(n)
    if (!w.blocks.size) waitingBlocks.delete(key)
    return { ws: w.ws, path: w.path, blocks: picked }
  }
  return null
}

/** The next workspace's refs to ask for, REFS_PER_ASK at most over its paths, taken off the waiting ones: with
 * `soonOnly` only refs wanted soon. */
function takeRefs(soonOnly: boolean): { ws: string; refs: [string, string, Wanted][] } | null {
  for (const [ws, byPath] of waitingRefs) {
    const picked: [string, string, Wanted][] = []
    for (const [path, held] of byPath) {
      for (const [ref, w] of held) {
        if (picked.length >= REFS_PER_ASK) break
        if (soonOnly && !w.soon) continue
        picked.push([path, ref, w])
        held.delete(ref)
      }
      if (!held.size) byPath.delete(path)
    }
    if (!byPath.size) waitingRefs.delete(ws)
    if (picked.length) return { ws, refs: picked }
  }
  return null
}

function askBlocks({ ws, path, blocks }: NonNullable<ReturnType<typeof takeBlocks>>): void {
  const key = cacheKey(ws, path)
  const e = entry(key)
  const gen = e.gen
  const numbers = blocks.map(([n]) => n)
  inFlight += 1
  scaleApi
    .labelsForSpans(ws, path, blockSpans(numbers).map(([a, b]) => `${a}-${b}`).join(','))
    .then((more) => {
      if (e.gen !== gen) return
      for (const n of numbers) e.arrived.add(n)
      settle(e, more, numbers)
    })
    .catch(() => {
      // labels are a convenience: the file reads without them; a block is asked again a few times, then left for the
      // next record that asks
      if (e.gen !== gen) return
      const again = blocks.filter(([, w]) => w.tries + 1 < ASK_TRIES)
      const dropped = numbers.filter((n) => !again.some(([m]) => m === n))
      for (const n of dropped) e.blocks.delete(n)
      if (e.next) settle(e, [], dropped)
      if (!again.length) return
      setTimeout(() => {
        if (e.gen !== gen) return
        let w = waitingBlocks.get(key)
        if (!w) waitingBlocks.set(key, (w = { ws, path, blocks: new Map() }))
        for (const [n, b] of again) want(w.blocks as Map<string | number, Wanted>, n, b.soon, b.tries + 1)
        schedulePump()
      }, RETRY_MS)
    })
    .finally(() => {
      inFlight -= 1
      schedulePump()
    })
}

function askRefs({ ws, refs }: NonNullable<ReturnType<typeof takeRefs>>): void {
  const byPath = new Map<string, { e: PathLabels; gen: number; refs: [string, Wanted][] }>()
  for (const [path, ref, w] of refs) {
    let t = byPath.get(path)
    if (!t) {
      const e = entry(cacheKey(ws, path))
      byPath.set(path, (t = { e, gen: e.gen, refs: [] }))
    }
    t.refs.push([ref, w])
  }
  inFlight += 1
  scaleApi
    .labelsForRefs(ws, refs.map(([, ref]) => ref))
    .then((list) => {
      for (const [path, t] of byPath) {
        if (t.e.gen !== t.gen) continue
        const mine = list.map((l) => ({ ...l, rows: l.rows.filter((r) => recordOf(r.ref)?.path === path) })).filter((l) => l.rows.length)
        const keys = t.refs.map(([ref]) => ref)
        for (const k of keys) t.e.arrivedRefs.add(k)
        settle(t.e, mine, keys)
      }
    })
    .catch(() => {
      for (const [path, t] of byPath) {
        if (t.e.gen !== t.gen) continue
        const again = t.refs.filter(([, w]) => w.tries + 1 < ASK_TRIES)
        const dropped = t.refs.filter(([, w]) => w.tries + 1 >= ASK_TRIES).map(([ref]) => ref)
        for (const ref of dropped) t.e.refs.delete(ref)
        if (t.e.next) settle(t.e, [], dropped)
        if (!again.length) continue
        setTimeout(() => {
          if (t.e.gen !== t.gen) return
          let paths = waitingRefs.get(ws)
          if (!paths) waitingRefs.set(ws, (paths = new Map()))
          let held = paths.get(path)
          if (!held) paths.set(path, (held = new Map()))
          for (const [ref, w] of again) want(held as Map<string | number, Wanted>, ref, w.soon, w.tries + 1)
          schedulePump()
        }, RETRY_MS)
      }
    })
    .finally(() => {
      inFlight -= 1
      schedulePump()
    })
}

/** Send what is waiting while fewer than ASKS_IN_FLIGHT requests are out: what records in view want first (blocks,
 * then refs), then the other refs, then the other blocks. */
function pump(): void {
  pumpTimer = null
  while (inFlight < ASKS_IN_FLIGHT) {
    const blocksSoon = takeBlocks(true)
    if (blocksSoon) {
      askBlocks(blocksSoon)
      continue
    }
    const refs = takeRefs(true) ?? takeRefs(false)
    if (refs) {
      askRefs(refs)
      continue
    }
    const blocks = takeBlocks(false)
    if (!blocks) return
    askBlocks(blocks)
  }
}

/** Drop every path's labels; the paths shown read their blocks and refs again and keep the labels that had arrived
 * until those are all read again, so the marks change once. */
function invalidate(): void {
  for (const [key, e] of cache) {
    const blocks = [...e.blocks]
    const asked = [...e.refs]
    e.gen += 1
    e.blocks.clear()
    e.refs.clear()
    e.next = null
    const soonBlocks = new Set([...(waitingBlocks.get(key)?.blocks ?? [])].filter(([, w]) => w.soon).map(([n]) => n))
    waitingBlocks.delete(key)
    const [ws, ...rest] = key.split('|')
    const path = rest.join('|')
    const soon = new Set(asked.filter((r) => waitingRefs.get(ws)?.get(path)?.get(r)?.soon))
    waitingRefs.get(ws)?.delete(path)
    if (!e.listeners.size || (!blocks.length && !asked.length)) {
      e.list = []
      e.arrived.clear()
      e.arrivedRefs.clear()
      if (e.listeners.size) notify(e)
      continue
    }
    e.next = { list: [], waiting: new Set() }
    for (const b of blocks) fetchBlock(ws, path, b, soonBlocks.has(b))
    if (asked.length) {
      fetchRefs(ws, path, asked.filter((r) => soon.has(r)), true)
      fetchRefs(ws, path, asked)
    }
    if (!e.next.waiting.size) {
      e.next = null
      e.list = []
      notify(e)
    }
  }
}

let watchers = 0
let offConcepts: (() => void) | null = null

/** Keep the cache listening for `concepts` while anything reads it: one subscription however many readers and frames
 * are open, so an event drops the cache once and each shown block is read again once. Returns the release. */
function holdInvalidation(): () => void {
  if (watchers++ === 0) offConcepts = bus.on('concepts', (ev) => ev.rows !== false && invalidate())
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

/** Whether the labels of the record `ref` of `path` have arrived (wantLabels, wantRecordLabels); after a `concepts`
 * event the ones from before stand until they are read again. */
export function labelsArrived(ws: string, path: string, ref: string): boolean {
  const e = cache.get(cacheKey(ws, path))
  if (!e) return false
  if (e.arrivedRefs.has(recordKey(ref))) return true
  const at = recordOf(ref)
  return at?.line != null && e.arrived.has(blockOf(at.line))
}

/** Ask for the block of labels that holds `line` of `path`, once; the watchers of the path get it when it arrives.
 * `soon`, for a record in view, puts its block before those asked for without it, even when it was asked for already. */
export function wantLabels(ws: string, path: string, line: number, soon = false): void {
  fetchBlock(ws, path, blockOf(line), soon)
}

/** Ask for the labels of a record of `path` by its ref, once: a record that is no line (lib/refs recordOf), or a line
 * of a view's page, which asks for its records' rows alone rather than for the pages they fall on; the watchers of the
 * path get them when they arrive. `soon`, for a record in view, puts it before those asked for without it. */
export function wantRecordLabels(ws: string, path: string, ref: string, soon = false): void {
  fetchRefs(ws, path, [ref], soon)
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
  // a reader mounts the records it shows, so each asks for its block soon
  const want = useCallback((line: number) => fetchBlock(ws, path, blockOf(line), true), [ws, path])
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

/** The marks of the records from `line` to `end` as one: each label's cell holds the classes any of them has, and the
 * tint is the first one's that has one. A card that stands for several records (a chat turn) shows a label on any of
 * them this way. */
export function useMarksOver(path: string, line: number, end: number): MarksAt {
  const ctx = useContext(ReaderLabelsContext)
  const want = ctx?.want
  useEffect(() => {
    if (line < 1) return
    for (let b = blockOf(line); b <= blockOf(Math.max(line, end)); b++) want?.(b * LABEL_BLOCK + 1)
  }, [want, line, end])
  return useMemo(() => {
    if (!ctx) return NONE
    const all: MarksAt[] = []
    for (let n = line; n <= Math.max(line, end); n++) {
      const mine = ctx.rows.get(`${path}#L${n}`)
      const rowOf = (id: string) => mine?.get(id)
      const cells = ctx.lanes?.length ? laneCells(ctx.lanes, rowOf, ctx.fileOf ?? noFile) : NO_CELLS
      all.push(!ctx.on.length || !mine ? (cells === NO_CELLS ? NONE : { ...NONE, cells }) : { ...recordMarks(ctx.on, rowOf, ctx.focus), cells })
    }
    if (all.length === 1) return all[0]
    const cells = all[0].cells.map((c, i) => {
      const values = new Map<string, LaneValue>()
      for (const m of all) for (const v of m.cells[i]?.values ?? []) if (!values.has(v.value)) values.set(v.value, v)
      return { ...c, values: [...values.values()] }
    })
    return { spans: all[0].spans, lit: all.flatMap((m) => m.lit), cells, bar: all.find((m) => m.bar)?.bar, tint: all.find((m) => m.tint)?.tint }
  }, [ctx, path, line, end])
}

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
