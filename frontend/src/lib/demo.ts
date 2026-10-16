// A demo page: a workspace read without a Claude Code session, a pre-cache `thimble demo` installed or a worked example
// `thimble demo --examples` opened, while no session has attached to it (shell/SessionGone sets it, isDemoPage). What
// works without a session stays as it is: Files, views, the canvas, the report, labels and filters. The top bar wears
// a Demo tag (shell/DemoTag), and a line under it says first that the page holds example data, not the analyst's
// files, and how to open a folder of their own (shell/DemoLine); the tour's welcome, which dims it, says it first too
// (tour/steps). The chat's composer is disabled, so nothing can be typed there, and hovering it shows DEMO_NOTE. Any
// other action that needs the session (Ask about this, a card's ask, a request in the report, an agent's start) asks
// demoStop() first: on a demo page that shows the same note in the chat (chat/DemoNote), opens the chat column when
// it is folded, and the action stops there and keeps what was typed.
import { useSyncExternalStore } from 'react'
import type { ChatMeta } from './types'

/** The top bar's tag on a demo page, and its tooltip. */
export const DEMO_TAG = 'Demo'
export const DEMO_TIP = "Example data and a finished analysis; Claude isn't connected here"
/** What hovering the disabled composer shows on a demo page, and the chat's note when an action needs Claude there. */
export const DEMO_NOTE = "This is a demo and thimble isn't connected to a live Claude Code session."
/** The line under the top bar on a demo page (shell/DemoLine), and the first line of the tour's welcome there
 * (tour/steps): example data, not the analyst's files, and how to open a folder of their own. A span in backticks is
 * drawn as code (DemoWords). */
export const DEMO_LINE = 'This is example data, not your files. To open your own folder, run `thimble` in it.'
/** The start page's line under its title while it lists a demo dataset (shell/StartPage), in the same words. */
export const DEMO_START_LINE = 'The demo datasets are example data, not your files. To open your own folder, run `thimble` in it.'

let demo = false
// the note's count: 0 while it is hidden, else how many actions asked for it since it showed
let note = 0
const subs = new Set<() => void>()
const noteSubs = new Set<() => void>()
const changed = () => subs.forEach((f) => f())

/** Whether the workspace is a demo page: `readable` without a session (a pre-cache's or a worked example's), main's meta
 * loaded, and no session attached to it now or before (one that ended shows shell/SessionGone's card instead). Pure. */
export function isDemoPage(main: Pick<ChatMeta, 'attached' | 'ended'> | null | undefined, readable: boolean): boolean {
  return readable && !!main && !main.attached && !main.ended
}

/** Record whether the page shown is a demo page; leaving one hides its note. */
export function setDemo(on: boolean): void {
  if (demo === on) return
  demo = on
  if (!on) note = 0
  changed()
}

/** Whether the page shown is a demo page. */
export const isDemo = (): boolean => demo

/** Before an action that needs Claude: on a demo page the chat's note shows (again), and true says the action stops
 * here; elsewhere false, and the action goes on. */
export function demoStop(): boolean {
  if (!demo) return false
  note += 1
  changed()
  noteSubs.forEach((f) => f())
  return true
}

/** The note's ×: it goes until the next action asks for it. */
export function dismissDemoNote(): void {
  if (!note) return
  note = 0
  changed()
}

/** Calls `fn` each time an action stops on a demo page (the shell opens a folded chat column, so the note shows).
 * Returns the unsubscribe. */
export function onDemoNote(fn: () => void): () => void {
  noteSubs.add(fn)
  return () => void noteSubs.delete(fn)
}

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => void subs.delete(f)
}

/** Whether the page shown is a demo page, as a component reads it. */
export function useDemo(): boolean {
  return useSyncExternalStore(subscribe, isDemo, () => false)
}

/** The note's count as a component reads it: 0 while hidden. */
export function useDemoNote(): number {
  return useSyncExternalStore(
    subscribe,
    () => note,
    () => 0,
  )
}
