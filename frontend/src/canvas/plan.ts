// A plan card's steps as the card draws them (backend notebook.py, plan cards): the steps read from the payload, the
// time a step shows, and which steps are one line. Pure, so the tests read it without a page.
import type { Cell, PlanStatus, PlanStep } from '../lib/types'

export const PLAN_STATUSES: readonly PlanStatus[] = ['not started', 'running', 'done', 'needs you']

const strs = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean)
const stamp = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** A plan card's steps in order, each with every field (backend notebook.plan_step_of); [] for any other card. */
export function planSteps(cell: Pick<Cell, 'kind' | 'payload'>): PlanStep[] {
  if (cell.kind !== 'plan') return []
  const raw = (cell.payload as { steps?: unknown } | undefined)?.steps
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s, i) => {
      const status = String(s.status ?? '') as PlanStatus
      return {
        id: typeof s.id === 'string' && s.id ? s.id : `s${i + 1}`,
        text: String(s.text ?? ''),
        makes: strs(s.makes),
        status: PLAN_STATUSES.includes(status) ? status : 'not started',
        note: typeof s.note === 'string' ? s.note.trim() : '',
        runs: strs(s.runs),
        time: typeof s.time === 'string' ? s.time.trim() : '',
        started: stamp(s.started),
        ended: stamp(s.ended),
      }
    })
}

/** A step's time in the card's words: 40 s, 12 m, 2 h or 1 h 20 m (backend notebook.duration_words). */
export function durationWords(seconds: number): string {
  const sec = Math.max(0, Math.round(seconds))
  if (sec < 60) return `${sec} s`
  if (sec < 3600) return `${Math.floor(sec / 60)} m`
  const mins = Math.floor(sec / 60)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} h` : `${h} h ${m} m`
}

/** The time a step shows: the time the agent gave, else from its start to its end, or to `now` while it runs; '' when
 * neither is known (backend notebook.step_time). */
export function stepTime(step: PlanStep, now: number = Date.now()): string {
  if (step.time) return step.time
  const start = step.started ? Date.parse(step.started) : NaN
  if (Number.isNaN(start)) return ''
  const end = step.ended ? Date.parse(step.ended) : step.status === 'running' ? now : NaN
  if (Number.isNaN(end)) return ''
  return durationWords((end - start) / 1000)
}

/** The words at a step's right: its status, and its time after a dot when it has one, as `running · 40 m`. */
export function statusWords(step: PlanStep, now?: number): string {
  const t = stepTime(step, now)
  return t ? `${step.status} · ${t}` : step.status
}

/** Whether a step has more than its line to show: what it makes, a note or runs. */
export const hasMore = (step: PlanStep): boolean => step.makes.length > 0 || !!step.note || step.runs.length > 0

/** Whether a step is drawn as one line: a done step, unless the analyst opened it. */
export const isCompact = (step: PlanStep, opened: ReadonlySet<string>): boolean => step.status === 'done' && !opened.has(step.id)

/** Whether what a step makes is made yet: a step that runs or is done makes it; the others show it dashed. */
export const isMade = (step: PlanStep): boolean => step.status === 'running' || step.status === 'done'

/** `card:<id>#step-<n>`, the ref of a plan's step numbered from 1 (backend refs.py). */
export const stepRef = (cellId: string, n: number): string => `card:${cellId}#step-${n}`

/** The plan cards among `cells` that are new since `before`, the ids the canvas last drew: a plan main just added, such
 * as the next phase's plan, whose frames the canvas opens so it shows rather than sitting under the first card of a
 * collapsed frame. [] on the canvas's first read (`before` null). */
export function newPlans(cells: readonly Pick<Cell, 'id' | 'kind'>[], before: ReadonlySet<string> | null): string[] {
  if (before == null) return []
  return cells.filter((c) => c.kind === 'plan' && !before.has(c.id)).map((c) => c.id)
}
