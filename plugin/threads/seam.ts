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
//   threadCardAnchor($, agentId, id)   where a card a thread's fork drew stands: `thread:<key>`, drawn under its answer
//                                      in the thread's pane; null for any other agent (cards/tool.ts)
//   registerThreads                    its own hooks (/threads, the forks' ends, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { MarkRef } from '../core/answerview'
import type { Take } from '../hooks/keys'
import { drawThreads, threadUnder as under } from './pane'
import { listThreads, openThreadOn, registerThreads as register, restoreThreads, threadCardAnchor as anchor, threadCount, threadFor } from './thread'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const THREADS_KEYS = ['t']

/** What a thread is about, as the feature that opens it names it: in words (`about`, as the list and main read it),
 *  and the thing itself: a mark of a row, a card, or a pane of thimble's with its arguments (a claim of the claims
 *  pane). */
export type ThreadScope = { about: string; mark?: MarkRef; card?: string; pane?: { kind: string; args: unknown } }

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
  return [{ id: 'threads', key: 't', words: n === 1 ? '1 thread' : `${n.toLocaleString('en-US')} threads`, press: () => listThreads($) }]
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

export async function openThread($: Engine, scope: ThreadScope): Promise<boolean> {
  return openThreadOn($, scope)
}

export async function threadCardAnchor($: Engine, agentId: string | undefined, cardId: string): Promise<string | null> {
  return anchor($, agentId, cardId)
}

export const registerThreads: Register = (on, options) => register(on, options)
