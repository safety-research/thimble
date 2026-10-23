// A mark on the words of a claim in Claude's reply (marks.ts), drawn as a card's citation is (components/RefChip): the
// words keep the text's color over a thin accent underline, and hovering or opening one gives it the citation's
// highlight. A mark the check could not confirm has a dashed underline in the warning color and `?` after the words.
// Hovering opens its evidence in the citation's label (RefChip's .refchip-pop), and a click keeps it open:
//
//   computed   the head names the code that ran; the lines of its real output around the marked words, the words
//              highlighted, then the code
//   quote      each cited place: its `path:line` chip (a click opens the file there) over the cited lines, the words
//   code       highlighted
//   card       a value a card shows: the card's chip (a click opens it) over the table around the cited cell, the cell
//              marked, as a card's citation shows it (components/RefChip); a line of its printed output shows as the
//              computed output does. An evidence that names only the place (an old `[[value|card:…]]` citation) reads
//              the place when the label opens.
//
// Printed output that is a table (a printed DataFrame) shows as that small table, its cited cell marked.
//
// A failed mark's label says why in one line first. Escape, a press outside, or a second click closes it.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Chip } from '../components/Chip'
import { citedTable, placePop, printedTable, TablePreview, useRefLabel } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { glyphOf } from '../lib/fileGlyph'
import { parseRef } from '../lib/refs'
import { CITED, citedLines, type At, type Grid } from '../lib/tableCell'
import { teleport } from '../lib/teleport'
import { workspaceFromUrl } from '../lib/workspace'
import { failedWhy, LOOK_WORD, lookOf, type Evidence, type MarkItem, type MarkLook } from './marks'

/** The marks of the text being drawn, by their order in it, and whether the text still streams. */
export const MarkItems = createContext<{ items: readonly (MarkItem | undefined)[]; streaming: boolean }>({ items: [], streaming: false })

/** output lines shown around the first highlight: this many before it, and up to OUTPUT_LINES in all */
const OUTPUT_BEFORE = 2
const OUTPUT_LINES = 7
/** the label waits this long for the pointer to settle, and this long before it goes (RefChip's) */
const HOVER_DELAY_MS = 90
const HIDE_DELAY_MS = 160

/** A mark: the k-th of its text's marks (MarkItems), or `item` when the caller has it (an old card citation). */
export function Mark({ k, item: given, children }: { k: number; item?: MarkItem; children: ReactNode }) {
  const { items, streaming } = useContext(MarkItems)
  const item = given ?? items[k]
  const look: MarkLook = streaming ? 'pending' : lookOf(item)
  const [pop, setPop] = useState<{ rect: DOMRect; pinned: boolean } | null>(null)
  const words = useRef<HTMLSpanElement>(null)
  const popEl = useRef<HTMLDivElement>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
    },
    [],
  )
  useEffect(() => {
    if (!pop?.pinned) return
    const inside = (n: Node) => !!words.current?.contains(n) || !!popEl.current?.contains(n)
    const down = (e: PointerEvent) => !inside(e.target as Node) && setPop(null)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setPop(null)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key)
    }
  }, [pop?.pinned])
  useLayoutEffect(() => {
    const el = popEl.current
    if (!el || !pop) return
    const place = () => placePop(el, pop.rect)
    place()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pop])

  const rect = () => words.current?.getBoundingClientRect() ?? null
  const cancelHide = () => window.clearTimeout(hideTimer.current)
  const scheduleHide = () => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setPop((p) => (p?.pinned ? p : null)), HIDE_DELAY_MS)
  }
  const onEnter = () => {
    cancelHide()
    window.clearTimeout(showTimer.current)
    if (document.body.hasAttribute('data-cmd')) return
    showTimer.current = window.setTimeout(() => {
      const r = rect()
      if (r) setPop((p) => p ?? { rect: r, pinned: false })
    }, HOVER_DELAY_MS)
  }
  const onLeave = () => {
    window.clearTimeout(showTimer.current)
    scheduleHide()
  }
  const toggle = () => {
    window.clearTimeout(showTimer.current)
    cancelHide()
    const r = rect()
    setPop((p) => (p?.pinned ? null : r ? { rect: r, pinned: true } : null))
  }

  const corrected = item?.status === 'corrected' && item.shown
  return (
    <span className={`mark is-${look}${pop ? ' is-open' : ''}`} data-mark-look={look} data-ref={cardRef(item)}>
      {/* a span, not a button, so long words wrap with the line as the text around them does */}
      <span
        ref={words}
        role="button"
        tabIndex={0}
        className="mark-words"
        aria-expanded={!!pop}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        {corrected ? plain(item.shown!) : children}
      </span>
      {look === 'failed' && <span className="mark-glyph">×</span>}
      {look === 'checking' && <Spinner size={9} className="mark-spin" label="checking" />}
      {pop &&
        createPortal(
          <div ref={popEl} className="refchip-pop overlay mark-pop" role="note" style={{ position: 'fixed', left: 8, top: 0 }} onMouseEnter={cancelHide} onMouseLeave={() => !pop.pinned && scheduleHide()} onMouseDown={(e) => e.stopPropagation()}>
            <MarkEvidence item={item} look={look} />
          </div>,
          document.body,
        )}
    </span>
  )
}

/** The card place a mark's evidence names, for the mark's `data-ref`: what a card's citation carries. */
const cardRef = (item: MarkItem | undefined): string | undefined => {
  const ev = Array.isArray(item?.evidence) ? item?.evidence[0] : item?.evidence
  return ev?.kind === 'card' ? ev.ref : undefined
}

/** A mark's words as written, without the markdown's formatting marks. */
const plain = (s: string) => s.replace(/\*\*|__|`/g, '')

function MarkEvidence({ item, look }: { item: MarkItem | undefined; look: MarkLook }) {
  if (!item || look === 'pending' || look === 'checking')
    return (
      <div className="mark-pop-state">
        {look === 'checking' && <Spinner size={10} label="checking" />} {LOOK_WORD[look]}
      </div>
    )
  const evs = item.evidence ? (Array.isArray(item.evidence) ? item.evidence : [item.evidence]) : []
  const value = plain(item.shown ?? item.words)
  return (
    <>
      {look === 'failed' && (
        <div className="mark-pop-why" title={failedWhy(item)}>
          {failedWhy(item)}
        </div>
      )}
      {evs.map((ev, i) => (
        <EvidenceView key={i} ev={ev} value={value} />
      ))}
    </>
  )
}

function EvidenceView({ ev, value }: { ev: Evidence; value: string }) {
  if (ev.kind === 'card') return <CardEvidence ev={ev} value={value} />
  const printed = ev.kind === 'computed' ? printedTable(ev.table, value) : null
  if (printed)
    return (
      <div className="mark-ev">
        <div className="refchip-pop-head">
          <Chip kind="ref" tone="evidence" icon="terminal" face="sans" className="refchip-pop-chip">
            {ev.by === 'main' ? 'code Claude ran' : 'code the check ran'}
          </Chip>
          <span className="refchip-pop-value">{value}</span>
        </div>
        <TablePreview grid={printed.grid} at={printed.at} />
        {ev.code ? <pre className="refchip-lines mono mark-ev-code">{ev.code}</pre> : null}
      </div>
    )
  if (ev.kind === 'computed')
    return (
      <div className="mark-ev">
        <div className="refchip-pop-head">
          <Chip kind="ref" tone="evidence" icon="terminal" face="sans" className="refchip-pop-chip">
            {ev.by === 'main' ? 'code Claude ran' : 'code the check ran'}
          </Chip>
          <span className="refchip-pop-value">{value}</span>
        </div>
        <div className="refchip-lines mono">{outputLines(ev.output ?? '', ev.highlight ?? [])}</div>
        {ev.code ? <pre className="refchip-lines mono mark-ev-code">{ev.code}</pre> : null}
      </div>
    )
  const places = [ev, ...((ev as Evidence & { more?: Evidence[] }).more ?? [])]
  return (
    <>
      {places.map((p, i) => {
        const at = `${p.file}#L${String(p.line).split('-')[0]}`
        return (
          <div key={i} className="mark-ev">
            <div className="refchip-pop-head">
              <Chip kind="ref" tone="evidence" icon={glyphOf(String(p.file ?? ''))} className="refchip-pop-chip" onClick={() => teleport(at)}>
                {`${p.file}:${p.line}`}
              </Chip>
              {i === 0 && <span className="refchip-pop-value">{value}</span>}
            </div>
            <div className="refchip-lines mono">
              {(p.lines ?? []).map((l) => (
                <div key={l.n} className="refchip-line">
                  <span className="mark-ev-n">{l.n}</span>
                  {l.highlight ? (
                    <>
                      {l.text.slice(0, l.highlight[0])}
                      <span className={CITED}>{l.text.slice(l.highlight[0], l.highlight[1])}</span>
                      {l.text.slice(l.highlight[1])}
                    </>
                  ) : (
                    l.text || ' '
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

type Resolved = { state: 'loading' } | { state: 'gone' } | { state: 'table'; grid: Grid; at: At } | { state: 'lines'; lines: string[]; from: number; to: number }

/** A value a card shows: the card's chip over the table around the cited cell, or the printed lines around the cited
 * one. Evidence that names only the place is read when the label opens (api.resolveRef), as RefChip reads it. */
function CardEvidence({ ev, value }: { ev: Evidence; value: string }) {
  const own = printedTable(ev.table, value)
  const [got, setGot] = useState<Resolved>({ state: 'loading' })
  const ref = ev.ref ?? `card:${ev.card}`
  useEffect(() => {
    if (own || ev.output != null) return
    const p = parseRef(ref)
    const ws = workspaceFromUrl() ?? ''
    let live = true
    api
      .resolveRef(ws, ref)
      .then((r) => {
        if (!live) return
        if (p?.kind === 'cell' && p.col != null && p.row != null) {
          const t = citedTable(r, p.col, p.row)
          return setGot(t ? { state: 'table', ...t } : { state: 'gone' })
        }
        const t = printedTable(r.meta?.text_table, value)
        if (t) return setGot({ state: 'table', ...t })
        const span = r.meta?.span as { text?: unknown } | undefined
        const lines = typeof span?.text === 'string' && p?.kind === 'cell' && p.line != null ? citedLines(r.excerpt ?? '', span.text, p.line) : null
        setGot(lines ? { state: 'lines', ...lines } : { state: 'gone' })
      })
      .catch(() => live && setGot({ state: 'gone' }))
    return () => {
      live = false
    }
  }, [ref])
  const card = ev.card ?? (parseRef(ref) as { cellId?: string } | null)?.cellId ?? ''
  const name = useRefLabel(`card:${card}`)
  const title = ev.title || name || 'card'
  const table = own ?? (got.state === 'table' ? got : null)
  return (
    <div className="mark-ev">
      <div className="refchip-pop-head">
        <Chip kind="ref" tone="evidence" icon="cell" face="sans" className="refchip-pop-chip" onClick={() => teleport(ref)}>
          {title}
        </Chip>
        {!table ? <span className="refchip-pop-value">{value}</span> : null}
      </div>
      {table ? (
        <TablePreview grid={table.grid} at={table.at} />
      ) : ev.output != null ? (
        <div className="refchip-lines mono">{outputLines(ev.output, ev.highlight ?? [])}</div>
      ) : got.state === 'lines' ? (
        <div className="refchip-lines mono">
          {got.lines.map((l, i) => (
            <div key={i} className={i >= got.from && i <= got.to ? `refchip-line ${CITED}` : 'refchip-line'}>
              {l || ' '}
            </div>
          ))}
        </div>
      ) : got.state === 'loading' ? (
        <div className="mark-pop-state">
          <Spinner size={10} label="reading the card" />
        </div>
      ) : (
        <div className="mark-pop-state">This place is no longer in the card's output.</div>
      )}
    </div>
  )
}

/** The output's lines around its first highlight, one element each, the highlighted spans marked. */
export function outputLines(output: string, spans: [number, number][]): ReactNode[] {
  const first = spans.length ? spans[0][0] : 0
  const lines = output.split('\n')
  let at = 0
  const starts = lines.map((l) => {
    const s = at
    at += l.length + 1
    return s
  })
  const hit = Math.max(0, starts.findIndex((s, i) => first >= s && first <= s + lines[i].length))
  const from = Math.max(0, hit - OUTPUT_BEFORE)
  const to = Math.min(lines.length, from + OUTPUT_LINES)
  const out: ReactNode[] = from > 0 ? [<div key="above" className="refchip-line mark-ev-more">…</div>] : []
  const sorted = [...spans].sort((p, q) => p[0] - q[0])
  for (let i = from; i < to; i++) {
    const a = starts[i]
    const b = a + lines[i].length
    let pos = a
    const parts: ReactNode[] = []
    // in order, each part once: the check may give a span twice, or spans that overlap (the terminal's highlighted)
    for (const [x, y] of sorted) {
      const s = Math.max(x, a, pos)
      const e = Math.min(y, b)
      if (e <= s) continue
      if (s > pos) parts.push(output.slice(pos, s))
      parts.push(
        <span key={s} className={CITED}>
          {output.slice(s, e)}
        </span>,
      )
      pos = e
    }
    parts.push(output.slice(pos, b))
    out.push(
      <div key={i} className="refchip-line">
        {lines[i] ? parts : ' '}
      </div>,
    )
  }
  if (to < lines.length) out.push(<div key="below" className="refchip-line mark-ev-more">…</div>)
  return out
}
