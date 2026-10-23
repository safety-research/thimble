// engaged.ts: what the person engaged with (engaged.mjs says it in words), told to main with their next prompt through
// core/tell.ts, as lines under one head: the marks they opened in the tray (tray/), the questions they asked in a side
// thread (threads/). Claude reads them with that prompt, and the observer's look, which forks main's conversation, reads
// them there too. Each thing is told once per conversation.
//
//   tellOpened($, mark, message)   the person opened a mark of a message (engaged.mjs openedLine)
//   tellAsked($, ask)              the person asked a side thread a question (engaged.mjs askedLine)
import type { EngineInterface } from 'claude-code'

import { sessionKey } from '../hooks/conversation'
import { HEAD, askedLine, openedLine } from './engaged.mjs'
import { tellLine } from './tell'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// this conversation's: what was told (a reload of the plugin may tell one again)
let session = ''
const told = new Set<string>()

async function keep($: Engine, line: { key: string; text: string } | null): Promise<void> {
  if (!line) return
  const id = await sessionKey($)
  if (id !== session) { session = id; told.clear() }
  if (told.has(line.key)) return
  told.add(line.key)
  await tellLine($, 'engaged', HEAD, line.text)
}

export async function tellOpened($: Engine, mark: Any, message = ''): Promise<void> {
  await keep($, openedLine(mark, message))
}

export async function tellAsked($: Engine, ask: Any): Promise<void> {
  await keep($, askedLine(ask))
}

/** For tests: nothing told yet. */
export function resetEngaged(): void {
  session = ''
  told.clear()
}
