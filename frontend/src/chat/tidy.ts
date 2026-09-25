// What a chat leaves out of the records it shows, so a session's transcript reads as its work: a workflow agent's
// harness preamble before its task, and repeats of the capacity error Claude Code writes into the transcript on every
// retry (the strip's retry line already says it waits). Pure.
import { API_ERROR, type Row } from './model'

/** The words that open a workflow agent's first message, before the task (Claude Code's Workflow tool). */
export const HARNESS_OPENING = '[Workflow harness'
/** The words that end the preamble; the task follows, each of its lines indented by two spaces. */
export const HARNESS_TASK_FOLLOWS = 'The computed task text follows:'

/** A workflow agent's first message without the harness's preamble: the task it was given, its lines unindented; any
 * other text as it is. Pure. */
export function withoutHarness(text: string): string {
  if (!text.startsWith(HARNESS_OPENING)) return text
  const at = text.indexOf(HARNESS_TASK_FOLLOWS)
  if (at < 0) return text
  const task = text
    .slice(at + HARNESS_TASK_FOLLOWS.length)
    .split('\n')
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim()
  return task || text
}

/** An error text Claude Code wrote once per retry, each copy once: a run of the same message, which a transcript may
 * hold as one text, is that message alone. Any other text is returned as it is. Pure. */
export function onceEach(text: string): string {
  const t = text.trim()
  if (!t.startsWith(API_ERROR)) return text
  const parts = t.split(new RegExp(`(?=${API_ERROR})`)).map((p) => p.trim()).filter(Boolean)
  return parts.filter((p, i) => p !== parts[i - 1]).join('\n')
}

/** The rows a chat shows: a workflow agent's first message as its task alone, and an error text that repeats the last
 * text shown (calls between them do not count) left out. Pure; the rows given are not changed. */
export function tidyRows(rows: readonly Row[]): Row[] {
  const out: Row[] = []
  let lastText: string | null = null
  for (const r of rows) {
    if (r.kind === 'user') {
      lastText = null
      const text = withoutHarness(r.text)
      out.push(text === r.text ? r : { ...r, text })
      continue
    }
    if (r.kind === 'text') {
      const text = onceEach(r.text)
      if (text.trim().startsWith(API_ERROR) && text.trim() === lastText) continue
      lastText = text.trim()
      out.push(text === r.text ? r : { ...r, text })
      continue
    }
    out.push(r)
  }
  return out
}
