// The report's margin: a card for each lens mark the page shows beside its words (lensMarks.ts marginMarks), aligned
// with the highlight and stacked so no two meet. A card shows the lens's name in its color beside its swatch, ✓ (done,
// which hides the mark), the mark's title and what it says; open, what to do and a field whose text asks Claude about
// it in a thread anchored to the mark.
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ChatMarkdown, ChipContext } from '../chat/markdown'
import { TextArea } from '../components/Field'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { ReportMark } from '../lib/types'
import { Glyph, IconButton } from './icons'
import { inkOf, lookOf, type LensLook } from './lensMarks'

/** the room the margin takes beside the page's column: report.css `.wu-rail`, 228 wide with 12 before it and 16 after */
export const RAIL_ROOM = 228 + 12 + 16
/** the room between two stacked cards, and how far above its highlight's line a card's top sits */
const GAP = 8
const LIFT = 8
const NO_REFS: ReadonlySet<string> = new Set()

/** Cards at their wanted tops, each pushed below the one before it; with `anchor`, that card stands exactly at its place
 * and the others move around it. Pure. */
export function stackCards(items: readonly { id: string; top: number; height: number }[], gap = GAP, anchor: string | null = null): Map<string, number> {
  const list = [...items].sort((a, b) => a.top - b.top)
  const tops = list.map((it) => Math.round(it.top))
  const k = anchor ? list.findIndex((it) => it.id === anchor) : -1
  for (let i = 1; i < list.length; i++) if (i !== k) tops[i] = Math.max(tops[i], tops[i - 1] + list[i - 1].height + gap)
  for (let i = k - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - list[i].height - gap)
  return new Map(list.map((it, i) => [it.id, tops[i]]))
}

export interface MarginProps {
  ws: string
  marks: readonly ReportMark[]
  lenses: ReadonlyMap<string, LensLook>
  active: string | null
  onActivate: (id: string | null) => void
  onDone: (mark: ReportMark) => void
  /** the page column, where the highlights are */
  column: RefObject<HTMLElement | null>
}

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))

export function Margin({ ws, marks, lenses, active, onActivate, onDone, column }: MarginProps) {
  const rail = useRef<HTMLDivElement | null>(null)
  const cards = useRef(new Map<string, HTMLDivElement>())
  const [tops, setTops] = useState<Map<string, number>>(new Map())
  const key = marks.map((m) => m.id).join(',') + `|${active}`

  const layout = useCallback(() => {
    const col = column.current
    const r = rail.current
    if (!col || !r) return
    const base = r.getBoundingClientRect().top
    const want: { id: string; top: number; height: number }[] = []
    for (const m of marks) {
      const el = col.querySelector(`[data-mark="${esc(m.id)}"]`)
      const card = cards.current.get(m.id)
      if (!el || !card) continue
      want.push({ id: m.id, top: el.getBoundingClientRect().top - base - LIFT, height: card.offsetHeight })
    }
    const next = stackCards(want, GAP, active)
    setTops((prev) => (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v) ? prev : next))
  }, [column, key]) // eslint-disable-line react-hooks/exhaustive-deps

  // placed after every render, and again whenever the column's text moves (an edit, a figure loading, a resize)
  useLayoutEffect(() => {
    layout()
  })
  useLayoutEffect(() => {
    const col = column.current
    if (!col) return
    let frame = 0
    const later = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(layout)
    }
    const ro = new ResizeObserver(later)
    ro.observe(col)
    for (const card of cards.current.values()) ro.observe(card)
    const mo = new MutationObserver(later)
    mo.observe(col, { subtree: true, childList: true, characterData: true })
    return () => {
      window.cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
    }
  }, [column, layout])

  const setCard = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cards.current.set(id, el)
    else cards.current.delete(id)
  }
  return (
    <div className="wu-rail" ref={rail} aria-label="Marks">
      {marks.map((m) => {
        const top = tops.get(m.id)
        return (
          <MarkCard
            key={m.id}
            ws={ws}
            mark={m}
            look={lookOf(lenses, m.lens)}
            active={m.id === active}
            cardRef={setCard(m.id)}
            top={top}
            onActivate={() => onActivate(m.id === active ? null : m.id)}
            onDone={() => onDone(m)}
          />
        )
      })}
    </div>
  )
}

/** One mark's card: the lens's swatch and name, ✓, the title and what the mark says; open, what to do and Ask. */
export function MarkCard({ ws, mark, look, active, top, cardRef, onActivate, onDone }: { ws: string; mark: ReportMark; look: LensLook; active: boolean; top: number | undefined; cardRef: (el: HTMLDivElement | null) => void; onActivate: () => void; onDone: () => void }) {
  const ink = inkOf(look.color)
  const statement = mark.title || mark.body
  const details = mark.title ? [mark.body, mark.here].filter(Boolean).join('\n\n') : mark.here ?? ''
  return (
    <div
      ref={cardRef}
      className={`wu-cm${active ? ' wu-cm-active' : ''}`}
      style={{ top: top ?? 0, visibility: top == null ? 'hidden' : undefined }}
      onClick={(e) => {
        e.stopPropagation()
        onActivate()
      }}
      data-mark-card={mark.id}
    >
      <div className="wu-cm-head">
        <span className="wu-cm-sq" style={{ background: ink }} />
        <span className="wu-cm-name" style={{ color: ink }}>
          {look.name}
        </span>
        <IconButton
          label="Done"
          className="wu-cm-resolve"
          onClick={(e) => {
            e.stopPropagation()
            onDone()
          }}
        >
          <Glyph name="check" size={13} strokeWidth={2} />
        </IconButton>
      </div>
      <ChipContext.Provider value={{ workspace: ws, broken: NO_REFS }}>
        <div className="wu-cm-text wu-cm-statement chat-text">
          <ChatMarkdown text={statement} />
        </div>
        {active && details && (
          <div className="wu-cm-details wu-cm-md chat-text">
            <ChatMarkdown text={details} />
          </div>
        )}
      </ChipContext.Provider>
      {active && <Ask ws={ws} mark={mark} look={look} />}
    </div>
  )
}

/** The open card's field: its text goes to Claude as the first message of a thread anchored to the mark. */
function Ask({ ws, mark, look }: { ws: string; mark: ReportMark; look: LensLook }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    const msg = text.trim()
    if (!msg || busy) return
    setBusy(true)
    try {
      const said = [mark.title, mark.body, mark.here].filter(Boolean).join(' ')
      const meta = await api.createThread(ws, { anchor: `mark:${mark.id}`, anchor_text: `${look.name} on "${mark.term}": ${said}`, text: msg })
      track('thread-open', { target: `mark:${mark.id}`, detail: { from: 'report-mark' } })
      bus.emit('openChat', { chatId: meta.id })
      setText('')
    } catch (e) {
      bus.emit('toast', { text: `Could not open a thread. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }
  return (
    <div className="wu-cm-reply" onClick={(e) => e.stopPropagation()}>
      <TextArea bare block autoGrow rows={1} maxHeight={120} value={text} onChange={setText} onKeyDown={onKey} disabled={busy} placeholder="Ask about this…" aria-label="Ask about this mark" />
    </div>
  )
}
