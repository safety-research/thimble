// Whether a path a chip names is a folder or a file, for the glyph of a folder named with no slash after it
// (components/RefChip): the server stats it (GET /corpora/{c}/sources/kinds), once per workspace and path, the chips
// that draw together asking in one request, so the chip shows the folder glyph as the chat draws it.
import { scaleApi } from './api'

export type PathKind = 'folder' | 'file' | null

const known = new Map<string, PathKind>()
const asked = new Set<string>()
const waiting = new Map<string, Set<string>>()
const listeners = new Set<() => void>()
let flushing = false

const key = (ws: string, path: string) => `${ws}\u0000${path}`

/** What `path` names in workspace `ws`, once the server said; undefined until then. */
export function pathKind(ws: string, path: string): PathKind | undefined {
  return known.get(key(ws, path))
}

/** Ask the server what `path` names, with the other paths asked in the same tick, once per workspace and path. */
export function ensurePathKind(ws: string, path: string): void {
  if (!ws || !path || asked.has(key(ws, path))) return
  asked.add(key(ws, path))
  const paths = waiting.get(ws) ?? new Set<string>()
  paths.add(path)
  waiting.set(ws, paths)
  if (flushing) return
  flushing = true
  queueMicrotask(() => {
    flushing = false
    const batch = [...waiting]
    waiting.clear()
    for (const [w, ps] of batch) void ask(w, [...ps])
  })
}

async function ask(ws: string, paths: string[]): Promise<void> {
  try {
    const { kinds } = await scaleApi.pathKinds(ws, paths)
    for (const p of paths) known.set(key(ws, p), kinds[p] ?? null)
  } catch {
    for (const p of paths) asked.delete(key(ws, p)) // a later chip asks again
    return
  }
  for (const fn of listeners) fn()
}

/** Redraw `fn` when a path's kind becomes known. */
export function onPathKinds(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
