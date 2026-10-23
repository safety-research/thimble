// seam.ts: where the side threads meet the rest of thimble (core/answerview.ts, core/pane.ts and cards/tool.ts call each
// function by name, since Claude Code follows `$` only into functions a file declares or imports). The feature's own
// modules are beside this file: thread.ts (the threads, their forks, their records), threads.mjs (pure), pane.tsx (the
// list, a thread, the thread under a pane). A thread's agent is a fork of main (core/forks.ts spawnFork, kind `thread`);
// what the person asks reaches main through core/engaged.ts, an answer they send with m through core/tell.ts.
//
//   THREADS_KEYS                       its letters at an empty prompt, which no card may take (hooks/keys.ts ownKeys)
//   threadsKey($, key, until)          t: the thread list in the side pane (a taker as hooks/keys.ts takes it)
//   threadsBar($, on, preview)         its items at the bar's right (`t 2 threads`)
//   drawThreadsPane($, e, kind, args, els)   the side pane of kind `threads` (the list) or `thread` (one thread: what
//                                      it is about, its turns, its input)
//   openThread($, scope)               the side pane on the thread about `scope` (a new one, or the one already about
//                                      it), its input taking the keys: the tray's `a` on a mark, a claim's question in
//                                      the claims pane; true when it opened
//   threadAsked($, scope)              the first question of the thread about `scope`, or null when none was asked:
//                                      the tray's `↳ thread: … · a opens it` line
//   threadUnder($, e, kind, args, els)   the thread under a pane of thimble's (evidence, labels, coverage, claims): its
//                                      conversation and its input bar, about what the pane shows (core/pane.ts)
//   rowsUnder($, e, kind, args)        about how many rows that thread takes, for a pane that keeps its own rows in view
//   threadPassages($, row)             what a reply's margin asks about (marks/view.ts): its passages, each a thread's
//                                      subject; `has` once a question was asked of it, `ask` opens it (openThread)
//   threadOnCard($, id, title, line)   what a card's margin asks about (cards/draw.ts): the part of the card its
//                                      selected `line` shows (a bar, a row a click selected), else the whole card, as
//                                      the tray's `a` asks; each part has a thread of its own
//   threadCardAnchor($, agentId, id)   where a card a thread's fork drew stands: `thread:<key>`, drawn under its answer
//                                      in the thread's pane; null for any other agent (cards/tool.ts)
//   registerThreads                    its own hooks (/threads, the forks' ends, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { MarkRef } from '../core/answerview'
import type { Take } from '../hooks/keys'
import { drawThreads, rowsUnder as roomUnder, threadUnder as under } from './pane'
import { listThreads, openThreadOn, registerThreads as register, restoreThreads, threadCardAnchor as anchor, threadCount, threadFor, threadsBright } from './thread'
import { cardPart, partAbout } from './threads.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const THREADS_KEYS = ['t']

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

/** `t 2 threads` at the bar's right, while the session has threads: a click lists them, as t does. */
export async function threadsBar($: Engine, _on: (key: string) => boolean, _preview: boolean): Promise<BarItem[]> {
  await $.state.get({ plugin: 'thimble', key: 'threadsGen' })
  const n = threadCount()
  if (!n) return []
  return [{ id: 'threads', key: 't', words: n === 1 ? '1 thread' : `${n.toLocaleString('en-US')} threads`, ...(threadsBright() ? { bold: true } : {}), press: () => listThreads($) }]
}

export async function drawThreadsPane($: Engine, e: Any, kind: 'threads' | 'thread', args: unknown, els: Any): Promise<unknown> {
  return drawThreads($, e, kind, args, els)
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

/** About how many rows threadUnder takes under a pane (threads/pane.tsx rowsUnder). */
export async function rowsUnder($: Engine, e: Any, kind: string, args: unknown): Promise<number> {
  return roomUnder($, e, kind, args)
}

export async function openThread($: Engine, scope: ThreadScope): Promise<boolean> {
  return openThreadOn($, scope)
}

/** A reply's passages as the margin asks about them; read again when a thread changes. */
export async function threadPassages($: Engine, row: string): Promise<{ has: (p: Passage) => boolean; ask: (p: Passage) => unknown }> {
  await $.state.get({ plugin: 'thimble', key: 'threadsGen' })
  await restoreThreads($)
  const scope = (p: Passage): ThreadScope => ({ about: p.label, passage: { row, text: p.text.slice(0, 4000) } })
  return {
    has: p => asked(scope(p)),
    ask: p => { void openThreadOn($, scope(p)).catch(() => undefined) },
  }
}

/** A card as its frame's margin asks about it: the thread the tray's `a` opens on it. */
export async function threadOnCard($: Engine, id: string, title: string, line = ''): Promise<{ label: string; has: boolean; press: () => unknown }> {
  await $.state.get({ plugin: 'thimble', key: 'threadsGen' })
  await restoreThreads($)
  const about = `the card "${title || id}"`
  const part = cardPart(line)
  const scope: ThreadScope = part ? { about: partAbout(about, part), card: id, part } : { about, card: id }
  return { label: scope.about, has: asked(scope), press: () => { void openThreadOn($, scope).catch(() => undefined) } }
}

export async function threadCardAnchor($: Engine, agentId: string | undefined, cardId: string): Promise<string | null> {
  return anchor($, agentId, cardId)
}

export const registerThreads: Register = (on, options) => register(on, options)
