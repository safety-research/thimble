// File viewers in the File browser: the views whose unit is "file", or with no unit whose claims are all extension
// globs (backend views.file_type_viewer), are modes of the files they claim. When a file whose best built-in mode is Raw
// opens and no viewer claims it, thimble is asked once per type and page whether a viewer would help (backend
// views.suggest); a view proposal it writes shows on the card above the chat's composer, as every view proposal does
// (chat/ProposalCard).
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { View } from '../lib/types'
import { viewsForFile } from '../lib/views'

const TYPE_GLOB = /^(?:\*\*\/)?\*(\.[A-Za-z0-9_+-]{1,16})$/

/** The suffix a claim names when it is one extension's glob, such as `*.vtt`, lower-cased; null otherwise (backend
 * views.type_suffix). */
export function typeSuffix(glob: string): string | null {
  const m = TYPE_GLOB.exec(glob.trim())
  return m ? m[1].toLowerCase() : null
}

/** A path's suffix, lower-cased with its dot, or '' when its name has none. */
export function suffixOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** The types this page has asked about, as `<workspace>:<suffix>`. */
const asked = new Set<string>()

/** Ask once per page whether a viewer would help for the type of `path` (POST /views/suggest). The answer is not read:
 * a view proposal comes to the card above the chat's composer through the stream's `view {status: suggested}`. True
 * when it asked now. */
export function suggestOnce(ws: string, path: string): boolean {
  const key = `${ws}:${suffixOf(path)}`
  if (asked.has(key)) return false
  asked.add(key)
  void api.suggestView(ws, path).catch(() => undefined)
  return true
}

/**
 * The working file-type viewers of `path`, read again on each `view` event while `on`. While `offer` holds (the file's
 * best built-in mode is Raw) and the read found no viewer, thimble is asked about the file's type (suggestOnce).
 */
export function useTypeViewers(ws: string, path: string, on: boolean, offer: boolean): { viewers: View[] } {
  const [viewers, setViewers] = useState<View[]>([])
  // the file whose read answered last, so thimble is asked only from its own answer
  const [read, setRead] = useState<string | null>(null)
  useEffect(() => {
    if (!on) return setViewers([])
    let alive = true
    const load = () =>
      viewsForFile(ws, path)
        .then((list) => {
          if (!alive) return
          setViewers(Array.isArray(list) ? list.filter((v) => v.ok && v.file_type) : [])
          setRead(path)
        })
        .catch(() => undefined)
    load()
    const off = bus.on('view', () => void load())
    return () => {
      alive = false
      off()
    }
  }, [ws, path, on])
  const none = on && read === path && viewers.length === 0
  useEffect(() => {
    if (offer && none) suggestOnce(ws, path)
  }, [ws, path, offer, none])
  return { viewers }
}
