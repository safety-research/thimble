// The card check as a card shows it (the records backend/app/checkstore.py writes): whether a check is running, and the
// fix it applied (a change of the card's question, code or takeaway). Read tolerantly, so a cell without check fields
// reads as unchecked. Pure.
//
// The card shows the check only when it found a real problem (checkProblem): a red ✕ at the takeaway's corner for
// numbers its code types in, or for a revision the check made that would not run (canvas/CardFace ProblemMark). A
// running check shimmers the card, and a fix lands in place; everything else, the fix's Undo among it, is in the card's
// details (canvas/CheckDetails). ✓ is not the check's: it is kept for the analyst's own verification.
import { hhmm } from './time'
import type { Cell } from './types'

export type CheckState = 'running' | 'checked' | 'failed' | 'stopped'

/** What a running check does (backend checkstore.PHASES). */
export type CheckPhase = 'queued' | 'checking' | 'waiting' | 'revising'

type FixField = 'title' | 'code' | 'takeaway'

/** The fields of a card its check reads; `title` is the question, which a fix may change. */
type Checked = Pick<Cell, 'check' | 'fixes' | 'takeaway' | 'code' | 'kind'> & { title?: string }

/** The fields that say whether a check could read a card at all (backend card_check.wants_check). */
type Readable = Pick<Cell, 'kind' | 'takeaway' | 'locked' | 'created_by' | 'status' | 'payload'>

export interface CheckFix {
  id: string
  /** when it landed: a new fix fades the change in */
  ts: string
  /** what was wrong: what fails the first criterion the card failed, the check's sentence */
  reason: string
  fields: FixField[]
  /** the card's fields before the fix, for the check mark's hover; `title` is the question */
  before: { title?: string; takeaway?: string; code?: string }
}

export interface CardCheck {
  state: CheckState
  /** when the check began (running) or ended, ISO; '' when the record names neither */
  at: string
  /** the newest fix still in effect */
  fix: CheckFix | null
  /** running: what it does, when the record says */
  phase?: CheckPhase
  /** waiting: when it reads the card again, ISO */
  until?: string
  /** waiting: why it waits; failed or stopped: why it ended, when the record says */
  why?: string
  /** ended: the record's line whatever the outcome, that its reading ran on the fallback model (backend
   * card_check.FALLBACK_NOTE) */
  note?: string
  /** checked: the numbers the card shows that its code types in rather than computing them (backend
     * card_check.typed_numbers), unless a fix has replaced the code since */
  typed?: string[]
  /** failed: why the revision the check made was not kept (its code did not run clean, or the card did not draw), when
   * the check recorded that revision as rejected (backend checkstore.record_rejected) */
  unrun?: string
  /** with `unrun`: what the check found wrong, the first problem of its reading (the critique stage's assessment) */
  found?: string
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** Two field values alike, a missing one read as empty. */
const same = (a: unknown, b: unknown): boolean => (a ?? '') === (b ?? '')

/** A takeaway as the analyst reads it: each value-ref as its value, a bare ref as nothing, spaces collapsed. */
const readText = (t: string): string =>
  t
    .replace(/\[\[([^\]|]*)\|[^\]]*\]\]/g, '$1')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The newest applied fix whose `after` still equals the card's fields ($defs.fix), shown as a revision: none when the
 * card was changed again since, or when the fix only touched the takeaway's links. */
export function liveFix(cell: Pick<Checked, 'fixes' | 'takeaway' | 'code' | 'title'>): CheckFix | null {
  const list = Array.isArray(cell.fixes) ? cell.fixes : []
  for (let i = list.length - 1; i >= 0; i--) {
    const f = obj(list[i])
    if (!f || f.state !== 'applied') continue
    const after = obj(f.after) ?? {}
    const fields = (Array.isArray(f.fields) ? f.fields : []).filter((x): x is FixField => x === 'title' || x === 'code' || x === 'takeaway')
    if (!fields.length) continue
    const current: Record<string, unknown> = { title: cell.title ?? '', takeaway: cell.takeaway ?? '', code: cell.code ?? '' }
    if (!fields.every((k) => same(after[k], current[k]))) return null
    const before = obj(f.before) ?? {}
    if (fields.length === 1 && fields[0] === 'takeaway' && readText(text(before.takeaway)) === readText(text(after.takeaway))) return null
    return {
      id: text(f.id),
      ts: text(f.ts),
      reason: text(f.reason).trim(),
      fields,
      before: Object.fromEntries(fields.map((k) => [k, text(before[k])])),
    }
  }
  return null
}

/** A check record's status as the face shows it; null for a record shape it does not know. */
const STATE: Record<string, CheckState> = { pending: 'running', ok: 'checked', fixed: 'checked', error: 'failed', stopped: 'stopped' }
const PHASES: readonly string[] = ['queued', 'checking', 'waiting', 'revising']

/** The card's check as its face shows it, or null when it shows nothing. A label card is never checked, so a check
 * record on one shows nothing. `phase`, `until`, `why` and `note` are there only when the record gives them. */
export function checkOf(cell: Checked): CardCheck | null {
  const c = cell.kind === 'label' ? null : obj(cell.check)
  const fix = liveFix(cell)
  const state = c ? STATE[text(c.status)] : undefined
  if (c && state) {
    const out: CardCheck = { state, at: text(state === 'running' ? c.started : c.ended || c.started), fix }
    const phase = text(c.phase)
    if (state === 'running' && PHASES.includes(phase)) out.phase = phase as CheckPhase
    if (state === 'running' && text(c.until)) out.until = text(c.until)
    const why = text(state === 'running' ? c.note : c.reason).trim()
    if (why && state !== 'checked') out.why = why
    const note = text(c.note).trim()
    if (note && state !== 'running') out.note = note
    const typed = obj(obj(c.stages)?.render)?.typed
    if (state === 'checked' && Array.isArray(typed) && typed.length && !fix?.fields.includes('code')) out.typed = typed.map(text)
    const rejected = state === 'failed' ? rejectedFix(cell, text(c.id)) : null
    if (rejected) {
      out.unrun = text(rejected.reason).trim() || 'it could not be applied'
      const assessment = obj(obj(c.stages)?.critique)?.assessment
      const first = Array.isArray(assessment) ? assessment.map((a) => text(obj(a)?.problem).trim()).find(Boolean) : ''
      if (first) out.found = first
    }
    return out
  }
  return fix ? { state: 'checked', at: fix.ts, fix } : null
}

/** The revision check `id` recorded as not kept (state `rejected`), or null. */
function rejectedFix(cell: Pick<Checked, 'fixes'>, id: string): Record<string, unknown> | null {
  if (!id || !Array.isArray(cell.fixes)) return null
  for (let i = cell.fixes.length - 1; i >= 0; i--) {
    const f = obj(cell.fixes[i])
    if (f && f.state === 'rejected' && text(f.check) === id) return f
  }
  return null
}

/** The real problem the check found, in words, or '' when it found none the card should show: numbers its code types
 * in (typedLine), or a revision that would not run (`unrun`). A check that passed, revised the card, runs, was stopped
 * or could not finish shows nothing on the card. Pure. */
export function checkProblem(check: CardCheck | null): string {
  if (!check) return ''
  const typed = typedLine(check)
  if (typed) return typed
  if (!check.unrun) return ''
  const unrun = check.unrun.replace(/\.$/, '')
  return check.found ? `${check.found.replace(/\.$/, '')}. Its revision of the card would not run: ${unrun}.` : `Its revision of the card would not run: ${unrun}.`
}

/** What the card's details say of its check first: by the check's state and, while it runs, its phase; the reason an
 * ended check gives follows a colon. A check whose revision would not run read the card to the end, and its problem
 * (checkProblem) says the rest. */
export function checkLine(check: CardCheck): string {
  const at = hhmm(check.at)
  const why = check.why ? `: ${check.why}` : ''
  if (check.state === 'running') {
    if (check.phase === 'queued') return 'Queued behind the checks of other cards'
    if (check.phase === 'waiting') return `Waiting for API capacity${why}${check.until ? `; reading again at ${hhmm(check.until)}` : ''}`
    if (check.phase === 'revising') return 'Trying its revision of the card'
    return at ? `Checking the card since ${at}` : 'Checking the card'
  }
  if (check.state === 'failed' && check.unrun) return at ? `Checked at ${at}` : 'Checked'
  if (check.state === 'failed') return (at ? `The check at ${at} could not finish` : 'The check could not finish') + why
  if (check.state === 'stopped') return (at ? `Stopped at ${at}` : 'Stopped') + why
  return at ? `Checked at ${at}` : 'Checked'
}

/** What the card says of numbers its code types in (CardCheck.typed), '' for none: how many, the first few, and that the
 * data should compute them. */
export function typedLine(check: CardCheck): string {
  const typed = check.typed ?? []
  if (!typed.length) return ''
  const shown = typed.slice(0, 4).map((t) => (Number.isFinite(Number(t)) ? Number(t).toLocaleString() : t))
  const n = typed.length === 1 ? 'a number' : `${typed.length} numbers`
  return `Its code types in ${n} the card shows (${shown.join(', ')}${typed.length > 4 ? ', …' : ''}) rather than computing ${typed.length === 1 ? 'it' : 'them'} from the data.`
}

/** Whether a check could read the card (backend card_check.wants_check): it has a takeaway, is no label card, is not
 * locked or made by the analyst, and is not running or failed. */
export function checkable(cell: Readable): boolean {
  if (cell.kind === 'label' || !String(cell.takeaway ?? '').trim()) return false
  if (cell.locked === true || cell.created_by === 'user') return false
  // a card whose code the kernel runs is read once its code ran clean (backend notebook.runnable)
  const runs = RUNNABLE.includes(String(cell.kind)) && !(cell.payload && typeof cell.payload === 'object')
  return runs ? cell.status === 'ok' : cell.status !== 'running' && cell.status !== 'error'
}

/** The kinds whose code the kernel runs (backend notebook.RUNNABLE_KINDS), unless the card carries a payload. */
const RUNNABLE: readonly string[] = ['plot', 'table', 'code', 'timeline', 'diagram']

/** A card's check state for the card filter (canvas/cardFilter.ts `checks`, backend filters.check_state), by the mark
 * the card shows. Failed: the red ✕, a real problem the check found (checkProblem). Verified: checked to the end with no
 * such problem, revised or not. Unverified: running, stopped, or could not finish. Unchecked: never read. */
export type CheckFilterState = 'verified' | 'unverified' | 'failed' | 'unchecked'
/** The states in the order the Filter menu lists them, with the words it and the chips use. */
export const CHECK_WORDS: Record<CheckFilterState, string> = { verified: 'Verified', unverified: 'Unverified', failed: 'Failed', unchecked: 'Not checked' }
export const CHECK_STATES = Object.keys(CHECK_WORDS) as CheckFilterState[]

/** The card's check state (CheckFilterState). Pure. */
export function checkState(cell: Checked): CheckFilterState {
  const check = checkOf(cell)
  if (!check) return 'unchecked'
  if (checkProblem(check)) return 'failed'
  return check.state === 'checked' ? 'verified' : 'unverified'
}

/** Whether the card is being checked: its body and citations shimmer. */
export const isChecking = (cell: Checked): boolean => checkOf(cell)?.state === 'running'
