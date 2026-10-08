// Filter by in Files' Transcript mode, beside Color by (FilterBy.tsx), as the view kit's Filter by
// (backend/app/viewer_controls.js thimble.filterBy): which records show, by a key of the records (the keys Color by
// offers, GET /source/keys) or a label over files that marks the file and is on. The choice's values are toggles; a
// record whose value is off has no row (views/common RecordCard), unless a ref points at it, and a long run of them
// says in one line how many it hides (views/transcript HiddenRun). The choice and the values turned off are kept per
// file in this browser. Only Color by draws in color: the toggles are words. Pure, but for the hook and the storage.
import { createContext, useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import { bus } from '../lib/bus'
import type { Concept, LabelRow, SourceKey, SourceKeys, SourceRecord } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { chipOfLabel, choiceId, keyValue, labelChips, NONE, OTHER, parseChoice, type ColorChoice, type ColorValue } from './colorChoice'
import type { FilesLabels } from './useLabels'

/** What the reader keeps of Filter by per file: the choice (null for None), and per choice the values turned off. */
export interface FilterKept {
  by: string | null
  off: Record<string, string[]>
}

export const filterKey = (ws: string, path: string): string => storageKey(ws, `filterBy:${path}`)

export function readFilter(ws: string, path: string): FilterKept {
  const got = readStorage<Partial<FilterKept> | null>(filterKey(ws, path), null)
  const off: Record<string, string[]> = {}
  if (got?.off && typeof got.off === 'object') for (const [k, v] of Object.entries(got.off)) if (Array.isArray(v)) off[k] = v.filter((x) => typeof x === 'string')
  return { by: typeof got?.by === 'string' ? got.by : null, off }
}

/** A key's toggles: each value the server lists, the commonest first, then Other for the values it does not list, then
 * the records with none. Words only: no color. Pure. */
export function filterKeyValues(k: SourceKey): ColorValue[] {
  const out: ColorValue[] = k.values.map((v) => ({ id: v.value, name: v.value, n: v.n, color: null }))
  if (k.more.values) out.push({ id: OTHER, name: 'Other', n: k.more.n, color: null })
  if (k.none > 0) out.push({ id: NONE, name: `No ${k.key}`, n: k.none, color: null })
  return out
}

/** The toggle a record's value of a key falls under: the value when the server lists it, else Other, NONE for none.
 * Pure. */
export function filterValueOf(k: SourceKey, value: string | null): string {
  if (value == null) return NONE
  return k.values.some((v) => v.value === value) ? value : OTHER
}

/** The lines of `records` whose value is turned off: by a key's value, or a label's highlighted value (NONE for a
 * record it does not mark). Pure. */
export function filteredLines(records: readonly SourceRecord[], valueOf: (rec: SourceRecord) => string | undefined, off: readonly string[]): Set<number> {
  const out = new Set<number>()
  if (!off.length) return out
  const offSet = new Set(off)
  for (const rec of records) {
    const v = valueOf(rec)
    if (v != null && offSet.has(v)) out.add(rec.line)
  }
  return out
}

/** What Filter by tells the Transcript mode's records: whether it hides the one on a line, and Show, which turns every
 * value back on. Null while it hides none. */
export interface FilterVerdict {
  hides: (line: number) => boolean
  show: () => void
}

export const FilterContext = createContext<FilterVerdict | null>(null)

export interface FilterBy {
  /** the choice: `off` for None */
  choice: ColorChoice
  values: ColorValue[]
  off: string[]
  choose: (c: ColorChoice) => void
  toggle: (value: string, alone: boolean) => void
  /** what the records hear: null while no record loaded is hidden */
  verdict: FilterVerdict | null
}

/** Filter by's state for one file. `fileLabels` are the labels over files that mark it (Color by's); `keys` the file's
 * keys (Color by's, asked once); `quiet` the labels Filter by turns on, which Color by then leaves to it. */
export function useFilterBy(ws: string, path: string, on: boolean, labels: FilesLabels, fileLabels: readonly Concept[], keys: SourceKeys | null, records: readonly SourceRecord[], rows: ReadonlyMap<string, ReadonlyMap<string, LabelRow>>, total: number | null, quiet: RefObject<Set<string>>): FilterBy {
  const [state, setState] = useState<{ at: string; kept: FilterKept }>(() => ({ at: `${ws}\n${path}`, kept: readFilter(ws, path) }))
  const at = `${ws}\n${path}`
  const kept = state.at === at ? state.kept : readFilter(ws, path)
  if (state.at !== at) setState({ at, kept })
  const keep = useCallback(
    (next: FilterKept) => {
      setState({ at, kept: next })
      writeStorage(filterKey(ws, path), next)
    },
    [ws, path, at],
  )
  const onIds = useMemo(() => new Set(labels.on.map((k) => k.id)), [labels.on])
  // the choice kept, while it still stands (its key is the file's, its label marks the file and is on), else None
  const choice = useMemo<ColorChoice>(() => {
    const c = parseChoice(kept.by)
    if (c?.by === 'label' && onIds.has(c.id) && fileLabels.some((k) => k.id === c.id)) return c
    if (c?.by === 'key' && keys?.keys.some((k) => k.key === c.key)) return c
    return { by: 'off' }
  }, [kept.by, onIds, fileLabels, keys])
  // a label deleted while the file is filtered by it leaves Filter by at None
  useEffect(() => bus.on('concepts', (e) => e.what === 'deleted' && kept.by === `l:${e.concept}` && keep({ ...kept, by: null })), [kept, keep])
  const id = choiceId(choice)
  const off = useMemo(() => kept.off[id] ?? [], [kept.off, id])
  const key = choice.by === 'key' ? keys?.keys.find((k) => k.key === choice.key) : undefined
  const label = choice.by === 'label' ? labels.byId.get(choice.id) : undefined
  const values = useMemo<ColorValue[]>(() => (key ? filterKeyValues(key) : label ? labelChips(label, labels.presence.get(label.id)?.[path], total).map((v) => ({ ...v, color: null })) : []), [key, label, labels.presence, path, total])
  const valueOf = useCallback(
    (rec: SourceRecord): string | undefined => {
      if (key) return filterValueOf(key, keyValue(rec, key.key))
      if (label) return chipOfLabel(label, rows.get(`${path}#L${rec.line}`)?.get(label.id), true)
      return undefined
    },
    [key, label, rows, path],
  )
  const hidden = useMemo(() => (on && (key || label) ? filteredLines(records, valueOf, off) : new Set<number>()), [on, key, label, records, valueOf, off])
  const { toggle: toggleLabel } = labels
  const choose = useCallback(
    (c: ColorChoice) => {
      // a label chosen while it is off is turned on, so that its values reach the records; Color by keeps its choice
      if (c.by === 'label' && !onIds.has(c.id)) {
        quiet.current?.add(c.id)
        toggleLabel(c.id)
      }
      keep({ ...kept, by: c.by === 'off' ? null : choiceId(c) })
    },
    [onIds, quiet, toggleLabel, keep, kept],
  )
  const toggle = useCallback(
    (value: string, alone: boolean) => {
      const all = values.map((v) => v.id)
      const now = new Set(off)
      let next: string[]
      if (alone) next = now.size === all.length - 1 && !now.has(value) ? [] : all.filter((v) => v !== value)
      else next = now.has(value) ? off.filter((v) => v !== value) : [...off, value]
      keep({ ...kept, off: { ...kept.off, [id]: next } })
    },
    [values, off, keep, kept, id],
  )
  const show = useCallback(() => keep({ ...kept, off: { ...kept.off, [id]: [] } }), [keep, kept, id])
  const verdict = useMemo<FilterVerdict | null>(() => (hidden.size ? { hides: (line: number) => hidden.has(line), show } : null), [hidden, show])
  return { choice, values, off, choose, toggle, verdict }
}
