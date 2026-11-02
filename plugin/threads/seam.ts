// seam.ts: where the side threads meet the rest of thimble (core/answerview.ts, core/pane.ts and cards/tool.ts call each
// function by name, since Claude Code follows `$` only into functions a file declares or imports). The feature's own
// modules are beside this file: thread.ts (the threads, their forks, their records), threads.mjs (pure), pane.tsx (the
// list, a thread, the thread under a pane). A thread's agent is a fork of main (core/forks.ts spawnFork, kind `thread`);
// what the person asks reaches main through core/engaged.ts, an answer they send with m through core/tell.ts.
//
//   THREADS_KEYS                       its letters at an empty prompt, which no card may take (hooks/keys.ts ownKeys)
//   threadsKey($, key, until)          t: the thread list in the side pane (a taker as hooks/keys.ts takes it)
//   threadsBar($, on, preview)         its items at the bar's right (`t 2 threads`)
//   askKey($, key, until), askBar      a at an empty prompt, `a ask` at the bar's left (blue), while words of an answer
//                                      are selected (core/selection.ts; fullscreen layout only): a side thread about
//                                      them, as the tray's a opens one about a mark (askSelection)
//   drawThreadsPane($, e, kind, args, els)   the side pane of kind `threads` (the list) or `thread` (one thread: what
//                                      it is about, its turns, its input)
//   threadPaneParts($, e, args, els)   one thread's pane in two parts: what it is about with its turns, and the key row
//                                      with the input bar, which the docked pane keeps at its bottom (core/pane.ts)
//   threadKnown($, key)                whether the thread `key` is this conversation's, so the side pane can show it
//                                      again: its way back passes over one that is not (core/pane.ts)
//   openThread($, scope, {key, read})  the side pane on the thread about `scope` (a new one, or the one already about
//                                      it), its input taking the keys: the tray's `a` on a mark, a claim's question in
//                                      the claims pane; `read`, the pane taking them (the tray's +, which shows all of
//                                      a mark there); true when it opened. `key`: the key and the bar's words that open
//                                      it where the key at the prompt cannot (a narrow terminal); `click`, other words
//                                      that do
//   threadAsked($, scope)              the first question of the thread about `scope`, or null when none was asked:
//                                      the tray's `↳ thread: … · a opens it` line
//   threadUnder($, e, kind, args, els)   the thread under a pane of thimble's (evidence, labels, coverage, claims): its
//                                      conversation and its input bar, about what the pane shows (core/pane.ts)
//   threadUnderSplit($, e, kind, args, els)   the same in two parts: the conversation, and the key row with the input
//                                      bar, which the docked pane keeps at its bottom (core/pane.ts); and whether the
//                                      pane opened to ask, its input taking the keys
//   rowsUnder($, e, kind, args)        about how many rows that thread takes, for a pane that keeps its own rows in view
//   threadRing(element)                the ring moved in the side pane onto `element` (core/pane.ts): a thread's input
//                                      bar it lands on keeps it after each drawing, until the person moves it elsewhere
//   threadsPaneClosed()                the side pane closed: no thread's input bar keeps the ring
//   PaneEdit                           a field a pane edits in the input bar under it, in place of a question: the
//                                      labels pane's (labels/pane.tsx labelEdit), its name, its value, what ↵ does
//   threadPassages($, row)             what a reply's margin asks about (marks/view.ts): its passages, each a thread's
//                                      subject; `has` once a question was asked of it, `ask` opens it (openThread)
//   threadOnCard($, id, title, line, element)   what a card's margin asks about (cards/draw.ts): the part of the card
//                                      its selected `line` shows (a bar, a row a click selected), else the whole card,
//                                      as the tray's `a` asks; or the run of words a click on the card asked about
//                                      (`element`); each part has a thread of its own
//   threadCardAnchor($, agentId, id)   where a card a thread's fork drew stands: `thread:<key>`, drawn under its answer
//                                      in the thread's pane; null for any other agent (cards/tool.ts)
//   threadAnchor(agentId)              the same anchor, `thread:<key>`, with no card kept: whom a card call of the fork
//                                      is from, for what thimble keeps for it (core/tell.ts tellFor, cards/tool.ts)
//   threadQuestion(agentId)            the question a thread's fork answers, which the card check of a card it drew
//                                      reads as the request; null for any other agent (cards/tool.ts)
//   registerThreads                    its own hooks (the forks' ends, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { howTo, hintUsed } from '../bar/hints'
import { hintLine } from '../bar/notice'
import { fullscreenNow } from '../cards/draw'
import { messageOf } from '../core/answers'
import type { MarkRef } from '../core/answerview'
import { passageLabel } from '../core/askcell.js'
import { answerSelection, pickedWords, selectionNow, selectionUsed, selectionWaits, waitsNow } from '../core/selection'
import { rowHolding } from '../explain/seam'
import type { Take } from '../hooks/keys'
import { askHere, drawThreads, ringMoved, ringReleased, rowsUnder as roomUnder, threadParts, threadUnder as under, threadUnderParts, type PaneEdit } from './pane'
import { listThreads, openThreadOn, registerThreads as register, restoreThreads, threadAnchor as anchorOf, threadCardAnchor as anchor, threadCount, threadFor, threadOf, threadQuestion as question, threadsBright } from './thread'
import { cardPart, elementPart, partAbout } from './threads.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const THREADS_KEYS = ['t', 'a']

/** The color of `a ask`, the key that asks a side thread about the selected words: Claude Code's blue (the theme key of
 *  its IDE's), beside the purple, teal and orange of c, e and h. */
const ASK_COLOR = 'ide'

/** What a thread is about, as the feature that opens it names it: in words (`about`, as the list and main read it),
 *  and the thing itself: a mark of a row, a card, or a pane of thimble's with its arguments (a claim of the claims
 *  pane). `part`: a card's line that was selected when it was asked about (threads.mjs cardPart). */
export type ThreadScope = { about: string; mark?: MarkRef; passage?: { row: string; text: string }; card?: string; part?: string; pane?: { kind: string; args: unknown } }

/** A passage of a reply (marks/view.ts Passage): its words, and a few of them that name it. */
type Passage = { text: string; label: string }

/** A thread was asked about `scope` (an opened thread with no question yet was not). */
const asked = (scope: ThreadScope) => !!threadFor(scope)?.asks.length

/** t with threads: the list in the side pane, once the word window closed with no letter after it (a letter makes t
 *  the start of a word). With no thread, t types. */
export async function threadsKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (key !== 't') return null
  await restoreThreads($)
  if (!threadCount()) return null
  return { later: () => listThreads($, { fromKey: true }) }
}

/** a, or a click on `a ask`: a side thread about the words the analyst last selected with the mouse, all of them, on
 *  the answer they lie in (else the newest answer that holds them), as a passage of it: the side pane opens on it with
 *  its input taking the keys, as the tray's a opens one about a mark. The same words again open the same thread.
 *  `byKey`: a at the prompt, which opens no pane in a narrow terminal; the line then says to click `a ask`. */
export async function askSelection($: Engine, byKey = false): Promise<void> {
  const sel = await answerSelection($)
  await selectionUsed($, 'ask', sel)
  const text = String(sel?.text ?? '').replace(/\s+/g, ' ').trim()
  const { words } = pickedWords(text)
  if (!words) {
    if (fullscreenNow() === false) hintLine($, 'selecting a passage needs Claude Code\'s fullscreen layout ("tui": "fullscreen" in its settings).', 'ask')
    else await howTo($, 'ask', 'select a passage in an answer and press a to ask about it.', 'ask')
    return
  }
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { await howTo($, 'ask', 'ask Claude something, then select a passage in its answer and press a to ask about it.', 'ask'); return }
  await hintUsed($, 'ask')
  await openThreadOn($, { about: passageLabel(text), passage: { row, text: text.slice(0, 4000) } }, byKey ? { key: 'a ask' } : {})
}

/** a at an empty prompt while words wait to be asked about (core/selection.ts waitsNow): after the word window (an a
 *  that starts a word is typed), a side thread about them. With none selected, a goes on to a card's header
 *  (cards/head.ts), else it is typed. */
export async function askKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (key !== 'a' || !(await waitsNow($, 'ask'))) return null
  return { later: () => askSelection($, true) }
}

/** `a ask` at the bar's left, in blue, while words are selected that a has not asked about yet; a click does what a
 *  does. The settings' preview shows it, as it would show with words selected. */
export async function askBar($: Engine, _on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  const item = { id: 'ask', key: 'a', words: 'ask', color: ASK_COLOR }
  if (preview) return [item]
  if (!(await selectionWaits($, 'ask', await selectionNow($)))) return []
  return [{ ...item, press: () => askSelection($) }]
}

/** `t 2 threads` at the bar's right, while the session has threads: a click lists them, as t does. */
export async function threadsBar($: Engine, _on: (key: string) => boolean, _preview: boolean): Promise<BarItem[]> {
  // a drawing made right after a reload (the settings pane's preview, after a switch) reads the kept threads itself
  await restoreThreads($)
  await $.state.get({ plugin: 'thimble', key: 'threadsGen' })
  const n = threadCount()
  if (!n) return []
  return [{ id: 'threads', key: 't', words: n === 1 ? '1 thread' : `${n.toLocaleString('en-US')} threads`, ...(threadsBright() ? { bold: true } : {}), press: () => listThreads($) }]
}

export async function drawThreadsPane($: Engine, e: Any, kind: 'threads' | 'thread', args: unknown, els: Any): Promise<unknown> {
  return drawThreads($, e, kind, args, els)
}

export async function threadPaneParts($: Engine, e: Any, args: unknown, els: Any): Promise<{ body: unknown[]; bottom: unknown[] }> {
  // a drawing made right after a reload reads the kept threads itself
  await restoreThreads($).catch(() => undefined)
  return threadParts($, e, els, args)
}

/** Whether the thread `key` is this conversation's, read back from its kept folder first. A thread opened and never
 *  asked is kept in memory only, so a reload of the plugin forgets it. */
export async function threadKnown($: Engine, key: string): Promise<boolean> {
  await restoreThreads($)
  return !!threadOf(key)
}

/** The first question asked in the thread about `scope`, or null when it has none; read again when a thread changes. */
export async function threadAsked($: Engine, scope: ThreadScope): Promise<string | null> {
  await $.state.get({ plugin: 'thimble', key: 'threadsGen' })
  await restoreThreads($)
  const t = threadFor(scope)
  const q = t?.asks[0]?.text ?? t?.turns.find(x => x.role === 'person')?.text
  return q ? String(q) : null
}

export async function threadUnder($: Engine, e: Any, kind: string, args: unknown, els: Any): Promise<unknown[]> {
  return under($, e, kind, args, els)
}

export async function threadUnderSplit($: Engine, e: Any, kind: string, args: unknown, els: Any): Promise<{ conv: unknown[]; bottom: unknown[]; asking: boolean }> {
  return threadUnderParts($, e, kind, args, els)
}

/** About how many rows threadUnder takes under a pane (threads/pane.tsx rowsUnder). */
export async function rowsUnder($: Engine, e: Any, kind: string, args: unknown): Promise<number> {
  return roomUnder($, e, kind, args)
}

/** The ring moved in the side pane onto `element` (none: one of Claude Code's own stops): onto a thread's input bar,
 *  that field keeps it (threads/pane.tsx ringMoved). */
export function threadRing(element: string | undefined): void {
  ringMoved(element)
}

/** The side pane closed: no thread's input bar keeps the ring. */
export function threadsPaneClosed(): void {
  ringReleased()
}

/** A field a pane edits in the input bar under it (labels/pane.tsx labelEdit). */
export type { PaneEdit }

export async function openThread($: Engine, scope: ThreadScope, o: { key?: string; click?: string; where?: string; read?: boolean } = {}): Promise<boolean> {
  return openThreadOn($, scope, o)
}

/** A question asked at once in the thread on `scope`, as its input bar asks it (a heads-up's offer, from the tray). */
export async function askInThread($: Engine, scope: ThreadScope, text: string): Promise<void> {
  return askHere($, scope, text)
}

/** A reply's passages as the margin asks about them; read again when a thread changes. */
export async function threadPassages($: Engine, row: string): Promise<{ has: (p: Passage) => boolean; ask: (p: Passage) => unknown } | null> {
  await $.state.get({ plugin: 'thimble', key: 'threadsGen' })
  await restoreThreads($)
  const scope = (p: Passage): ThreadScope => ({ about: p.label, passage: { row, text: p.text.slice(0, 4000) } })
  return {
    has: p => asked(scope(p)),
    // the open, returned: Claude Code places the pane at any width only for an open made while the press runs
    ask: p => openThreadOn($, scope(p)).catch(() => false),
  }
}

/** A card as its frame's margin asks about it: the thread the tray's `a` opens on it. `element`: a run of its words a
 *  click asked about, and the words of its row (client.tsx), in place of the selected line. */
export async function threadOnCard($: Engine, id: string, title: string, line = '', element?: { text: string; line: string }): Promise<{ label: string; has: boolean; press: () => unknown } | null> {
  await $.state.get({ plugin: 'thimble', key: 'threadsGen' })
  await restoreThreads($)
  const about = `the card "${title || id}"`
  const part = element ? elementPart(element.text, element.line) : cardPart(line)
  const scope: ThreadScope = part ? { about: partAbout(about, part), card: id, part } : { about, card: id }
  return { label: scope.about, has: asked(scope), press: () => openThreadOn($, scope).catch(() => false) }
}

export async function threadCardAnchor($: Engine, agentId: string | undefined, cardId: string): Promise<string | null> {
  return anchor($, agentId, cardId)
}

export function threadAnchor(agentId: string | undefined): string | null {
  return anchorOf(agentId)
}

export function threadQuestion(agentId: string | undefined): string | null {
  return question(agentId)
}

export const registerThreads: Register = (on, options) => register(on, options)
