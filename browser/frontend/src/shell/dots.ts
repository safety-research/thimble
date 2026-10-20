// A tab shows a dot when something new landed on its surface while no pane showed it; the history the stream replays
// on load is not new. On the canvas only a card made or deleted counts, not the many updates to an existing card. In
// Files only a view built counts: a view proposal, a build under way or one that failed has nothing to open there.
// While a writer writes a document, the Report tab shows a spinner in the dot's place, and the dot once it ends.
import { useEffect, useState } from 'react'
import { docsApi } from '../lib/api'
import { bus, type Tab } from '../lib/bus'
import { isReplay } from '../lib/events'

export type Dots = Record<Tab, boolean>
/** What a tab wears after its name: the accent dot, the spinner, or nothing. */
export type TabSignal = 'dot' | 'spinner' | null
const NONE: Dots = { files: false, canvas: false, report: false }

/** The tab a stream event lands on, or null when it belongs to no tab. */
export function tabOfEvent(type: string, payload: Record<string, unknown>): Tab | null {
  switch (type) {
    case 'cell':
      return payload.op === 'created' || payload.op === 'deleted' ? 'canvas' : null
    case 'report':
      return 'report'
    case 'view':
      return payload.status === 'built' && !payload.held ? 'files' : null
    case 'concepts':
      return 'files'
    case 'filter':
      return payload.scope === 'canvas' || payload.scope === 'report' || payload.scope === 'files' ? (payload.scope as Tab) : null
    default:
      return null
  }
}

/** Whether Claude is writing a report: one whose state says `generating` (GET …/investigations/main/types). Pure. */
export function writing(types: Readonly<Record<string, { status?: string | null }>> | null): boolean {
  return Object.values(types ?? {}).some((t) => t?.status === 'generating')
}

/** The reports' states, read again on each `report` event, for the Report tab's spinner. */
export function useReportTypes(ws: string): Readonly<Record<string, { status?: string | null }>> | null {
  const [types, setTypes] = useState<Readonly<Record<string, { status?: string | null }>> | null>(null)
  useEffect(() => {
    let live = true
    const read = () =>
      docsApi
        .types(ws)
        .then((t) => live && setTypes(t))
        .catch(() => undefined)
    void read()
    const off = bus.on('wsEvent', (ev) => {
      if (ev.type === 'report') void read()
    })
    return () => {
      live = false
      off()
    }
  }, [ws])
  return types
}

/** Each tab's signal: the Report tab's spinner while Claude writes a report (in place of its dot), else the dot where
 * something new landed. Pure. */
export function tabSignals(dots: Dots, isWriting: boolean): Record<Tab, TabSignal> {
  const of = (t: Tab): TabSignal => (dots[t] ? 'dot' : null)
  return { files: of('files'), canvas: of('canvas'), report: isWriting ? 'spinner' : of('report') }
}

/** The dots of the tabs whose surface no pane shows; a tab's dot goes when a pane shows its surface. */
export function useTabDots(shown: readonly Tab[]): Dots {
  const [dots, setDots] = useState<Dots>(NONE)
  const key = [...shown].sort().join(' ')
  useEffect(() => {
    const on = new Set(key.split(' '))
    setDots((d) => (Object.entries(d).some(([t, v]) => v && on.has(t)) ? (Object.fromEntries(Object.entries(d).map(([t, v]) => [t, v && !on.has(t)])) as Dots) : d))
  }, [key])
  useEffect(
    () =>
      bus.on('wsEvent', (ev) => {
        const tab = tabOfEvent(ev.type, ev as Record<string, unknown>)
        if (!tab || key.split(' ').includes(tab) || isReplay()) return
        setDots((d) => (d[tab] ? d : { ...d, [tab]: true }))
      }),
    [key],
  )
  return dots
}
