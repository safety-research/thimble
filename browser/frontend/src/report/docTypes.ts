// The workspace's document types as the server lists them (GET …/investigations/main/types): which documents are
// written and what each type is named, for what names a document or lists the documents outside the Report tab (a
// document's chip in the chat, chat/SurfaceChips.tsx; the checks' runs in the top bar's Comments,
// shell/LabelsSidebar.tsx). One read per workspace serves every reader. While a workspace has readers, each `report`
// stream event reads it again; the first reader after none reads it again too, since no event was heard meanwhile.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { TypesState } from '../lib/types'

const cache = new Map<string, TypesState | null>()
const loading = new Set<string>()
// the workspaces a `report` event came for while their read went: read again when it ends
const again = new Set<string>()
const listeners = new Set<() => void>()
// per workspace, its readers and the end of its stream subscription
const readers = new Map<string, { n: number; off: () => void }>()

function load(ws: string): void {
  if (loading.has(ws)) {
    again.add(ws)
    return
  }
  loading.add(ws)
  docsApi
    .types(ws)
    .then((s) => cache.set(ws, s))
    .catch(() => cache.set(ws, cache.get(ws) ?? null))
    .finally(() => {
      loading.delete(ws)
      listeners.forEach((fn) => fn())
      if (again.delete(ws)) load(ws)
    })
}

/** A reader of workspace `ws`'s types; what it returns lets go. */
function hold(ws: string): () => void {
  const held = readers.get(ws)
  if (held) held.n += 1
  else {
    readers.set(ws, { n: 1, off: bus.on('report', () => load(ws)) })
    load(ws)
  }
  return () => {
    const now = readers.get(ws)
    if (!now || --now.n > 0) return
    now.off()
    readers.delete(ws)
  }
}

/** The document types of workspace `ws`, null until the server answered. With `read` false nothing is read for this
 * reader, which then gets what another reader read. */
export function useDocTypes(ws: string, read = true): TypesState | null {
  const sub = useCallback((fn: () => void) => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  }, [])
  const state = useSyncExternalStore(
    sub,
    () => cache.get(ws) ?? null,
    () => null,
  )
  useEffect(() => (read && ws ? hold(ws) : undefined), [ws, read])
  return state
}

/** The written documents of a types list, in its order (the type bar's). Pure. */
export const writtenDocs = (types: TypesState): string[] => Object.keys(types).filter((slug) => types[slug]?.exists)
