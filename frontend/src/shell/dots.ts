// A tab shows a dot when something new landed on its surface while no pane showed it; the history the stream replays
// on load is not new. On the canvas only a card made or deleted counts, not the many updates to an existing card.
// While a writer writes a document, the Report tab shows a spinner in the dot's place, and the dot once it ends.
import { useEffect, useState } from 'react'
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
    case 'concepts':
      return 'files'
    case 'filter':
      return payload.scope === 'canvas' || payload.scope === 'report' || payload.scope === 'files' ? (payload.scope as Tab) : null
    default:
      return null
  }
}

/** Whether a writer is writing a document: a writer's chat whose session runs (its status `running`, or no status yet
 * while the list says it runs). Pure. */
export function writing(metas: Iterable<{ role?: string | null; status?: string | null; running?: boolean }>): boolean {
  for (const m of metas) {
    if (m.role !== 'writer') continue
    if (m.status === 'running' || (!m.status && m.running)) return true
  }
  return false
}

/** Each tab's signal: the Report tab's spinner while a writer writes (in place of its dot), else the dot where
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
