// File viewers in the File browser: the views whose unit is "file", or with no unit whose claims are all extension
// globs (backend views.file_type_viewer), are modes of the files they claim, and a viewer proposed for the file's type,
// such as one the orientation suggests, shows beside Raw until it is built.
import { useEffect, useState } from 'react'
import { bus } from '../lib/bus'
import { useProposals } from '../lib/proposals'
import type { Proposal, View } from '../lib/types'
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

/** The proposal of a viewer for the file's type that is not built: suggested, queued, building or failed. Pure. */
export function typeProposal(proposals: readonly Proposal[] | null, path: string): Proposal | null {
  const suffix = suffixOf(path)
  if (!suffix || !Array.isArray(proposals)) return null
  return proposals.find((p) => p.status !== 'built' && p.status !== 'dropped' && (p.claims ?? []).some((g: string) => typeSuffix(g) === suffix)) ?? null
}

export interface TypeViewers {
  /** the working file-type viewers that claim the file, in the server's order */
  viewers: View[]
  /** the viewer proposed for the file's type, not built yet */
  proposal: Proposal | null
}

/**
 * The file-type viewers of `path`, read again on each `view` event while `on`, and, while `offer` holds (the file's best
 * built-in mode is Raw) and no viewer claims it, the proposal for its type.
 */
export function useTypeViewers(ws: string, path: string, on: boolean, offer: boolean): TypeViewers {
  const [viewers, setViewers] = useState<View[]>([])
  useEffect(() => {
    if (!on) return setViewers([])
    let alive = true
    const read = () =>
      viewsForFile(ws, path)
        .then((list) => alive && setViewers(Array.isArray(list) ? list.filter((v) => v.ok && v.file_type) : []))
        .catch(() => undefined)
    read()
    const off = bus.on('view', () => void read())
    return () => {
      alive = false
      off()
    }
  }, [ws, path, on])
  const proposals = useProposals(ws)
  const proposal = on && offer && viewers.length === 0 ? typeProposal(proposals, path) : null
  return { viewers, proposal }
}
