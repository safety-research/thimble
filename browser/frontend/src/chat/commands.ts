// The slash commands the chat's composer handles itself, the one list of them. A handler reads a message with
// commandIn, which knows only these, so each command the composer handles is listed here (fix.ts fixWords, which
// ChatPanel's send asks first). A "/" at the start of the composer lists the commands the text can still become
// (commandsFor), each with what it does, as Claude Code lists its own (chat/Composer.tsx), so a command added here is
// in that list too.
import fixFile from '../../../../plugin/commands/thimble-fix.md?raw'

export interface ChatCommand {
  /** the command as the analyst types it, slash first */
  name: string
  /** what it does, in a few words, after the name in the list */
  about: string
}

/** The `description` of a command file's frontmatter (plugin/commands/<name>.md), which Claude Code's list shows beside
 * the command; null when the file has none. Pure. */
export function descriptionOf(file: string): string | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file)?.[1] ?? ''
  const raw = /^description:[ \t]*(.*?)[ \t]*$/m.exec(head)?.[1] ?? ''
  let text = raw
  if (/^".*"$/.test(raw)) {
    try {
      text = JSON.parse(raw) as string
    } catch {
      text = raw.slice(1, -1)
    }
  } else if (/^'.*'$/.test(raw)) text = raw.slice(1, -1).replace(/''/g, "'")
  return text.trim() || null
}

/** A change to the person's own thimble (fix.ts), with the description of the terminal's command
 * (plugin/commands/thimble-fix.md). */
export const FIX_COMMAND = '/thimble-fix'

export const COMMANDS: readonly ChatCommand[] = [{ name: FIX_COMMAND, about: descriptionOf(fixFile) ?? 'make a change to thimble' }]

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
