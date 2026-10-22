// A mark on the words of a claim in Claude's reply (marks.ts), drawn by its status as the terminal draws it, and a
// click opens its evidence under the words, as the terminal opens its evidence pane (plugin/marks/evidence.tsx):
//
//   computed   the real output of the call that ran the code, the marked words highlighted, first, so they show; then
//              the code the check ran
//   quote      each cited place: `path:line` on top (a click opens the file there), the cited lines with a line around
//   code       them, the words highlighted
//
// A corrected mark says what it was; a wrong one says why, in red, and one the check could not confirm says why, in
// the warning color, with the evidence the check gave when it is real. What the check found wrong in the rest of the
// sentence follows. Escape, a press outside, or a second click closes it.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '../components/Spinner'
import { RefChip } from '../components/RefChip'
import { LOOK_WORD, lookOf, type Evidence, type MarkItem } from './marks'

/** The marks of the text being drawn, by their order in it, and whether the text still streams. */
export const MarkItems = createContext<{ items: readonly (MarkItem | undefined)[]; streaming: boolean }>({ items: [], streaming: false })

const OUTPUT_LINES = 14 // output lines shown around the first highlight

export function Mark({ k, children }: { k: number; children: ReactNode }) {
  const { items, streaming } = useContext(MarkItems)
  const item = items[k]
  const look = streaming ? 'pending' : lookOf(item)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const card = useRef<HTMLSpanElement>(null)
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
  useLayoutEffect(() => {
    const el = card.current
    if (!open || !el || !box.current) return
    const place = () => placeCard(el, box.current?.querySelector<HTMLElement>('.mark-words') ?? null)
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])
  const corrected = look === 'corrected' && item?.shown
  return (
    <span ref={box} className={`mark is-${look}${open ? ' is-open' : ''}`} data-mark-look={look}>
      {/* a span, not a button, so long words wrap with the line as the text around them does */}
      <span
        role="button"
        tabIndex={0}
        className="mark-words"
        aria-expanded={open}
        title={LOOK_WORD[look]}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((o) => !o)
          }
        }}
      >
        {corrected ? plain(item.shown!) : children}
      </span>
      {look === 'checking' && <Spinner size={9} className="mark-spin" label="checking" />}
      {look === 'failed' && <span className="mark-glyph"> ×</span>}
      {look === 'unconfirmed' && <span className="mark-glyph"> ?</span>}
      {open && (
        <span className="mark-card" role="note" ref={card}>
          <MarkEvidence item={item} look={look} />
        </span>
      )}
    </span>
  )
}

/** A mark's words as written, without the markdown's formatting marks. */
const plain = (s: string) => s.replace(/\*\*|__|`/g, '')

function MarkEvidence({ item, look }: { item: MarkItem | undefined; look: ReturnType<typeof lookOf> }) {
  if (!item || look === 'pending' || look === 'checking')
    return (
      <>
        <span className={`mark-card-status is-${look}`}>{LOOK_WORD[look]}</span>
        <span className="mark-card-why">thimble checks this claim against the data after the reply.</span>
      </>
    )
  const evs = item.evidence ? (Array.isArray(item.evidence) ? item.evidence : [item.evidence]) : []
  return (
    <>
      <span className={`mark-card-status is-${look}`}>{LOOK_WORD[look]}</span>
      {look === 'corrected' && item.was && <span className="mark-card-was">was “{plain(item.was)}”</span>}
      {item.reason && <span className="mark-card-why">{item.reason}</span>}
      {evs.map((ev, i) => (
        <EvidenceView key={i} ev={ev} />
      ))}
      {item.note && <span className="mark-card-note">{item.note}</span>}
    </>
  )
}

function EvidenceView({ ev }: { ev: Evidence }) {
  if (ev.kind === 'computed')
    return (
      <span className="mark-ev">
        <span className="mark-ev-head">output of the code {ev.by === 'main' ? 'Claude ran' : 'the check ran'}</span>
        <pre className="mark-ev-out">{outputLines(ev.output ?? '', ev.highlight ?? [])}</pre>
        <span className="mark-ev-head">code</span>
        <pre className="mark-ev-code">{ev.code}</pre>
      </span>
    )
  const places = [ev, ...((ev as Evidence & { more?: Evidence[] }).more ?? [])]
  return (
    <span className="mark-ev">
      {places.map((p, i) => (
        <span key={i} className="mark-ev-place">
          <span className="mark-ev-head">
            <RefChip ref={`${p.file}#L${String(p.line).split('-')[0]}`} value={`${p.file}:${p.line}`} compact />
          </span>
          <pre className="mark-ev-lines">
            {(p.lines ?? []).map((l) => (
              <span key={l.n} className="mark-ev-line">
                <span className="mark-ev-n">{l.n}</span>
                {l.highlight ? (
                  <>
                    {l.text.slice(0, l.highlight[0])}
                    <mark>{l.text.slice(l.highlight[0], l.highlight[1])}</mark>
                    {l.text.slice(l.highlight[1])}
                  </>
                ) : (
                  l.text
                )}
                {'\n'}
              </span>
            ))}
          </pre>
        </span>
      ))}
    </span>
  )
}

/** The output's lines around its first highlight, the highlighted spans marked. */
function outputLines(output: string, spans: [number, number][]): ReactNode[] {
  const first = spans.length ? spans[0][0] : 0
  const lines = output.split('\n')
  let at = 0
  const starts = lines.map((l) => {
    const s = at
    at += l.length + 1
    return s
  })
  const hit = Math.max(0, starts.findIndex((s, i) => first >= s && first <= s + lines[i].length))
  const from = Math.max(0, hit - Math.floor(OUTPUT_LINES / 3))
  const to = Math.min(lines.length, from + OUTPUT_LINES)
  const out: ReactNode[] = from > 0 ? ['…\n'] : []
  for (let i = from; i < to; i++) {
    const a = starts[i]
    const b = a + lines[i].length
    let pos = a
    // in order, each part once: the check may give a span twice, or spans that overlap (the terminal's highlighted)
    for (const [x, y] of [...spans].sort((p, q) => p[0] - q[0])) {
      const s = Math.max(x, a, pos)
      const e = Math.min(y, b)
      if (e <= s) continue
      if (s > pos) out.push(output.slice(pos, s))
      out.push(<mark key={`${i}:${s}`}>{output.slice(s, e)}</mark>)
      pos = e
    }
    out.push(output.slice(pos, b) + '\n')
  }
  if (to < lines.length) out.push('…')
  return out
}

const GAP = 6
const MARGIN = 8

/** Place a mark's card by its words: below them when it fits there, else above them when it fits there, else on the
 * side with more room, its height cut to that room. Across, it stays inside the chat's column. */
function placeCard(card: HTMLElement, words: HTMLElement | null): void {
  card.classList.remove('is-above')
  card.style.maxHeight = ''
  card.style.left = ''
  card.style.width = ''
  const view = { top: MARGIN, bottom: window.innerHeight - MARGIN }
  const scroller = card.closest('.chat-list')
  if (scroller) {
    const r = scroller.getBoundingClientRect()
    view.top = Math.max(view.top, r.top)
    view.bottom = Math.min(view.bottom, r.bottom)
  }
  const col = (card.closest('.chat-msg') ?? document.body).getBoundingClientRect()
  if (card.getBoundingClientRect().width > col.width) card.style.width = `${col.width}px`
  const r = card.getBoundingClientRect()
  const shift = Math.max(col.left - r.left, Math.min(0, col.right - r.right))
  if (shift) card.style.left = `${shift}px`
  const w = (words ?? card.parentElement ?? card).getBoundingClientRect()
  const below = view.bottom - w.bottom - GAP
  const above = w.top - view.top - GAP
  if (r.height <= below) return
  if (r.height <= above || above > below) card.classList.add('is-above')
  if (r.height > Math.max(above, below)) card.style.maxHeight = `${Math.max(0, Math.floor(Math.max(above, below)))}px`
}
