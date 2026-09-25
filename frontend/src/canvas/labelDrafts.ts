// A label's unrun edits made in the popover of its tag on a card, per workspace and label. They live here so they
// outlast the popover and every card using the label shows its tag red until they are run or discarded. A reload drops
// them.
import { useSyncExternalStore } from 'react'
import { editsOf, type Draft } from '../files/LabelCard'
import type { Cell, Concept } from '../lib/types'

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()
let version = 0

const key = (ws: string, id: string) => `${ws}\n${id}`

export function labelDraft(ws: string, id: string): Draft | null {
  return drafts.get(key(ws, id)) ?? null
}

/** Keep `draft` as the label's edits, or with null drop them. */
export function setLabelDraft(ws: string, id: string, draft: Draft | null): void {
  if (draft) drafts.set(key(ws, id), draft)
  else if (!drafts.delete(key(ws, id))) return
  version++
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Re-render on every change to the drafts; returns a count that steps with each. */
export function useLabelDrafts(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** The labels card `cell` uses that have edits not run yet, by id, each with what the edits change in words (editsOf).
 * A draft that changes nothing a card reads (an empty class row) is no edit. */
export function editedLabels(ws: string, cell: Pick<Cell, 'labels'>, concepts: ReadonlyMap<string, Concept>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const id of cell.labels ?? []) {
    const d = labelDraft(ws, id)
    const k = concepts.get(id)
    const edits = d && k ? editsOf(k, d) : []
    if (edits.length) out.set(id, edits)
  }
  return out
}
