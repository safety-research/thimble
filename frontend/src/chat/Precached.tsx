// A workspace `thimble demo` installed from a pre-cache (backend precached.py): its orientation ran in advance, on the
// same files. The orientation's thread opens with a card that says so: when it ran, on what model, what it left, and
// whether its Claude Code session came with it (a full export's mark says `kept`, and a message in its thread then
// continues it). Once a session is attached the card says so. Until then the page is a demo page (lib/demo): the
// composer stays, and a message sent from it shows the chat's demo note (chat/DemoNote) rather than going anywhere.
import { Card } from '../components/Card'
import type { ChatMeta, PrecachedMark } from '../lib/types'

export const PRECACHED_TITLE = 'This orientation ran in advance'
export const ATTACHED_NOTE = 'A Claude Code session is attached. It started from these cards and the report.'

/** The pre-cache's mark, from the orientation's meta that carries one; null in a workspace not installed from a
 * pre-cache. Pure. */
export function precachedMark(metas: readonly ChatMeta[]): PrecachedMark | null {
  const m = metas.find((x) => x.precached && x.role === 'orient')
  return m?.precached ? { ...m.precached, orientation: m.precached.orientation ?? m.id } : null
}

/** Whether the pre-cached orientation takes a message: its session came with a full export. Pure. */
export function takesFollowUps(mark: PrecachedMark | null): boolean {
  return !!mark?.kept
}

const COUNTED: readonly [keyof NonNullable<PrecachedMark['counts']>, string, string][] = [
  ['cards', 'card', 'cards'],
  ['labels', 'label', 'labels'],
  ['views', 'view', 'views'],
  ['documents', 'document', 'documents'],
]

/** What the pre-cache holds, from the counts its mark keeps (`Its 8 cards, 5 labels, 1 view and 1 document are
 * here.`); a mark from before it kept them names the shipped pre-caches' outputs. Pure. */
export function heldText(mark: PrecachedMark): string {
  const c = mark.counts
  if (!c) return 'Its cards, labels, views and report are here.'
  const shown = COUNTED.filter(([k]) => (c[k] ?? 0) > 0)
  if (!shown.length) return 'It left no cards, labels, views or documents.'
  const parts = shown.map(([k, one, many]) => `${c[k]} ${c[k] === 1 ? one : many}`)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  return `Its ${list} ${shown.length === 1 && c[shown[0][0]] === 1 ? 'is' : 'are'} here.`
}

/** What the card says of the run: when, on what model, what it left, and what was kept. Pure. */
export function precachedText(mark: PrecachedMark): string {
  const ran = mark.ran ?? mark.created
  const when = ran ? ` on ${ran.slice(0, 10)}` : ''
  const model = mark.model ? ` with ${mark.model.replace('[1m]', '')}` : ''
  const session = takesFollowUps(mark)
    ? 'Its Claude Code session came with them, so a message here continues it.'
    : 'Its Claude Code session is not, so it takes no follow-ups.'
  return `It ran${when}${model}, on these same files, before thimble was installed here. ${heldText(mark)} ${session}`
}

/** The card at the top of a pre-cached orientation's thread. */
export function PrecachedCard({ mark, attached }: { mark: PrecachedMark; attached: boolean }) {
  return (
    <Card className="precached-card chat-row" head={PRECACHED_TITLE} flat data-precached={mark.dataset ?? ''}>
      <p className="precached-text">{precachedText(mark)}</p>
      {attached && <p className="precached-note">{ATTACHED_NOTE}</p>}
    </Card>
  )
}
