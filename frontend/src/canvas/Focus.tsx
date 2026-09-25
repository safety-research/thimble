// Focus mode: one card at full size over the board, the cards of its frame listed at the left. ↑ and ↓ step through
// them, Escape goes back to the board. The composer under the card asks about it in the thread that made it; a card an
// agent made is asked about in a new thread on the card.
import { useContext, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ChatMarkdown } from '../chat/markdown'
import { Button } from '../components/Button'
import { ComposerFrame } from '../components/Composer'
import { GlyphCites } from '../components/RefChip'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { Cell } from '../lib/types'
import { CardBody, LabelHead, asksQuestion } from './bodies'
import { CardLabels } from './CardFace'
import { conceptName, useConceptDetail } from './concepts'
import { CanvasContext } from './context'
import { hhmm, kindOf } from './layout'

/** the card's width in focus, and its padding at the sides */
const FOCUS_W = 760
const FOCUS_PAD_X = 56

export interface FocusProps {
  cell: Cell
  /** the cards of its frame, in order */
  list: Cell[]
  /** its frame's name */
  frame: string
  onPick: (id: string) => void
  onClose: () => void
  /** a new thread on the card with this first message (the ⌘-click's route) */
  onAskNew: (cellId: string, text: string) => void
}

export function Focus({ cell, list, frame, onPick, onClose, onAskNew }: FocusProps) {
  const ctx = useContext(CanvasContext)
  const kind = kindOf(cell)
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  const concept = kind === 'label' ? String(payload.concept ?? '') : ''
  const label = useConceptDetail(ctx.ws, concept || null)
  const thread = ctx.threadOf(cell)
  const [draft, setDraft] = useState('')
  const [asked, setAsked] = useState<{ id: string; text: string } | null>(null)
  const i = list.findIndex((c) => c.id === cell.id)
  // the room the composer takes at the bottom of the stage, which the card's scroll area stops above
  const bar = useRef<HTMLDivElement>(null)
  const [barH, setBarH] = useState(0)
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const fit = () => setBarH(el.offsetHeight)
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const send = () => {
    const text = draft.trim()
    if (!text) return
    track('chat-open', { target: `cell:${cell.id}`, detail: { via: 'focus-composer', chat: thread.chatId } })
    setDraft('')
    setAsked({ id: cell.id, text })
    // the message names the card, so the thread knows which one it is about
    if (thread.chatId && thread.writable) bus.emit('openChat', { chatId: thread.chatId, send: `[[card:${cell.id}]] ${text}` })
    else onAskNew(cell.id, text)
  }
  return (
    <div className="bfocus" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <nav className="bfocus-list" aria-label={frame}>
        <span className="bfocus-frame">{frame}</span>
        {list.map((c) => (
          <button key={c.id} type="button" className={`bfocus-item${c.id === cell.id ? ' is-current' : ''}`} aria-current={c.id === cell.id || undefined} onClick={() => onPick(c.id)}>
            {c.title || 'Untitled'}
          </button>
        ))}
      </nav>
      <div className="bfocus-stage" style={{ '--bfocus-bar-h': `${barH}px` } as CSSProperties}>
        <div className="bfocus-main">
          <div className="bfocus-col">
            <span className="bfocus-meta">{[thread.name, hhmm(cell.created_ts ?? cell.ts)].filter(Boolean).join(' · ')}</span>
            <GlyphCites.Provider value={true}>
              <article className="bfocus-card" data-anchor={`card:${cell.id}`} data-anchor-text={cell.title} data-anchor-parts="">
                <div className="bfocus-q">{kind === 'label' && concept && !(ctx.concepts.has(concept) && asksQuestion(cell.title, conceptName(ctx.concepts, concept))) ? <LabelHead conceptId={concept} /> : cell.title}</div>
                <CardLabels cell={cell} />
                <CardBody cell={cell} width={FOCUS_W - FOCUS_PAD_X} label={label} big />
                {cell.takeaway ? (
                  <div className="bfocus-take">
                    <div className="chat-text">
                      <ChatMarkdown text={cell.takeaway} />
                    </div>
                  </div>
                ) : null}
              </article>
            </GlyphCites.Provider>
            <span className="bfocus-pos">
              {i + 1} of {list.length}
            </span>
          </div>
        </div>
        <div className="bfocus-composer" ref={bar}>
          {asked && asked.id === cell.id && (
            <div className="bfocus-asked">
              Asked in <span className="bfocus-asked-thread">{thread.writable ? thread.name : 'a new thread'}</span>: “{asked.text}”
            </div>
          )}
          <ComposerFrame className="bfocus-bar" value={draft} onChange={setDraft} onSubmit={send} placeholder="Ask about this card…" rows={1} maxHeight={120} model={<span className="bfocus-thread">{thread.writable ? thread.name : 'new thread'}</span>} data-anchor="ui:focus-composer" />
        </div>
      </div>
      <Button variant="icon" size="md" icon="x" title="Back to the board" aria-label="Back to the board" className="bfocus-close" onClick={onClose} />
    </div>
  )
}
