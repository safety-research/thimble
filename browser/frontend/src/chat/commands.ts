// The slash commands the chat's composer handles itself, the one list of them. A handler reads a message with
// commandIn, which knows only these, so each command the composer handles is listed here (rewind.ts isRewindCommand
// and fix.ts fixWords, which ChatPanel's send asks first). A "/" at the start of the composer lists the commands the
// text can still become (commandsFor), each with what it does, as Claude Code lists its own (chat/Composer.tsx), so a
// command added here is in that list too.
import { FIX_DESCRIPTION } from '../../../../plugin/fix/command.mjs'

export interface ChatCommand {
  /** the command as the analyst types it, slash first */
  name: string
  /** what it does, in a few words, after the name in the list */
  about: string
}

/** A change to the person's own thimble (fix.ts), with the description the terminal's command is registered with
 * (plugin/fix/command.mjs). */
export const FIX_COMMAND = '/thimble-fix'

/** Main back to before the analyst's latest message there, asked first under the message (rewind.ts). */
export const REWIND_COMMAND = '/rewind'

export const COMMANDS: readonly ChatCommand[] = [
  { name: FIX_COMMAND, about: FIX_DESCRIPTION },
  { name: REWIND_COMMAND, about: 'Take main back to before your latest message' },
]

/** The command a message is, space before it aside, and the words after it, trimmed; null for a message that starts
 * with none of `commands`. Pure. */
export function commandIn(text: string, commands: readonly ChatCommand[] = COMMANDS): { name: string; words: string } | null {
  const m = /^\s*(\/\S+)(?:\s+([\s\S]*))?$/.exec(text)
  return m && commands.some((c) => c.name === m[1]) ? { name: m[1], words: (m[2] ?? '').trim() } : null
}

/** The commands the composer's text can still become while it is a "/" at the start and part of a name, with no space
 * yet: those whose name holds what follows the slash, the name typed in full first, then the ones it starts; none for
 * any other text. Pure. */
export function commandsFor(text: string, commands: readonly ChatCommand[] = COMMANDS): readonly ChatCommand[] {
  const m = /^\/(\S*)$/.exec(text)
  if (!m) return []
  const typed = m[1].toLowerCase()
  const name = (c: ChatCommand) => c.name.slice(1).toLowerCase()
  const rank = (c: ChatCommand) => (name(c) === typed ? 0 : name(c).startsWith(typed) ? 1 : 2)
  return commands.filter((c) => name(c).includes(typed)).sort((a, b) => rank(a) - rank(b))
}
