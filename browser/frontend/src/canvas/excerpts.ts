// One shared cache of resolved refs per workspace (GET /corpora/{c}/ref): a ref is resolved once, and a failed read
// reads as null (its excerpt as '').
import { api } from '../lib/api'
import type { ResolvedRef } from '../lib/types'

const resolved = new Map<string, Promise<ResolvedRef | null>>()

export const resolvedOf = (ws: string, ref: string): Promise<ResolvedRef | null> => {
  const key = `${ws}\u0000${ref}`
  let p = resolved.get(key)
  if (!p) {
    p = api.resolveRef(ws, ref).catch(() => null)
    resolved.set(key, p)
  }
  return p
}

export const excerptOf = (ws: string, ref: string): Promise<string> => resolvedOf(ws, ref).then((r) => (r?.excerpt ?? '').trim())

/** The excerpt cut for a card: `max` chars and an ellipsis. */
export const cutExcerpt = (t: string, max: number): string => (t.length > max ? t.slice(0, max) + '…' : t)
