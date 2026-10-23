// thimble fix in the page (backend fixes.py): `/thimble-fix <words>` in the chat asks Claude to change the person's own
// thimble. The words go with a text copy of what the page shows now (pageText), so "this card" can name what is open.
// As in the terminal, main reads the words with the person's fixes beside it and starts the fix with its fix_thimble
// tool: a round of the fix the words follow up on, or a new fix, or first one short question. The fixer works in the
// background in a thread of its own (`fixing <name>` in the tree), main's chat shows the message, main's line and one
// line that points there, the row above the composer says how the work goes, and one notice at the top of the chat
// says how it ended (FixStrip), from GET /api/fixes and the stream's `fix` events. A message in a fix's own thread
// changes that fix (a round of it, never a new fix). `/thimble-fix` alone opens Your fixes.

export const FIX_COMMAND = '/thimble-fix'

/** The words after /thimble-fix in a chat message, or null when the message is no /thimble-fix. Pure. */
export function fixWords(text: string): string | null {
  const m = /^\s*\/thimble-fix(?:\s+([\s\S]*))?$/.exec(text)
  return m ? (m[1] ?? '').trim() : null
}

/** One fix the row can show (backend fixes.status). */
export interface FixRow {
  id: number
  title: string
  /** the kernel's state: working, ready, failed, on, off, redo, request, ... */
  state: string
  /** what this server does with it now; null once it ended */
  phase: 'fixing' | 'testing' | 'applying' | 'restarting' | null
  /** how it ended, until dismissed: ready (it asks the person), fixed (on), failed, request, undone, problem */
  kind: 'ready' | 'fixed' | 'failed' | 'request' | 'undone' | 'problem' | null
  said: string | null
  /** the person's words (the last round's) */
  words: string
  /** what the fixer says it did */
  summary?: string
  /** a round of a fix the person has: the version they have stays until Use it now */
  change?: boolean
  /** how many files it changed */
  files?: number
  tests: string | null
  error: string | null
  created?: number
  at: number
}

export interface FixStatus {
  problem: string
  fixes: FixRow[]
}

/** Whether the fix is in the work before the person's notice: Claude fixes it, or the kernel checks it. */
export const working = (r: FixRow): boolean => r.phase === 'fixing' || r.phase === 'testing'

/** Whether the fix goes on now, after the person's click (or comes off after Undo): the server starts again. */
export const reloading = (r: FixRow): boolean => r.phase === 'applying' || r.phase === 'restarting'

/** The row above the composer while Claude works: what it fixes, by the fix's name, and for how long so far. Pure. */
export function workingText(r: FixRow, now: number = Date.now() / 1000): string {
  const secs = r.created ? Math.max(0, Math.round(now - r.created)) : null
  const took = secs === null ? '' : ` · ${secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`}`
  const doing = r.phase === 'testing' ? 'Testing' : r.change ? 'Changing' : 'Fixing'
  return `${doing} “${r.title || r.words}”${took}`
}

/** The notice's words for a fix. Pure. */
export function fixText(r: FixRow): string {
  if (reloading(r)) return 'Reloading thimble…'
  if (working(r)) return workingText(r)
  return r.said || r.title
}

export type FixAction = 'use' | 'what' | 'later' | 'undo' | 'redo'

/** The buttons a fix's notice offers: Use it now, What changed and Later on a ready fix, Undo on a fix that is on,
 * Redo on one that did not pass. Pure. */
export function fixActions(r: FixRow): FixAction[] {
  if (r.phase) return []
  if (r.kind === 'ready' && r.state === 'ready') return ['use', 'what', 'later']
  if (r.kind === 'fixed' && r.state === 'on') return ['undo']
  if ((r.kind === 'failed' || r.kind === 'problem') && ['failed', 'off', 'redo', 'ready', 'request'].includes(r.state)) return ['redo']
  return []
}

/** What changed, in a few lines and not a diff: the person's words, what Claude did, how many files and the tests.
 * Pure. */
export function changedLines(r: FixRow): { label: string; text: string }[] {
  const n = r.files ?? 0
  const tests = r.tests === 'passed' ? 'tests pass' : r.tests === 'failed' ? 'tests failed' : 'tests not run'
  return [
    ...(r.words ? [{ label: 'You asked', text: r.words }] : []),
    ...(r.summary ? [{ label: 'Claude did', text: r.summary }] : []),
    { label: 'Changed', text: `${n} file${n === 1 ? '' : 's'} · ${tests}` },
  ]
}

/** How Your fixes names a fix's state. */
export const STATE_WORDS: Record<string, string> = {
  working: 'Claude works on it', ready: 'ready', on: 'on', off: 'off', failed: 'did not pass', redo: 'needs a redo',
  request: 'request, no code', sent: 'sent', saved: 'saved as files', released: 'in the release',
}

const PAGE_PART = 3000
const PAGE_ALL = 8000

function textOf(el: Element): string {
  const t = (el as HTMLElement).innerText ?? el.textContent ?? ''
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** A text copy of what the page shows now: the card open in focus (its title and text), the dialog open, and each
 * pane of the main area, each cut to a few thousand characters. */
export function pageText(doc: Document = document): string {
  const parts: string[] = []
  const card = doc.querySelector<HTMLElement>('.bfocus-card')
  if (card) parts.push(`The card open in focus (${card.dataset.anchor ?? 'card'}), "${card.dataset.anchorText ?? ''}":\n${textOf(card).slice(0, PAGE_PART)}`)
  for (const d of Array.from(doc.querySelectorAll('[role="dialog"]'))) {
    const label = d.getAttribute('aria-label') ?? 'a dialog'
    parts.push(`The open dialog, ${label}:\n${textOf(d).slice(0, PAGE_PART)}`)
  }
  for (const pane of Array.from(doc.querySelectorAll<HTMLElement>('[data-pane][data-surface]'))) {
    parts.push(`The ${pane.dataset.surface} panel:\n${textOf(pane).slice(0, PAGE_PART)}`)
  }
  return parts.join('\n\n').slice(0, PAGE_ALL)
}
