// A lens's mark on words of Claude's text (lib/marks.ts), the same in the chat, on a card's takeaway and in the report:
// the words in the lens's light tint, and a click opens its card under them, as the terminal opens an explainer in its
// tray. The card, the same for every lens: a small quiet line with the lens's swatch and name, then the heading (the
// mark's title, or its words when it has none, as an explainer's term), what the lens says of them, and its last line
// (an important detail's to-do, or where an explainer's term mattered in this work), then Ask, which opens a thread
// about the mark (its anchor is `mark:<id>`), and Close; Escape or a press outside closes it too. The marked words are
// not repeated in the card: they sit in their tint just above it. The card's text shows no marks of its own (NoMarks).
// Explainers carry a dotted underline in their ink, as the terminal draws them; a check's mark is the tint alone. The
// words carry `data-mark`, so the sidebar's found list can bring them into view (lib/marks revealMark).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bus } from '../lib/bus'
import { lensColors, type Lens, type Mark } from '../lib/marks'
import { ChatMarkdown, NoMarks } from '../chat/markdown'

export function LensMark({ mark, lens, children }: { mark: Mark; lens?: Lens; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const colors = lensColors(lens?.color ?? (mark.lens === 'explain' ? 'teal' : mark.lens === 'details' ? 'orange' : 'pink'))
  const name = lens?.name ?? (mark.lens === 'explain' ? 'Explainers' : mark.lens === 'details' ? 'Important details' : 'Check')
  // a press outside the mark, or Escape, closes it
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  // the card opens under the words and stays inside the text's column: no wider than it, and shifted left when it
  // would pass its right edge, never past its left
  const place = (card: HTMLSpanElement | null) => {
    if (!card) return
    const col = (card.closest('.chat-msg, .bcell-take, .wu-page, .chat-card') ?? document.body).getBoundingClientRect()
    if (card.getBoundingClientRect().width > col.width) card.style.width = `${col.width}px`
    const r = card.getBoundingClientRect()
    const shift = Math.max(col.left - r.left, Math.min(0, col.right - r.right))
    if (shift) card.style.left = `${shift}px`
  }
  const explainer = mark.lens === 'explain'
  return (
    <span
      ref={box}
      className={`lens-mark${open ? ' is-open' : ''}${explainer ? ' is-explainer' : ''}`}
      data-mark={mark.id}
      data-lens={mark.lens}
      data-anchor={`mark:${mark.id}`}
      data-anchor-text={`${mark.term}: ${mark.title || mark.body}`}
      style={{ '--mark-fill': colors.fill, '--mark-ink': colors.ink, '--mark-edge': colors.edge } as React.CSSProperties}
    >
      {/* a span, not a button, so long words wrap with the line as the text around them does */}
      <span
        role="button"
        tabIndex={0}
        className="lens-mark-term"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((o) => !o)
          }
        }}
        title={name}
      >
        {children}
      </span>
      {open && (
        <span className="lens-card" role="note" aria-label={`${name}: ${mark.title || mark.term}`} ref={place}>
          <span className="lens-card-kind">
            <span className="lens-card-swatch" aria-hidden="true" />
            {name}
          </span>
          <span className="lens-card-title">{mark.title || mark.term}</span>
          <NoMarks>
            <span className="lens-card-body">
              <ChatMarkdown text={mark.body} />
            </span>
            {mark.here && (
              <span className="lens-card-here">
                {mark.lens === 'details' && <span className="lens-card-here-word">To do</span>}
                <ChatMarkdown text={mark.here} />
              </span>
            )}
          </NoMarks>
          <span className="lens-card-foot">
            <button
              type="button"
              className="lens-card-act"
              onClick={() => {
                setOpen(false)
                if (box.current) bus.emit('askAbout', { el: box.current })
              }}
            >
              Ask
            </button>
            <button type="button" className="lens-card-act" onClick={() => setOpen(false)}>
              Close
            </button>
          </span>
        </span>
      )}
    </span>
  )
}
