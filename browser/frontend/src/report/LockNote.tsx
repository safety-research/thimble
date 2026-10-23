// The note in the Report tab's bar when a model's save changed a locked block and the server restored it (backend
// report_types.hold_locks, the document's `lock_reverts`): the blocks' text in the tooltip and a click that scrolls to
// the first. It shows the current generation's entries only.
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { Icon } from '../components/Icon'
import { useTooltip } from '../components/Tooltip'
import { track } from '../lib/telemetry'
import { revealAnchor } from '../lib/teleport'
import type { AnyDoc, LockRevert, Writeup } from '../lib/types'

/** The document's lock reverts of its current generation. */
export function currentReverts(doc: AnyDoc | null | undefined): LockRevert[] {
  const d = doc as Writeup | null | undefined
  const gen = d?.generation ?? 1
  return (d?.lock_reverts ?? []).filter((r) => r && r.generation === gen)
}

/** The note's label. */
export function lockNoteLabel(reverts: LockRevert[]): string {
  return reverts.length === 1 ? 'Restored a locked block' : `Restored ${reverts.length} locked blocks`
}

/** How much of a block's text the tooltip quotes: enough to tell which block it is. */
export const NOTE_TEXT_CHARS = 80

/** The note's tooltip: when it happened and the start of each block's text as the analyst locked it. */
export function lockNoteText(reverts: LockRevert[], generation?: number): string {
  const one = reverts.length === 1
  const when = generation != null ? ` in draft ${generation}` : ''
  const cut = (t: string) => (t.length > NOTE_TEXT_CHARS ? `${t.slice(0, NOTE_TEXT_CHARS - 1).trimEnd()}…` : t)
  const texts = reverts.map((r) => `“${cut(r.text.replace(/\s*…$/, '…'))}”`).join(' · ')
  return `A model changed ${one ? 'it' : 'them'}${when}; ${one ? 'it is' : 'they are'} back as you locked ${one ? 'it' : 'them'}: ${texts}`
}

/** The ⌘ pointer's anchor of a locked block's ref (decorations.ts): the title block's is the document's own ref. */
export function revertAnchor(ref: string): string {
  return ref.replace(/#title$/, '')
}

export function LockNote({ doc, root }: { doc: AnyDoc | null | undefined; root: RefObject<ParentNode | null> }) {
  const reverts = currentReverts(doc)
  const text = lockNoteText(reverts, doc?.generation)
  const { props, tip } = useTooltip(text)
  if (!reverts.length) return null
  // the first block the page shows (a list's paragraph has no anchor of its own, so a later one may be the first)
  const reveal = (e: ReactMouseEvent) => {
    e.stopPropagation()
    track('ui-click', { target: reverts[0].ref, detail: { action: 'lock-note' } })
    const el = root.current
    if (el) reverts.some((r) => revealAnchor(revertAnchor(r.ref), el))
  }
  return (
    <button type="button" className="wu-reverts" data-reverts={reverts.length} onClick={reveal} {...props}>
      <Icon name="lock" size={12} />
      {lockNoteLabel(reverts)}
      {tip}
    </button>
  )
}
