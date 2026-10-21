// side.ts: the side panel. Whatever opens beside the conversation is a thread: the thing itself at the top (a card's
// detail, a citation or an explainer, the thread list, any pane of thimble's), the thread's conversation under it, and
// an input bar at the bottom that looks and acts like Claude Code's prompt. The answer to a question shows in that
// conversation, never in place of the thing and never in the main column. detail.tsx draws the panel and holds its
// keys; this module says what it shows, what esc goes back to, and what its thread is about.
//
// For a pane of thimble's (panes/<name>.js), the panel needs no code of the pane's own:
//
//   openSide($, { pane: 'coverage', args: { … }, title?: 'Coverage' }, { push?, ask? })
//
// draws the pane's program at the top of the panel, its side thread under it and the input bar. Each question is
// about the part the program selected (k.select): the input bar names the part's label, and the question carries its
// refs (its region's meta ref or refs). One thread per pane instance (its state key), so opening the pane again shows
// its conversation again; the thread list (t, or the bar's `N threads`) finds it too. A pane module may say more with
// `thread(args, state, data)` and `titleOf(args)` (panes/index.js). `push` opens it over what the panel shows (esc goes
// back to that); `ask` gives the keys to the input bar at once.
//
//   state: side {now: SideView, back: [SideView]} (types SideView: a card {id, v, root, region} or a pane {pane, args,
//          title}), cleared when the panel closes
import type { EngineInterface } from 'claude-code'

import type { SideView, TrayFrame } from '../types'
import { paneDrawing, paneOf, paneThread, paneTitle } from './panes'
import { aboutOf, nameOf, paneScope, threadKey } from './threads.js'
import { threadOf } from './thread'
import type { Anchor, Scope, Thread } from './thread'
import { openDetail } from './shell'
import { focusEntry, openDock } from './detail'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const SIDE = { plugin: 'thimble', key: 'side' } as const
const MAX_BACK = 12

/** What the side panel shows now, or null. */
export async function sideNow($: Engine): Promise<SideView | null> {
  return ((await $.state.get(SIDE)).value as { now: SideView | null } | null)?.now ?? null
}

/** How many things esc goes back through before the panel closes. */
export async function sideDepth($: Engine): Promise<number> {
  return ((await $.state.get(SIDE)).value as { back: SideView[] } | null)?.back?.length ?? 0
}

const sameView = (a: SideView | null, b: SideView | null) => !!a && !!b && (a.kind === 'card' && b.kind === 'card' ? a.id === b.id && a.root === b.root : JSON.stringify(a) === JSON.stringify(b))

/** What the panel shows: `view` in place of what it showed ('replace': the way back starts again), over it ('push':
 *  esc goes back to it), or as it ('keep': the same way back). */
export async function setSide($: Engine, view: SideView, how: 'replace' | 'push' | 'keep' = 'replace'): Promise<void> {
  const cur = ((await $.state.get(SIDE)).value as { now: SideView | null; back: SideView[] } | null) ?? { now: null, back: [] }
  let back = how === 'replace' ? [] : cur.back
  if (how === 'push' && cur.now && !sameView(cur.now, view)) back = [...back, cur.now].slice(-MAX_BACK)
  await $.state.set(SIDE, { now: view, back })
}

/** The panel closed: it shows nothing, and nothing to go back to. */
export async function sideClosed($: Engine): Promise<void> {
  if ((await $.state.get(SIDE)).value) await $.state.set(SIDE, null)
}

/** A pane of thimble's in the side panel, as a thread (the module's opening comment). False when the terminal had no
 *  room to dock it (a toast says what opens it). */
export async function openSide($: Engine, view: { pane: string; args?: Record<string, unknown>; title?: string }, o: { push?: boolean; ask?: boolean; keep?: boolean; keys?: boolean } = {}): Promise<boolean> {
  paneOf(view.pane)
  const v: SideView = { kind: 'pane', pane: view.pane, args: view.args ?? {}, ...(view.title ? { title: view.title } : {}) }
  await setSide($, v, o.push ? 'push' : o.keep ? 'keep' : 'replace')
  const placed = await openDock($, sideTitle(v), { keys: o.keys })
  if (placed && o.ask) focusEntry($)
  return placed
}

/** The panel's title in Claude Code's chrome for what it shows. */
export function sideTitle(v: SideView): string {
  if (v.kind === 'card') return v.id
  return (v.title || paneTitle(v.pane, v.args)).slice(0, 60)
}

/** A citation or an explainer in the side panel (panes/mark.js), as the mark's thread. */
export function openMark($: Engine, frame: TrayFrame, o: { push?: boolean; ask?: boolean; keep?: boolean } = {}): Promise<boolean> {
  return openSide($, { pane: 'mark', args: { frame: { ...frame, open: null } } }, o)
}

/** The thread list in the side panel (panes/threads.js). */
export function openThreads($: Engine, o: { push?: boolean } = {}): Promise<boolean> {
  return openSide($, { pane: 'threads', args: {} }, o)
}

/** Where a thread opens again: its anchor, else what its scope names (a thread kept before anchors were). */
export function anchorOf(t: Thread): Anchor | null {
  if (t.anchor) return t.anchor
  const s = t.scope || {}
  if (s.object) return { kind: 'card', id: s.object, v: null, root: t.root, region: s.region ?? null }
  if (s.mark) {
    const m = s.mark
    const frame: TrayFrame = m.kind === 'gloss' ? { row: s.row, kind: 'gloss', label: String(m.term || m.label || '') } : { ...(s.row ? { row: s.row } : {}), kind: m.kind === 'spark' ? 'spark' : 'cite', ref: m.ref, label: String(m.label || m.ref || '') }
    return { kind: 'pane', pane: 'mark', args: { frame } }
  }
  if (s.pane) return null
  return null
}

/** A thread opened again from the list: what it is on at the top of the panel, its conversation under it. */
export async function openThread($: Engine, key: string, o: { push?: boolean } = {}): Promise<string | null> {
  const t = threadOf(key)
  if (!t) return 'That thread is not in this session any more.'
  const a = anchorOf(t)
  if (!a) return `${nameOf(t)} cannot be opened again: what it was on is not kept.`
  if (a.kind === 'card') {
    await openDetail($, { id: a.id, v: null, root: a.root }, a.region ?? null, { side: o.push ? 'push' : 'replace' })
    return null
  }
  try {
    await openSide($, { pane: a.pane, args: a.args, ...(a.title ? { title: a.title } : {}) }, { push: o.push })
  } catch {
    return `${nameOf(t)} was on a panel this version of thimble does not have (${a.pane}).`
  }
  return null
}

/** What the panel showed before what it shows now (esc goes back to it), or null. */
export async function sidePrev($: Engine): Promise<SideView | null> {
  const cur = ((await $.state.get(SIDE)).value as { back: SideView[] } | null) ?? null
  return cur?.back?.[cur.back.length - 1] ?? null
}

/** esc with nothing left to close in what the panel shows: back to what it showed before. False when there is none
 *  (the panel closes). */
export async function sideBack($: Engine): Promise<boolean> {
  const cur = ((await $.state.get(SIDE)).value as { now: SideView | null; back: SideView[] } | null) ?? null
  const prev = cur?.back?.[cur.back.length - 1]
  if (!cur || !prev) return false
  await $.state.set(SIDE, { now: prev, back: cur.back.slice(0, -1) })
  if (prev.kind === 'card') await openDetail($, { id: prev.id, v: prev.v, root: prev.root }, prev.region ?? null, { side: 'keep' })
  else await openDock($, sideTitle(prev))
  return true
}

// ------------------------------------------------------------------------------------------------ what a thread is on

/** What the side panel's thread is about now: its key and scope, the words the input bar says, the refs a question
 *  carries, where it opens again, and its name. The card detail's is detail.tsx's (cardSubject). */
export type Subject = {
  key: string
  scope: Scope
  label: string
  refs: string[]
  anchor: Anchor | null
  name: string
  about?: string
  card?: { id: string; v: number | null; title?: string; file?: string } | null
  root?: string
}

/** A pane's subject: as its module's `thread` says, else one thread per pane about the part its program selected.
 *  Null: the pane has no thread now (the thread list with no thread). */
export function paneSubject(v: Extract<SideView, { kind: 'pane' }>): Subject | null {
  const th = paneThread(v.pane, v.args)
  if (th === null) return null
  const title = (v.title || paneTitle(v.pane, v.args)).slice(0, 60)
  // a pane whose thread is one already kept (the thread list's selected row): that thread, where it is
  if (th && typeof th.key === 'string') {
    const t = threadOf(th.key)
    if (!t) return null
    const last = t.asks[t.asks.length - 1]
    return { key: t.key, scope: last?.scope ?? t.scope, label: aboutOf(last?.scope ?? t.scope), refs: last?.refs ?? [], anchor: anchorOf(t), name: nameOf(t), root: t.root }
  }
  const own = paneScope({ pane: v.pane, stateKey: String(paneOf(v.pane).stateKey(v.args || {})), title, drawing: paneDrawing(v.pane, v.args) })
  const scope: Scope = th?.scope ?? own.scope
  const refs: string[] = Array.isArray(th?.refs) ? th.refs : own.refs
  const label = String(th?.label || own.label)
  const anchor: Anchor = { kind: 'pane', pane: v.pane, args: v.args, ...(v.title ? { title: v.title } : {}) }
  return { key: threadKey(scope), scope, label, refs, anchor, name: nameOf({ scope, card: '' } as Any), ...(th?.about ? { about: String(th.about) } : {}) }
}
