// engaged.ts: what the person engaged with (engaged.js says it in words), kept until the analyst's next prompt and
// then appended to main's transcript as one row the person never sees ($.session.append, as shell.tsx tellMain
// appends its own), just before that prompt. Claude reads it with the prompt, and the observer's pass, which forks the
// request that prompt starts, reads it in the session. Each thing is told once per session.
import type { EngineInterface } from 'claude-code'

import { sessionKey } from '../hooks/conversation'
import { askedRow, engagedText, openedRow } from './engaged.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// this session's: what was told or waits to be told, by key (a reload of the plugin may tell one again), and the lines
// waiting for the next prompt
let session = ''
const told = new Set<string>()
let waiting: string[] = []

async function keep($: Engine, row: { key: string; text: string } | null): Promise<void> {
  if (!row) return
  const id = await sessionKey($)
  if (id !== session) { session = id; told.clear(); waiting = [] }
  if (told.has(row.key)) return
  told.add(row.key)
  waiting.push(row.text)
}

/** The person opened a mark: an explainer, an important detail or a citation (a tray frame), of `message` when it is a
 *  mark of a message. */
export async function tellOpened($: Engine, frame: Any, message = ''): Promise<void> {
  await keep($, openedRow(frame, message))
}

/** The person asked a side thread a question (thread.ts askThread's ask). */
export async function tellAsked($: Engine, ask: Any): Promise<void> {
  await keep($, askedRow(ask))
}

/** Before a prompt of the analyst's (typed, or a key's turn): what they did since, as one row. */
export async function flushEngaged($: Engine): Promise<void> {
  if (!waiting.length) return
  const text = engagedText(waiting)
  waiting = []
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

/** For tests: nothing told yet. */
export function resetEngaged(): void {
  session = ''
  told.clear()
  waiting = []
}
