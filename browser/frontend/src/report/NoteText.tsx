// A comment's words as the margin and the canvas draw them: plain prose, with each `code span` set as code, so a file
// name or a command a check names reads as one and its backticks do not show.
import type { ReactNode } from 'react'

/** `text` with each `code span` as a <code>, the rest as plain text. Pure. */
export function noteText(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part))
}
