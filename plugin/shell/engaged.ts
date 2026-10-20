// engaged.ts: the rows of engaged.js appended to main's transcript, each what the person engaged with, once per session.
// They are rows the person never sees ($.session.append, as shell.tsx tellMain appends its own), so Claude reads them
// with its next request and the observer's pass reads them in the session it forks.
import type { EngineInterface } from 'claude-code'

import { sessionKey } from '../hooks/conversation'
import { askedRow, openedRow } from './engaged.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// what was told in this session, by key (a reload of the plugin may tell one again)
let session = ''
const told = new Set<string>()

async function tell($: Engine, row: { key: string; text: string } | null): Promise<void> {
  if (!row) return
  const id = await sessionKey($)
  if (id !== session) { session = id; told.clear() }
  if (told.has(row.key)) return
  told.add(row.key)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: row.text }] } })
}

/** The person opened a mark: an explainer, an important detail or a citation (a tray frame), of `message` when it is a
 *  mark of a message. */
export async function tellOpened($: Engine, frame: Any, message = ''): Promise<void> {
  await tell($, openedRow(frame, message))
}

/** The person asked a side thread a question (thread.ts askThread's ask). */
export async function tellAsked($: Engine, ask: Any): Promise<void> {
  await tell($, askedRow(ask))
}

/** For tests: nothing told yet. */
export function resetEngaged(): void {
  session = ''
  told.clear()
}
