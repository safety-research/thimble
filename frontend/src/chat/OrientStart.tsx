// The orientation's start as main's chat shows it before its thread exists: "Starting…" while the start is on its way
// (a click's answer normally comes within a second, so the card shows only after STARTING_AFTER_MS; a typed start shows
// it until main makes the call), and the card of a start that did not happen (chat/Refused), whose Edit request goes to
// the Start gate, which comes back filled in from orient/run.json. Once the agent starts, main's log holds its
// "Orientation started in" row and its thread opens. The record is read from `GET /ws/{c}/orientation`, again on the
// stream's `orient` events and while it says `starting`.
import { useEffect, useState } from 'react'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { OrientRun, Refusal, StartAnswer } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { RefusedCard } from './Refused'

/** How long a click's start goes unanswered before the card says Starting… */
export const STARTING_AFTER_MS = 1000
/** How often a record that says `starting` is read again. */
const STARTING_POLL_MS = 1500

/** The orientation's record, read again on `orient` events, when main's status for it changes, and while it starts. */
export function useOrientRun(ws: string, status: string | null | undefined): { run: OrientRun | null; reload: () => void } {
  const [run, setRun] = useState<OrientRun | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    api
      .orientation(ws)
      .then((r) => alive && setRun(r ?? {}))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws, status, tick])
  useEffect(() => bus.on('orient', () => setTick((t) => t + 1)), [])
  const starting = run?.status === 'starting' || status === 'starting'
  useEffect(() => {
    if (!starting) return
    const t = window.setInterval(() => setTick((k) => k + 1), STARTING_POLL_MS)
    return () => window.clearInterval(t)
  }, [starting])
  return { run, reload: () => setTick((t) => t + 1) }
}

/** The refusal main's chat shows: the record's, or the one the click's answer just gave while the record is read again;
 * none for a start whose card the analyst dismissed. Pure. */
export function shownRefusal(run: OrientRun | null, answer: StartAnswer | null, dismissed: readonly string[]): Refusal | null {
  const own = run?.status === 'refused' && run.refused ? { ...run.refused, request: run.refused.request ?? run.request ?? null } : null
  const fromAnswer = answer && !answer.agentId && !answer.program && answer.kind ? { kind: answer.kind, reason: answer.reason ?? '', request: answer.request ?? null, expired: answer.expired } : null
  const r = own ?? fromAnswer
  if (!r) return null
  return dismissed.includes(refusalKey(r)) ? null : r
}

/** What a dismissal of a refusal keeps: its request, else when it happened. Pure. */
export const refusalKey = (r: Pick<Refusal, 'request' | 'at'>): string => r.request || r.at || 'refused'

/** Whether main's chat says Starting…: a click with no answer for STARTING_AFTER_MS, or a record that says `starting`
 * (a typed start main has not made yet). Pure. */
export function startingShown(run: OrientRun | null, pendingSince: number | null, now: number): boolean {
  if (pendingSince != null) return now - pendingSince >= STARTING_AFTER_MS
  return run?.status === 'starting'
}

const dismissedKey = (ws: string) => storageKey(ws, 'orient-refused-dismissed')

export function OrientStart({ ws, run, answer, pendingSince, onEdit, onStarted }: {
  ws: string
  run: OrientRun | null
  /** what this tab's Start click answered, while the record is read again */
  answer: StartAnswer | null
  /** when this tab's Start click went out, while it waits for its answer */
  pendingSince: number | null
  onEdit: () => void
  onStarted: (a: StartAnswer) => void
}) {
  const [dismissed, setDismissed] = useState<string[]>(() => readStorage<string[]>(dismissedKey(ws), []))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (pendingSince == null) return
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(0, STARTING_AFTER_MS - (Date.now() - pendingSince)) + 10)
    return () => window.clearTimeout(t)
  }, [pendingSince])
  if (startingShown(run, pendingSince, Math.max(now, pendingSince ?? 0))) {
    return (
      <div className="chat-msg chat-starting" role="status" data-by={pendingSince != null ? 'click' : run?.started_by ?? undefined}>
        <Spinner size={11} label="Starting" />
        <span className="chat-starting-text">{pendingSince != null || run?.started_by !== 'typed' ? 'Starting the orientation…' : 'Your Claude Code session is starting the orientation…'}</span>
      </div>
    )
  }
  const refusal = pendingSince == null ? shownRefusal(run, answer, dismissed) : null
  if (!refusal) return null
  return (
    <RefusedCard
      ws={ws}
      what="the orientation"
      refusal={refusal}
      text={run?.query ?? null}
      onEdit={onEdit}
      onStarted={onStarted}
      onDismiss={() => {
        const key = refusalKey(refusal)
        const next = [...dismissed.filter((d) => d !== key), key].slice(-20)
        writeStorage(dismissedKey(ws), next)
        setDismissed(next)
      }}
    />
  )
}
