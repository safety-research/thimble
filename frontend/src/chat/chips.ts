// Chips: an act with no reply. The pure part of the callout row: which kinds carry which icon, which statuses are
// still in flight, and which stream event settles a chip's ref.
import type { IconName } from '../components/Icon'
import { kindIcon } from '../components/RefChip'
import { parseRef } from '../lib/refs'

// A chip carries the icon of what it points to, and RefChip's kindIcon is the one map from a kind of thing to its
// icon, so a label, a view or a thread wears the same glyph here as on every other surface.
export const CHIP_ICONS: Record<string, IconName> = {
  say: 'comment',
  filter: kindIcon('concept'),
  label: kindIcon('concept'),
  ticket: 'code',
  artifact: 'canvas',
  view: kindIcon('view'),
  thread: kindIcon('chat'),
  session: 'terminal',
}

/** The ref kinds that name a surface in the app; a chip whose ref is one of them wears that kind's icon. */
const SURFACE_KINDS: ReadonlySet<string> = new Set(['cell', 'group', 'concept', 'chat', 'report', 'view'])

/** A chip's icon: the icon of what its ref points to when the ref names a surface, else its kind's. */
export function chipIcon(kind: string, ref?: string | null): IconName {
  const p = ref ? parseRef(ref) : null
  if (p && SURFACE_KINDS.has(p.kind)) return kindIcon(p.kind)
  return CHIP_ICONS[kind] ?? 'flag'
}

/** A chip status the analyst is still waiting on: a document being generated, a view ticket queued or building. */
export const PENDING_STATUSES: ReadonlySet<string> = new Set(['generating', 'queued', 'building'])

export const chipPending = (status: string | undefined | null): boolean => !!status && PENDING_STATUSES.has(status)

export type Settled = 'done' | 'failed'

/**
 * What a `report` or `view` stream event says about a chip's ref: 'done' when the artifact is generated or built,
 * 'failed' when it failed, null when the event is about something else or the work is still running.
 */
export function settleChip(ref: string | undefined, event: { type: 'report' | 'view'; slug: string; status: string }): Settled | null {
  if (!ref) return null
  const p = parseRef(ref)
  if (!p) return null
  if (event.type === 'report' && p.kind === 'report' && p.slug === event.slug) {
    if (event.status === 'generated' || event.status === 'verified') return 'done'
    if (event.status === 'failed') return 'failed'
    return null
  }
  if (event.type === 'view' && p.kind === 'view' && p.slug === event.slug) {
    if (event.status === 'built') return 'done'
    if (event.status === 'failed') return 'failed'
    return null
  }
  return null
}

/** The words under a settled chip. */
export const settledWord = (s: Settled): string => (s === 'done' ? 'ready' : 'failed')

/** A document save's line: the verb in the secondary ink before the document's chip, and its generation for the hover. */
export interface DocSave {
  verb: 'wrote' | 'revised'
  generation?: number
}

/**
 * What an `artifact` chip on a document says, as one quiet line: "wrote" for its first generation, "revised" for a
 * later one or an in-place edit. Reads the chip's `generation`, or the one its text names ("the report, generation 2").
 * Null when the chip is not on a document. Pure.
 */
export function docSave(kind: string, ref: string | undefined | null, text: string, generation?: number | null): DocSave | null {
  if (kind !== 'artifact' || !ref) return null
  const p = parseRef(ref)
  if (!p || p.kind !== 'report') return null
  const n = generation ?? (Number(/generation (\d+)\s*$/.exec(text)?.[1]) || undefined)
  if (n == null) return { verb: text === 'wrote' ? 'wrote' : 'revised' }
  return { verb: n <= 1 ? 'wrote' : 'revised', generation: n }
}
