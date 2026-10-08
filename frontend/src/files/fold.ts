// Folding the records of Files' Transcript mode (views/common RecordCard): a record folds to one line, its head and the
// start of its words or its tool call, as a row of the Table mode reads, and opens again. Collapse all and Expand all in
// the mode's top row fold or open every record; until one is chosen, a tool call, a tool result, a system record and
// any record longer than FOLD_LINES lines (a long line counting as the lines it wraps to) start folded. The choice and
// the records folded or opened one by one since are kept per file in this browser. Pure, but for the hook and the
// storage.
import { createContext, useCallback, useMemo, useState } from 'react'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'

/** how the records start: as each one's default (`auto`), all folded, or all open */
export type FoldAll = 'auto' | 'fold' | 'open'

/** What the reader keeps per file: the choice of the top row, and the lines folded or opened one by one since. */
export interface FoldKept {
  all: FoldAll
  /** line -> folded, for the records whose state differs from what the choice gives them */
  own: Record<string, boolean>
}

/** records folded or opened one by one that the reader keeps per file, the oldest let go first */
export const OWN_MAX = 2000

export const foldKey = (ws: string, path: string): string => storageKey(ws, `fold:${path}`)

export function readFold(ws: string, path: string): FoldKept {
  const got = readStorage<Partial<FoldKept> | null>(foldKey(ws, path), null)
  const all: FoldAll = got?.all === 'fold' || got?.all === 'open' ? got.all : 'auto'
  const own: Record<string, boolean> = {}
  if (got?.own && typeof got.own === 'object') for (const [k, v] of Object.entries(got.own)) if (typeof v === 'boolean' && /^\d+$/.test(k)) own[k] = v
  return { all, own }
}

/** Whether a record starts folded under the choice `all`, `dflt` its own default. Pure. */
export const foldedBy = (all: FoldAll, dflt: boolean): boolean => (all === 'fold' ? true : all === 'open' ? false : dflt)

/** The kept state with the record on `line` folded or opened: kept as its own only while that differs from what the
 * choice gives it, at most OWN_MAX of them. Pure. */
export function withOwn(kept: FoldKept, line: number, folded: boolean, dflt: boolean): FoldKept {
  const own = { ...kept.own }
  delete own[line]
  if (folded !== foldedBy(kept.all, dflt)) own[line] = folded
  const keys = Object.keys(own)
  // insertion order is the order they were set, but for integer keys, which objects list in numeric order: past the
  // cap, the lines furthest from this one go first
  if (keys.length > OWN_MAX)
    keys
      .sort((a, b) => Math.abs(Number(b) - line) - Math.abs(Number(a) - line))
      .slice(0, keys.length - OWN_MAX)
      .forEach((k) => delete own[k])
  return { ...kept, own }
}

export interface Fold {
  all: FoldAll
  /** whether the record on `line` shows folded, `dflt` its default */
  folded: (line: number, dflt: boolean) => boolean
  /** fold or open the record on `line` */
  set: (line: number, folded: boolean, dflt: boolean) => void
  /** fold or open every record, forgetting those set one by one */
  setAll: (all: 'fold' | 'open') => void
}

/** The fold of the records the Transcript mode shows; null outside it, where each record keeps its own. */
export const FoldContext = createContext<Fold | null>(null)

export function useFold(ws: string, path: string): Fold {
  const [state, setState] = useState<{ at: string; kept: FoldKept }>(() => ({ at: `${ws}\n${path}`, kept: readFold(ws, path) }))
  const at = `${ws}\n${path}`
  // another file read its own
  const kept = state.at === at ? state.kept : readFold(ws, path)
  if (state.at !== at) setState({ at, kept })
  const keep = useCallback(
    (next: (k: FoldKept) => FoldKept) =>
      setState((s) => {
        const k = next(s.at === at ? s.kept : readFold(ws, path))
        writeStorage(foldKey(ws, path), k)
        return { at, kept: k }
      }),
    [ws, path, at],
  )
  const folded = useCallback((line: number, dflt: boolean) => kept.own[line] ?? foldedBy(kept.all, dflt), [kept])
  const set = useCallback((line: number, f: boolean, dflt: boolean) => keep((k) => withOwn(k, line, f, dflt)), [keep])
  const setAll = useCallback((all: 'fold' | 'open') => keep(() => ({ all, own: {} })), [keep])
  return useMemo(() => ({ all: kept.all, folded, set, setAll }), [kept.all, folded, set, setAll])
}
