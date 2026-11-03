// Rewind main to one of the analyst's messages, as Claude Code's /rewind restores a conversation (backend
// runtime.rewind_main): Claude no longer sees that message or anything after it, the chat hides them from the message
// to the rewind's line (model rewoundRecords), and the message's words come back in the composer to change and send
// again, with those of the analyst's later messages that main had not read yet, which the rewind takes back too. Main's
// log holds each of its chats, and main's conversation is the latest one's, so a rewind goes back only to a message
// after the latest chat line (chatStart). Each of the analyst's messages there has its ↶ (Rows RewindAsk); `/rewind`
// asks it for the latest. The words come back from the rewind's reply, or, for a page that never got the reply, from
// the rewind's line, once per browser (wordsOnLine, wordsPutBack).
import type { ChatRecord } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { commandIn, REWIND_COMMAND } from './commands'
import { isRewindable, REWIND_CHIP } from './model'

/** Whether the composer's text is the `/rewind` command alone, as the composer's list of its commands reads it
 * (commands.ts commandIn). Pure. */
export function isRewindCommand(text: string): boolean {
  const typed = commandIn(text)
  return typed?.name === REWIND_COMMAND && typed.words === ''
}

/** The toast when `/rewind` finds no message of the analyst's in main's current chat to go back to. */
export const NOTHING_TO_REWIND = 'Nothing to rewind yet: you have sent main no message since this chat started or resumed.'

/** The texts of main's lines where a chat starts or comes back, `session` chips (backend runtime.NEW_CHAT and
 * RESUMED_CHAT, the start of the line it formats). */
export const NEW_CHAT_LINE = 'New chat'
export const RESUMED_CHAT_LINE = 'Resumed the chat that began with: '

/** The place in main's log of the first record of main's current chat: the one after the latest line where a chat
 * starts or comes back, 0 when there is none (backend runtime._chat_start). Pure. */
export function chatStart(records: readonly ChatRecord[]): number {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.type !== 'chip' || r.kind !== 'session') continue
    const text = String(r.text ?? '')
    if (text === NEW_CHAT_LINE || text.startsWith(RESUMED_CHAT_LINE)) return i + 1
  }
  return 0
}

/** The latest of the analyst's messages in main's current chat that the chat shows (not in `skip`): its event and its
 * place in the log, or null when there is none. Pure. */
export function lastRewindable(records: readonly ChatRecord[], skip: ReadonlySet<number>): { event: string; index: number } | null {
  const start = chatStart(records)
  for (let i = records.length - 1; i >= start; i--) {
    const r = records[i]
    if (!skip.has(i) && isRewindable(r)) return { event: r.event!, index: i }
  }
  return null
}

/** The words the latest rewind gave back, from its line in main's log, which keeps them (backend rewind_main), while
 * the analyst has sent main no message since: the line's event and the words, or null. Pure. */
export function wordsOnLine(records: readonly ChatRecord[]): { event: string; words: string } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (isRewindable(r)) return null
    if (r.type === 'chip' && r.kind === REWIND_CHIP && typeof r.event === 'string') {
      return typeof r.words === 'string' && r.words ? { event: r.event, words: r.words } : null
    }
  }
  return null
}

const PUT_BACK = 'rewind-words'

/** The event of workspace `ws`'s latest rewind whose words this browser put back in main's composer (localStorage),
 * so the next load of the page does not put them back again; null for none, or when the storage cannot be read. */
export function wordsPutBack(ws: string): string | null {
  const v = readStorage<unknown>(storageKey(ws, PUT_BACK), null)
  return typeof v === 'string' ? v : null
}

/** Notes that this browser put back the words of workspace `ws`'s rewind `event` in main's composer. */
export function notePutBack(ws: string, event: string): void {
  writeStorage(storageKey(ws, PUT_BACK), event)
}
