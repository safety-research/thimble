// A cell's display name for chips: its title reduced to a slug, never its id. The canvas registers the cells it
// loads; a chip for an unregistered cell asks for the names once.
import { api } from './api'

export interface NamedCell {
  id: string
  title?: string
  slug?: string | null
}

const STOP = new Set(['how', 'what', 'which', 'when', 'where', 'why', 'who', 'do', 'does', 'did', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are', 'was', 'were', 'by', 'per', 'each', 'with', 'from', 'at', 'as', 'that', 'this', 'these', 'those', 'many', 'much'])

/** "How do the 16 runs compare in size" -> "runs-compare-size". */
export function slugFromTitle(t: string): string {
  const words = (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
  return words.slice(0, 3).join('-').replace(/-{2,}/g, '-').slice(0, 28).replace(/-+$/, '')
}

export function displayName(c: NamedCell): string {
  return (c.slug ?? '').trim() || slugFromTitle(c.title ?? '') || 'card'
}

const registry = new Map<string, NamedCell>()
const listeners = new Set<() => void>()

export function registerCells(cells: NamedCell[]): void {
  for (const c of cells) registry.set(c.id, { id: c.id, title: c.title, slug: c.slug })
  for (const fn of listeners) fn()
}

export function cellLabel(id: string): string | undefined {
  const c = registry.get(id)
  return c ? displayName(c) : undefined
}

export const hasCellName = (id: string): boolean => registry.has(id)

// A label's name for `concept:` chips, kept beside the cell names so one subscription redraws both.
const concepts = new Map<string, string>()

export function registerConcepts(rows: { id: string; name?: string }[]): void {
  for (const k of rows) if (k.name) concepts.set(k.id, k.name)
  for (const fn of listeners) fn()
}

export const conceptLabel = (id: string): string | undefined => concepts.get(id)
export const hasConceptName = (id: string): boolean => concepts.has(id)

const conceptsInflight = new Map<string, Promise<void>>()

/** Read the workspace's labels once per burst when a chip's concept is unknown. */
export function ensureConceptName(ws: string, id: string): Promise<void> {
  if (!ws || !id || concepts.has(id)) return Promise.resolve()
  let p = conceptsInflight.get(ws)
  if (!p) {
    p = api
      .concepts(ws)
      .then((rows) => registerConcepts(rows.map((k) => ({ id: k.id, name: k.name }))))
      .catch(() => undefined)
      .finally(() => conceptsInflight.delete(ws))
    conceptsInflight.set(ws, p)
  }
  return p
}

export function onCellNames(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const inflight = new Map<string, Promise<void>>()

/** Read the workspace's cell names once per burst when a chip's cell is unknown. */
export function ensureCellName(ws: string, id: string): Promise<void> {
  if (!ws || !id || registry.has(id)) return Promise.resolve()
  let p = inflight.get(ws)
  if (!p) {
    p = api
      .cellNames(ws)
      .then((rows) => registerCells(rows.map((r) => ({ id: r.id, title: r.title, slug: r.slug }))))
      .catch(() => undefined)
      .finally(() => inflight.delete(ws))
    inflight.set(ws, p)
  }
  return p
}
