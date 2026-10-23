// thimble fix in the page (backend fixes.py): `/thimble-fix <words>` in the chat asks Claude to change the person's own
// thimble. The words go with a text copy of what the page shows now (pageText), so "this card" can name what is open.
// The server answers at once; the row above the composer (FixStrip) says how the fix goes, from GET /api/fixes and the
// stream's `fix` events.

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
  /** how it ended, until dismissed: fixed, failed, request, undone, problem */
  kind: 'fixed' | 'failed' | 'request' | 'undone' | 'problem' | null
  said: string | null
  words: string
  tests: string | null
  error: string | null
  at: number
}

export interface FixStatus {
  problem: string
  fixes: FixRow[]
}

const PHASE_WORDS: Record<NonNullable<FixRow['phase']>, (r: FixRow) => string> = {
  fixing: (r) => `Fixing: ${r.words || r.title} · Claude works in a copy of thimble`,
  testing: (r) => `Testing fix ${r.id}: ${r.title}`,
  applying: (r) => `Putting fix ${r.id} on: ${r.title}`,
  restarting: (r) => `thimble restarts with fix ${r.id}: ${r.title}`,
}

/** The row's words for a fix. Pure. */
export function fixText(r: FixRow): string {
  if (r.phase) return PHASE_WORDS[r.phase](r)
  return r.said || r.title
}

/** The buttons a fix's row offers: Undo on a fix that is on, Redo on one that did not pass. Pure. */
export function fixActions(r: FixRow): ('undo' | 'redo')[] {
  if (r.phase) return []
  if (r.kind === 'fixed' && r.state === 'on') return ['undo']
  if ((r.kind === 'failed' || r.kind === 'problem') && ['failed', 'off', 'redo', 'ready', 'request'].includes(r.state)) return ['redo']
  return []
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
