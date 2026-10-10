// Comment on a selection where a document shows without its editor (a slide, a story's beat, a page's claims): a
// selection that starts in a sentence (selection.ts sidAt) shows a one-button bar; the button opens a new-comment card,
// and Enter stores the comment on that sentence (commentsApi.add). Escape or an empty field drops it. The bar and the
// card are fixed to the viewport and re-placed on scroll.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { WriteupComment } from '../lib/types'
import { NOTE_COLOR } from './checkComments'
import { commentsApi } from './commentsApi'
import { IconButton } from './icons'
import { sidAt } from './selection'

/** the room between the selection's first line and the bar above it */
const GAP = 6
/** the card's width, as the margin's (report.css .wu-rail) */
const CARD_W = 228
const EDGE = 8

export interface SelectCommentProps {
  ws: string
  slug: string
  /** the view the selection must start in */
  root: RefObject<HTMLElement | null>
  onAdded: (comment: WriteupComment) => void
}

interface Spot {
  sid: string
  range: Range
}

/** The sentence a selection in the view comments on, and the selection's range; null when it starts outside the view,
 * is empty, or names no sentence. The search stays in the slide, beat or claim it starts in: the nearest element with a
 * ⌘ anchor that is no sentence of its own. */
export function spotOf(sel: Selection | null, root: HTMLElement | null): Spot | null {
  if (!sel || !root || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const start = range.startContainer
  if (!root.contains(start)) return null
  const el = start.nodeType === 1 ? (start as Element) : start.parentElement
  const block = el?.closest('[data-anchor]:not([data-sid])') ?? null
  const sid = sidAt(start, range.startOffset, block && root.contains(block) ? block : null)
  return sid ? { sid, range: range.cloneRange() } : null
}

export function SelectComment({ ws, slug, root, onAdded }: SelectCommentProps) {
  const [spot, setSpot] = useState<Spot | null>(null)
  const [writing, setWriting] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const writingRef = useRef(false)
  writingRef.current = writing

  useEffect(() => {
    const onChange = () => {
      if (writingRef.current) return
      setSpot(spotOf(document.getSelection(), root.current))
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [root])

  // placed at the selection's first line, and again as the view scrolls under it
  const place = useCallback(() => {
    if (!spot) return setAt(null)
    // a range with no layout (jsdom has none) stands at the top left of the element the selection starts in
    const range = spot.range
    const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : null
    const r = rects?.length ? rects[0] : typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : ((range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement)?.getBoundingClientRect() ?? { top: 0, left: 0 })
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - (writingRef.current ? CARD_W : 40) - EDGE))
    setAt({ top: r.top, left })
  }, [spot])
  useLayoutEffect(() => {
    place()
  }, [place, writing])
  useEffect(() => {
    if (!spot) return
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [spot, place])

  const close = () => {
    setWriting(false)
    setSpot(null)
  }
  const save = async (text: string) => {
    if (!spot) return
    const comment = await commentsApi.add(ws, slug, spot.sid, text)
    track('ui-click', { target: `report:${slug}#${spot.sid}`, detail: { action: 'comment-add', from: 'selection' } })
    document.getSelection()?.removeAllRanges()
    close()
    onAdded(comment)
  }

  if (!spot || !at) return null
  if (!writing) {
    return (
      <div className="wu-selbar overlay" style={{ top: at.top - GAP, left: at.left }} onMouseDown={(e) => e.preventDefault()}>
        <IconButton label="Comment" onClick={() => setWriting(true)}>
          <Icon name="comment" size={16} />
        </IconButton>
      </div>
    )
  }
  return <SelectCard top={at.top - GAP} left={at.left} onSave={save} onCancel={close} />
}

/** The new comment's card over the selection: the margin's draft card (Margin.tsx DraftCard), until Enter stores it. */
function SelectCard({ top, left, onSave, onCancel }: { top: number; left: number; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    field.current?.focus({ preventScroll: true })
  }, [])
  const save = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await onSave(t)
    } catch (e) {
      bus.emit('toast', { text: `Could not save the comment. ${(e as Error).message}`, kind: 'error' })
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <div className="wu-selcard overlay" style={{ top, left }} onClick={(e) => e.stopPropagation()} aria-label="New comment">
      <div className="wu-cm-head">
        <span className="wu-cm-sq" style={{ background: NOTE_COLOR }} />
        <span className="wu-cm-name" style={{ color: NOTE_COLOR }}>
          You
        </span>
      </div>
      <div className="wu-cm-reply">
        <TextArea
          ref={field}
          bare
          block
          autoGrow
          rows={1}
          maxHeight={160}
          value={text}
          onChange={setText}
          onKeyDown={onKey}
          onBlur={() => {
            if (!text.trim() && !busy) onCancel()
          }}
          disabled={busy}
          aria-label="Comment"
        />
      </div>
    </div>
  )
}
