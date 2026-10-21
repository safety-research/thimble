// thimble's own work while it runs (backend busy.py): the stream's `busy` records, each a job's start or end with a
// word or two ("marking", "labeling"), and a document Claude writes (the `report` records, "writing"). The top bar shows the newest job that has run 300 ms or more, with its seconds
// from 3 s on (shell/TopBar.tsx BusyMark). A dropped stream clears them: a page that reconnects hears the next ones.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { bus } from './bus'

const SHOW_MS = 300
const SECS_MS = 3000

const jobs = new Map<string, { word: string; t0: number }>()
const subs = new Set<() => void>()
let version = 0

function changed(): void {
  version += 1
  for (const fn of Array.from(subs)) fn()
}

bus.on('wsEvent', (ev) => {
  const r = ev as Record<string, unknown>
  if (r.type === 'busy' && typeof r.id === 'string') {
    if (r.on === true) jobs.set(r.id, { word: String(r.word ?? 'working'), t0: Date.now() })
    else jobs.delete(r.id)
    changed()
  } else if (r.type === 'report' && typeof r.slug === 'string') {
    // a document Claude writes: from `generating` until its next status (backend report.set_status)
    const id = `report:${r.slug}`
    if (r.status === 'generating') {
      if (!jobs.has(id)) jobs.set(id, { word: 'writing', t0: Date.now() })
    } else if (!jobs.delete(id)) return
    changed()
  }
})
bus.on('wsStream', (e) => {
  if (!e.connected && jobs.size) {
    jobs.clear()
    changed()
  }
})

/** The newest job that has run long enough to show, with its seconds once they help; null when none. */
export function busyNow(now = Date.now()): { word: string; secs: number | null } | null {
  let best: { word: string; t0: number } | null = null
  for (const j of jobs.values()) if (now - j.t0 >= SHOW_MS && (!best || j.t0 > best.t0)) best = j
  if (!best) return null
  const ms = now - best.t0
  return { word: best.word, secs: ms >= SECS_MS ? Math.floor(ms / 1000) : null }
}

/** The job the top bar shows now, drawn again each 250 ms while any job runs. */
export function useBusy(): { word: string; secs: number | null } | null {
  useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => version,
  )
  const [, setTick] = useState(0)
  const running = jobs.size > 0
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setTick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [running])
  return busyNow()
}

/** For tests: a job's start or end, as the stream says it. */
export function busyRecord(id: string, word: string, on: boolean): void {
  bus.emit('wsEvent', { type: 'busy', id, word, on } as never)
}
