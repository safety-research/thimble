// The panel's way through what it shows, as thimble's chat column keeps its threads: a breadcrumb from home to what the
// panel shows now (home › thread "…" › citation …), each step a press away; a back key through the trails it showed
// before; and the side threads as a tree, each under the thread it was asked from. register.tsx keeps the way in state
// (`nav`) and draws it; this file holds the rules, without `$`.
//
// A step opened from inside the panel (a citation in a thread's answer, "ask about it" in a citation, a record of a
// view, an item of the home panel) extends the trail, so the thread stays one step back. One opened from main or a
// command starts the trail over; a thread then stands under the threads it was asked from. The home panel is the
// breadcrumb's first step: opened, it starts the trail over, and what it opens stands after it. Every move keeps the
// trail it left in `back`.
import type { ChatNav, ChatNavStep, ChatThread } from '../types'
import { plainCites } from './cite'
import { clip, cut, quoted, width } from './lib'

export const NAV_EMPTY: ChatNav = { trail: [], back: [] }
const TRAIL_MAX = 12
const BACK_MAX = 30

/** What a step shows, whatever its pane's title: its view and the thread, citation, card, view or report it names. */
export function stepId(s: ChatNavStep): string {
  return `${s.view}:${s.thread ?? s.open ?? s.card ?? s.slug ?? ''}`
}

export function sameTrail(a: readonly ChatNavStep[], b: readonly ChatNavStep[]): boolean {
  return a.length === b.length && a.every((s, i) => stepId(s) === stepId(b[i]!) && s.mode === b[i]!.mode)
}

/** A trail without the menu it ends in: a menu is replaced by what it opens, and never returned to. */
function settled(trail: readonly ChatNavStep[]): ChatNavStep[] {
  return trail.at(-1)?.view === 'menu' ? trail.slice(0, -1) : trail.slice()
}

/** The trail once the panel opens `step`. From inside the panel it extends the trail (cut back to the step when the
 *  trail holds it already); otherwise it starts over: a thread at the end of `chain` (the threads it was asked from,
 *  the root first), anything else alone. The threads list and the home panel always stand alone. */
export function nextTrail(cur: readonly ChatNavStep[], step: ChatNavStep, inPanel: boolean, chain: readonly ChatNavStep[] = [step]): ChatNavStep[] {
  if (step.view === 'threads' || step.view === 'home') return [step]
  if (!inPanel) return step.view === 'thread' && chain.length ? chain.slice(-TRAIL_MAX) : [step]
  const base = settled(cur).filter(s => s.view !== 'threads')
  const i = base.findIndex(s => stepId(s) === stepId(step))
  return (i >= 0 ? [...base.slice(0, i), step] : [...base, step]).slice(-TRAIL_MAX)
}

/** `back` with the trail the panel leaves added last (not twice in a row, never a menu). */
export function withBack(back: readonly ChatNavStep[][], trail: readonly ChatNavStep[]): ChatNavStep[][] {
  const t = settled(trail)
  const last = back.at(-1)
  if (!t.length || (last && sameTrail(last, t))) return back.slice()
  return [...back, t].slice(-BACK_MAX)
}

/** The way once the panel moved to `trail`. */
export function moved(nav: ChatNav, trail: ChatNavStep[]): ChatNav {
  return { trail, back: sameTrail(nav.trail, trail) ? nav.back.slice() : withBack(nav.back, nav.trail) }
}

/** The steps the breadcrumb names after its first crumb, home: the trail less the home panel it starts from. */
export function crumbSteps(trail: readonly ChatNavStep[]): { steps: ChatNavStep[]; skipped: number } {
  return trail[0]?.view === 'home' ? { steps: trail.slice(1), skipped: 1 } : { steps: trail.slice(), skipped: 0 }
}

/** Where back leads: the latest trail shown before that is not the one shown now, else the trail less its last step;
 *  null when there is neither. */
export function backTarget(nav: ChatNav): ChatNav | null {
  const back = nav.back.slice()
  while (back.length) {
    const t = back.pop()!
    if (!sameTrail(t, nav.trail)) return { trail: t, back }
  }
  return nav.trail.length > 1 ? { trail: nav.trail.slice(0, -1), back: [] } : null
}

/** The thread nearest the end of the trail before its last step, where a follow-up asked from that step goes. */
export function threadBehind(trail: readonly ChatNavStep[]): string {
  for (let i = trail.length - 2; i >= 0; i--) if (trail[i]!.view === 'thread' && trail[i]!.thread) return trail[i]!.thread!
  return ''
}

/** The thread a new thread asked from inside the panel hangs under: the nearest on the trail, the last step included. */
export function threadOnTrail(trail: readonly ChatNavStep[]): string {
  for (let i = trail.length - 1; i >= 0; i--) if (trail[i]!.view === 'thread' && trail[i]!.thread) return trail[i]!.thread!
  return ''
}

const SEP = 3 // " › "
const MIN_CRUMB = 12

/** The breadcrumb's words in `room` columns, separators included: each crumb at most 34 columns; the crumbs after the
 *  first folded, oldest first, into one "…" (null marks a folded crumb) while they would not fit at 12 columns each;
 *  then the longest shortened a column at a time; the last cut to what is left. */
export function fitCrumbs(labels: readonly string[], room: number): (string | null)[] {
  const out: (string | null)[] = labels.map(l => clip(l, 34))
  const total = (w: (s: string) => number) => out.reduce<number>((n, s, i) => n + (s === null ? (out[i - 1] === null ? 0 : 1 + SEP) : w(s) + (i ? SEP : 0)), 0)
  const least = (s: string) => Math.min(width(s), MIN_CRUMB)
  for (let i = 1; total(least) > room && i < out.length - 1; i++) out[i] = null
  for (let guard = 0; total(width) > room && guard < 400; guard++) {
    let top = -1
    out.forEach((s, i) => {
      if (s !== null && width(s) > MIN_CRUMB && (top < 0 || width(s) > width(out[top]!))) top = i
    })
    if (top < 0) break
    out[top] = cut(out[top]!, width(out[top]!) - 1)
  }
  const last = out.length - 1
  if (total(width) > room && last >= 0 && out[last] !== null) out[last] = cut(out[last]!, Math.max(4, width(out[last]!) - (total(width) - room)))
  return out
}

// ------------------------------------------------------------------------------------------------ the threads tree

/** A thread by name: its first question, quoted, else what it is about. */
export function threadTitle(t: Pick<ChatThread, 'label' | 'turns'>): string {
  const q = t.turns[0]?.q
  return q ? quoted(plainCites(q).replace(/\s+/g, ' ').trim()) : `about ${plainCites(t.label)}`
}

/** When a thread last changed: its `at`, else when it was made (its id is `t` and the time in base 36). */
export function activity(t: Pick<ChatThread, 'id' | 'at'>): number {
  if (typeof t.at === 'number') return t.at
  const n = Number.parseInt(t.id.slice(1, 9), 36)
  return Number.isFinite(n) ? n : 0
}

/** Answers the thread has given. */
export function answered(t: Pick<ChatThread, 'turns'>): number {
  return t.turns.filter(x => x.state === 'done').length
}

/** Answers the analyst has not read: those after the `seen` count; a thread with none recorded (an earlier session's)
 *  has none. */
export function unread(t: Pick<ChatThread, 'turns'>, seen: number | undefined): number {
  return seen === undefined ? 0 : Math.max(0, answered(t) - seen)
}

/** What a thread is doing, in a few words, and how to colour them. */
export function threadState(t: Pick<ChatThread, 'turns'>): { words: string; tone: 'run' | 'ok' | 'problem' | 'dim' } {
  const last = t.turns.at(-1)
  const n = t.turns.length
  const asked = `${n} question${n === 1 ? '' : 's'}`
  if (!last) return { words: 'nothing asked yet', tone: 'dim' }
  if (last.state === 'running') return { words: `answering · ${last.tools} tool call${last.tools === 1 ? '' : 's'}`, tone: 'run' }
  if (last.state === 'error') return /^\s*stopped/.test(last.a) ? { words: `stopped · ${asked}`, tone: 'dim' } : { words: `failed · ${asked}`, tone: 'problem' }
  return { words: `answered · ${asked}`, tone: 'ok' }
}

/** A thread's state words beside its glyph, without the word the glyph already says (● answered, ◌ answering, × failed,
 *  ○ stopped): SPEC.md, "Symbols", a glyph and a word that say the same thing are never drawn together. */
export function afterGlyph(words: string): string {
  return words.replace(/^(answered|answering|failed|stopped) · /, '')
}

/** A row of the threads tree: the thread, its depth under main (0 for one asked from main), the guide drawn before
 *  it, and the guide its second line takes. */
export type TreeRow = { t: ChatThread; depth: number; guide: string; under: string }

/** The threads as a tree under main: each under the thread it was asked from (`parent`), at the top when that thread
 *  is not listed; siblings by their latest activity or a descendant's, newest first. A cycle of parents is broken by
 *  listing its threads at the top. */
export function threadTree(threads: readonly ChatThread[]): TreeRow[] {
  const byId = new Map(threads.map(t => [t.id, t]))
  const parentOf = (t: ChatThread): string | null => (t.parent && t.parent !== t.id && byId.has(t.parent) ? t.parent : null)
  const kids = new Map<string | null, ChatThread[]>()
  for (const t of threads) kids.set(parentOf(t), [...(kids.get(parentOf(t)) ?? []), t])
  const latest = new Map(threads.map(t => [t.id, activity(t)]))
  for (const t of threads) {
    const seen = new Set([t.id])
    for (let p = parentOf(t); p && !seen.has(p); p = parentOf(byId.get(p)!)) {
      seen.add(p)
      if ((latest.get(p) ?? 0) < activity(t)) latest.set(p, activity(t))
    }
  }
  const order = (xs: ChatThread[]) => xs.slice().sort((a, b) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0))
  const out: TreeRow[] = []
  const done = new Set<string>()
  const walk = (t: ChatThread, depth: number, lead: string, last: boolean) => {
    if (done.has(t.id)) return
    done.add(t.id)
    const mine = order(kids.get(t.id) ?? [])
    out.push({ t, depth, guide: `${lead}${last ? '└─ ' : '├─ '}`, under: `${lead}${last ? '   ' : '│  '}${mine.length ? '│  ' : '   '}` })
    mine.forEach((k, i) => walk(k, depth + 1, `${lead}${last ? '   ' : '│  '}`, i === mine.length - 1))
  }
  const top = order(kids.get(null) ?? [])
  top.forEach((t, i) => walk(t, 0, '', i === top.length - 1))
  for (const t of threads) if (!done.has(t.id)) walk(t, 0, '', true)
  return out
}
