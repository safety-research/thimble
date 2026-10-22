// thimble's own work while it runs: the one sign of work in the browser, the line above the chat's input box
// (chat/ChatBusy.tsx). Each job is a step named in plain words, the same words as the terminal's bar
// (plugin/bar/busy.ts): "answering" (main's turn), "answering: <thread>", "checking N marks", "drawing a card",
// "labeling: <label>", "writing the report", "fixing: <title>", "restarting with the fix". No tab, row or
// button draws a spinner of its own, but a mark the check reads, which turns after its words as in the terminal.
//
// Two sources. The stream's `busy` records (backend busy.py), each a job's start or end, and a document Claude writes
// (the `report` records); a dropped stream clears these, and a page that reconnects hears the next ones. And the page's
// own jobs (pageJob): main's turn and a side thread's (ChatBusy), a fix Claude works on and Try it's restart (FixState).
// The page's own outlive a dropped stream, so a restart that drops it still shows.
//
// The line shows the newest job that has run 300 ms or more (the step the analyst most likely just started), `+1` when
// another runs beside it, with its seconds from 3 s on.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { bus } from './bus'

const SHOW_MS = 300
const SECS_MS = 3000

const jobs = new Map<string, { word: string; t0: number; page?: boolean }>()
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
      if (!jobs.has(id)) jobs.set(id, { word: r.slug === 'report' ? 'writing the report' : `writing: ${r.slug}`, t0: Date.now() })
    } else if (!jobs.delete(id)) return
    changed()
  }
})
bus.on('wsStream', (e) => {
  if (e.connected) return
  let gone = false
  for (const [id, j] of jobs) if (!j.page) gone = jobs.delete(id) || gone
  if (gone) changed()
})

/** A job of the page's own, by a stable id: on starts it (again: its words change, its time stays), off ends it. */
export function pageJob(id: string, word: string | null): void {
  const key = `page:${id}`
  const was = jobs.get(key)
  if (word) {
    if (was?.word === word) return
    jobs.set(key, { word, t0: was?.t0 ?? Date.now(), page: true })
  } else if (!jobs.delete(key)) return
  changed()
}

/** The newest job that has run long enough to show, `+1` when another step runs beside it, with its seconds once they
 *  help; null when none. */
export function busyNow(now = Date.now()): { word: string; secs: number | null } | null {
  const on = [...jobs.values()].filter((j) => now - j.t0 >= SHOW_MS)
  let best: { word: string; t0: number } | null = null
  for (const j of on) if (!best || j.t0 > best.t0) best = j
  if (!best) return null
  const more = new Set(on.map((j) => j.word)).size - 1
  const ms = now - best.t0
  return { word: more ? `${best.word} +${more}` : best.word, secs: ms >= SECS_MS ? Math.floor(ms / 1000) : null }
}

/** The steps running now, by their words, the oldest first. */
export function busySteps(): string[] {
  return [...jobs.values()].sort((a, b) => a.t0 - b.t0).map((j) => j.word)
}

/** The job the busy line shows now, drawn again each 250 ms while any job runs. */
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
