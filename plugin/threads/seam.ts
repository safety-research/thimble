// seam.ts: where the side threads meet the rest of thimble (core/answerview.ts and core/pane.ts call each function by
// name, since Claude Code follows `$` only into functions a file declares or imports). The base leaves each one doing
// nothing; the feature fills them in, with its own modules beside this file (0.10: shell/thread.ts, shell/threads.js,
// the thread list's pane program panes/threads.js, the side panel shell/side.ts, prompts/thread.md). A thread's agent is
// a fork of main (core/forks.ts spawnFork, kind `thread`); what the person asks reaches main through core/engaged.ts.
//
//   THREADS_KEYS                       its letters at an empty prompt, which no card may take (hooks/keys.ts OWN_KEYS)
//   threadsKey($, key, until)          t: the thread list in the side pane (a taker as hooks/keys.ts takes it)
//   threadsBar($, on, preview)         its items at the bar's right (`t 2 threads`)
//   drawThreadsPane($, e, kind, args, els)   the side pane of kind `threads` (the list) or `thread` (one thread: what
//                                      it is about, its turns, its input)
//   openThread($, scope)               the side pane on the thread about `scope` (a new one, or the one already about
//                                      it), its input taking the keys: the tray's `a` on a mark, a claim's question in
//                                      the claims pane; true when it opened
//   registerThreads                    its own hooks (/threads, the forks' ends, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { MarkRef } from '../core/answerview'
import type { Take } from '../hooks/keys'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const THREADS_KEYS = ['t']

/** What a thread is about, as the feature that opens it names it: in words (`about`, as the list and main read it),
 *  and the thing itself: a mark of a row, a card, or a pane of thimble's with its arguments (a claim of the claims
 *  pane). */
export type ThreadScope = { about: string; mark?: MarkRef; card?: string; pane?: { kind: string; args: unknown } }

export async function threadsKey(_$: Engine, _key: string, _until: number): Promise<Take | null> {
  return null
}

export async function threadsBar(_$: Engine, _on: (key: string) => boolean, _preview: boolean): Promise<BarItem[]> {
  return []
}

export async function drawThreadsPane(_$: Engine, _e: Any, _kind: 'threads' | 'thread', _args: unknown, els: Any): Promise<unknown> {
  return els.Text({ dimColor: true, children: 'No side threads yet.' })
}

export async function openThread(_$: Engine, _scope: ThreadScope): Promise<boolean> {
  return false
}

export const registerThreads: Register = () => undefined
