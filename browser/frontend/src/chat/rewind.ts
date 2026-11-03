// Rewind main to one of the analyst's messages, as Claude Code's /rewind restores a conversation (backend
// runtime.rewind_main): Claude no longer sees that message or anything after it, the chat hides them from the message
// to the rewind's line (model rewoundRecords), and the message's words come back in the composer to change and send
// again. Each of the analyst's messages in main has its ↶ (Rows RewindAsk); `/rewind` asks it for the latest.
import type { ChatRecord } from '../lib/types'
import { isRewindable } from './model'

/** Whether the composer's text is the `/rewind` command. Pure. */
export const isRewindCommand = (text: string): boolean => /^\s*\/rewind\s*$/.test(text)

/** The toast when `/rewind` finds no message of the analyst's in main to go back to. */
export const NOTHING_TO_REWIND = 'Nothing to rewind yet: main has no message of yours.'

/** The latest of the analyst's messages that main's chat shows (not in `skip`): its event and its place in the log, or
 * null when there is none. Pure. */
export function lastRewindable(records: readonly ChatRecord[], skip: ReadonlySet<number>): { event: string; index: number } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!skip.has(i) && isRewindable(r)) return { event: r.event!, index: i }
  }
  return null
}
