// thimble browser's features on the page, registered in one place, as the server registers them (server
// thimble_browser/features/). The page's core is the chat, the Files tab and Settings; each feature below owns the
// surfaces it names, and the place that draws a surface asks `useFeature(name)` first, so a feature turned off in
// Settings takes its surfaces with it and leaves the others as they are:
//
//   marks      the marks on the claims of a reply, and their check (marks/)
//   cards      the cards Claude draws under its calls and v's cards under an answer (cards/)
//   labels     the Labels pane of the Files tab and the colors it gives records (files/FilesTab.tsx)
//   report     the Report tab (shell/Shell.tsx)
//   views      the views bar of the Files tab and a view proposal's card (files/FilesTab.tsx, chat/ProposalCard.tsx)
//
// The server says which are on (GET /api/ws/{c}/features) and tells the page when that changes (the stream's
// `features` record). Until it has answered, every feature counts as on, so nothing blinks out at the first draw.
import { useSyncExternalStore } from 'react'
import { apiUrl } from './lib/browserKey'
import { bus } from './lib/bus'

export type FeatureName = 'marks' | 'cards' | 'labels' | 'report' | 'views'

/** A feature as Settings lists it (server features.listing). */
export interface FeatureRow {
  name: FeatureName
  title: string
  does: string
  on: boolean
}

let rows: readonly FeatureRow[] = []
let readFor: string | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((fn) => fn())

/** Read the features of workspace `ws` again from the server. */
export async function loadFeatures(ws: string): Promise<readonly FeatureRow[]> {
  readFor = ws
  try {
    const res = await fetch(apiUrl(`/api/ws/${encodeURIComponent(ws)}/features`))
    if (!res.ok) return rows
    const got = (await res.json()) as FeatureRow[]
    if (Array.isArray(got)) {
      rows = got
      changed()
    }
  } catch {
    // the page keeps what it had: a failed read never turns a feature off
  }
  return rows
}

/** Whether `name` is on now: on until the server says it is off. Pure but for the rows read. */
export function featureOn(name: FeatureName): boolean {
  return rows.find((r) => r.name === name)?.on ?? true
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Whether `name` is on, drawn again when that changes. */
export function useFeature(name: FeatureName): boolean {
  return useSyncExternalStore(subscribe, () => featureOn(name), () => true)
}

// the stream says the switches changed (settings_api.put_settings): read them again
bus.on('features', () => {
  if (readFor) void loadFeatures(readFor)
})
