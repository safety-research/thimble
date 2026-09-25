// The checks in views without the margin (slides, story, a page): a sentence a shown comment is on takes its check's
// tint, and on hover or pick an opaque card at the pane's top right lists its comments with their refs and, given
// `EvidenceActions`, ✓ to resolve one. `docComments` gives the Checks pane a document's comments; `useEvidence` gives a
// view the tints and hover handlers; `EvidencePop` is the card.
import { createContext, useContext, useMemo, useState, type MouseEvent } from 'react'
import { compactLabel } from '../components/RefChip'
import type { AnyDoc } from '../lib/types'
import { openComments, passageFlags, shownComments, type CheckLook, type DocComment, type Flag } from './checkComments'
import { Glyph, IconButton } from './icons'
import { allSentences, asWriteup, paragraphOf, passageOrder, shapeOf } from './model'

/** What the evidence card can do beyond showing: resolve a stored comment (the margin's ✓). */
export interface EvidenceActionsValue {
  onResolve?: (comment: DocComment) => void
}
export const EvidenceActions = createContext<EvidenceActionsValue>({})

export interface Evidence {
  flags: ReadonlyMap<string, Flag>
  /** the comments of the passage the pointer rests on, else of the picked one */
  hovered: DocComment[]
  onOver: (e: MouseEvent) => void
  onLeave: () => void
}

/** A document's open comments, whatever its shape, in reading order. In a deck or a story a comment on a slide or a
 * beat as a whole (its id, as add_comment and a check leave one on a slide's heading) tints every line of it, since
 * neither view marks a heading. */
export function docComments(doc: AnyDoc): DocComment[] {
  const view = asWriteup(doc)
  const out = openComments(view.comments, allSentences(view), passageOrder(view), paragraphOf(view))
  if (shapeOf(doc) === 'document') return out
  const units = new Map((view.sections ?? []).map((sec) => [sec.id, (sec.paragraphs ?? []).flatMap((pa) => (pa.sentences ?? []).map((x) => x.id))]))
  return out.map((c) => (units.get(c.sid)?.length ? { ...c, span: units.get(c.sid)! } : c))
}

/** The tints of the comments the checks that are on show, each in its check's colour, with the hovered or picked
 * passage active. */
export function useEvidence(comments: readonly DocComment[], on: ReadonlySet<string>, look: CheckLook, picked: DocComment | null): Evidence {
  const [sid, setSid] = useState<string | null>(null)
  const shown = useMemo(() => shownComments(comments, on), [comments, on])
  const flags = useMemo(() => {
    const out = passageFlags(shown, picked?.id ?? null, look)
    const hit = sid ? out.get(sid) : undefined
    if (hit) out.set(sid!, { ...hit, active: true })
    return out
  }, [shown, picked, sid, look])
  const at = sid ?? picked?.sid ?? null
  const hovered = useMemo(() => (at ? shown.filter((c) => c.sid === at || c.span.includes(at)) : []), [shown, at])
  return {
    flags,
    hovered,
    onOver: (e) => {
      const next = (e.target as Element).closest?.('[data-cids]')?.getAttribute('data-sid') ?? null
      if (next !== sid) setSid(next)
    },
    onLeave: () => setSid(null),
  }
}

export function EvidencePop({ comments, look }: { comments: readonly DocComment[]; look: CheckLook }) {
  const { onResolve } = useContext(EvidenceActions)
  if (!comments.length) return null
  return (
    <div className="wu-evpop overlay" role="status">
      {comments.map((c) => (
        <div key={c.id} className="wu-evpop-row">
          <span className="wu-evpop-sq" style={{ background: look.colour(c.check) }} />
          <div className="wu-evpop-body">
            <span className="wu-evpop-text">{c.text}</span>
            {c.evidence.length > 0 && <span className="wu-evpop-src">{c.evidence.map(compactLabel).join(' · ')}</span>}
          </div>
          {onResolve && !c.tag && (
            <IconButton label="Resolve" className="wu-cm-resolve" onClick={() => onResolve(c)}>
              <Glyph name="check" size={13} strokeWidth={2} />
            </IconButton>
          )}
        </div>
      ))}
    </div>
  )
}
