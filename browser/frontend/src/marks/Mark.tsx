// A mark on the words of a claim in Claude's reply (marks.ts), drawn as a card's citation is (components/RefChip): the
// words keep the text's color, underlined in it, and hovering or opening one puts the citations' purple tint behind
// them. A mark the check could not confirm is red and underlined, with `×` after the words, its tint a soft red.
// Hovering opens its evidence in the citation's label (RefChip's .refchip-pop), and a click keeps it open:
//
//   computed   the head names the code that ran; the lines of its real output around the marked words, the words
//              highlighted, then the code
//   quote      each cited place: its `path:line` chip (a click opens the file there) over the cited lines and the lines
//   code       around them that hold text, the words highlighted
//   card       a value a card shows: the card's chip (a click opens it) over the table around the cited cell, the cell
//              marked, as a card's citation shows it (components/RefChip); a line of its printed output shows as the
//              computed output does, its chip naming the line as the citation's chip does (lib/refs cardPartLabel).
//              The card is read when the label opens: when it changed after the check (the card check rewrote it, say),
//              the label shows it as it is now, or says the place is gone and shows what the check read.
//
// Printed output that is a table (a printed DataFrame) shows as that small table, its cited cell marked. The lines wrap;
// a long one shows only the words around its highlighted ones, cut at words (lineWindow).
//
// A failed mark's label says why in one line first, with Repair, which checks it again and makes it correct (the
// terminal's x); a corrected one's says what it was. Words that hold several values (a range, a pair) cite a place for
// each: their cells are marked in one table, their lines in one output. Escape, a press outside, or a second click
// closes it.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { citedTable, placePop, printedTable, TablePreview, useRefLabel } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { api, marksApi } from '../lib/api'
import { glyphOf } from '../lib/fileGlyph'
import { wordsSpanRef } from '../lib/quoteFind'
import { cardPartLabel, parseRef } from '../lib/refs'
import { CITED, citedLines, type At, type Grid } from '../lib/tableCell'
import { teleport } from '../lib/teleport'
import { workspaceFromUrl } from '../lib/workspace'
import { canRepair, failedWhy, LOOK_WORD, lookOf, wasLine, type Evidence, type MarkItem, type MarkLook } from './marks'

/** The marks of the text being drawn, by their order in it, and whether the text still streams. */
export const MarkItems = createContext<{ items: readonly (MarkItem | undefined)[]; streaming: boolean }>({ items: [], streaming: false })

/** output lines shown around the first highlight: this many before it, and up to OUTPUT_LINES in all */
const OUTPUT_BEFORE = 2
const OUTPUT_LINES = 7
/** a line longer than LINE_SHOWN characters shows only the words around its marked ones: up to LINE_BEFORE characters
 * before them and LINE_AFTER after (lineWindow) */
const LINE_SHOWN = 240
const LINE_BEFORE = 60
const LINE_AFTER = 160
/** the label waits this long for the pointer to settle, and this long before it goes (RefChip's) */
const HOVER_DELAY_MS = 90
const HIDE_DELAY_MS = 160
/** How a place in a mark's label opens: teleport, after the label closes, so it does not stay over the chat while the
 * pointer rests where it was */
const OpenPlace = createContext<(ref: string) => void>(teleport)
/** The card the mark's words are drawn in (its takeaway, its details: `data-cite-home`), as for a card's citation
 * (RefChip): the label of a value of that card's printed output names the line without the card's title */
const CiteHome = createContext<string | null>(null)

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
  const [home, setHome] = useState<string | null>(null)
  useLayoutEffect(() => setHome(words.current?.closest<HTMLElement>('[data-cite-home]')?.dataset.citeHome ?? null), [])
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

  const openPlace = (ref: string) => {
    window.clearTimeout(showTimer.current)
    cancelHide()
    setPop(null)
    teleport(ref)
  }

  const corrected = item?.status === 'corrected' && item.shown
  // a narrowing cites only a part of the words: the rest stays, as Claude's own words, outside the citation
  const whole = item?.words != null ? plain(item.words) : ''
  const part = corrected && item.narrowed ? whole.indexOf(plain(item.shown!)) : -1
  const [before, after] = part >= 0 ? [whole.slice(0, part), whole.slice(part + plain(item!.shown!).length)] : ['', '']
  return (
    <>
    {before}
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
            <OpenPlace.Provider value={openPlace}>
              <CiteHome.Provider value={home}>
                <MarkEvidence item={item} look={look} />
              </CiteHome.Provider>
            </OpenPlace.Provider>
          </div>,
          document.body,
        )}
    </span>
    {after}
    </>
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
  const given = item.evidence ? (Array.isArray(item.evidence) ? item.evidence : [item.evidence]) : []
  // a card's places in another card or output (words with several values) show each in turn
  const evs = given.flatMap((ev) => (ev.kind === 'card' ? [ev, ...(ev.more ?? [])] : [ev]))
  const value = plain(item.shown ?? item.words)
  const was = wasLine(item)
  return (
    <>
      {look === 'failed' && (
        <div className="mark-pop-head">
          <div className="mark-pop-why" title={failedWhy(item)}>
            {failedWhy(item)}
          </div>
          {canRepair(item) && <RepairButton item={item} />}
        </div>
      )}
      {was && (
        <div className="mark-pop-was" title={was}>
          {was}
        </div>
      )}
      {evs.map((ev, i) => (
        <EvidenceView key={i} ev={ev} value={value} />
      ))}
    </>
  )
}

/** Repair: check a failed mark again and make it correct (backend marks.repair, the terminal's x). The mark turns to
 * checking when the server's record of it comes back; a refusal says why in place of the button. */
function RepairButton({ item }: { item: MarkItem }) {
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false })
  const repair = () => {
    const ws = workspaceFromUrl() ?? ''
    const body = item.card ? { card: item.card, k: item.k } : { turn: item.turn!, n: item.n }
    setState({ busy: true })
    marksApi.repair(ws, body).then(
      () => setState({ busy: true }),
      (e: unknown) => setState({ busy: false, error: e instanceof Error ? e.message : String(e) }),
    )
  }
  if (state.error) return <span className="mark-pop-repair-error" title={state.error}>Repair did not start: {state.error}</span>
  return (
    <Button variant="secondary" size="sm" className="mark-pop-repair" busy={state.busy} disabled={state.busy} onClick={repair}>
      Repair
    </Button>
  )
}

/** Where a quote's place opens: the span of the words the check found inside the record it cites (wordsSpanRef), so
 * the File browser highlights them; the record itself when it holds no such words or cannot be read. */
async function quotedPlace(at: string, words: string): Promise<string> {
  if (!words.trim()) return at
  try {
    return wordsSpanRef(await api.resolveRef(workspaceFromUrl() ?? '', at), words) ?? at
  } catch {
    return at
  }
}

function EvidenceView({ ev, value }: { ev: Evidence; value: string }) {
  const open = useContext(OpenPlace)
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
        <TablePreview grid={printed.grid} at={printed.at} also={printed.also} />
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
        const [lo, hi = lo] = String(p.line).split('-').map(Number)
        const at = `${p.file}#L${lo}`
        // the words the check found on the cited line, which the record opens with highlighted
        const cited = p.lines?.find((l) => l.n === lo && l.highlight)
        const words = cited?.highlight ? cited.text.slice(cited.highlight[0], cited.highlight[1]) : ''
        // the cited lines, and the lines around them that hold any text
        const rows = (p.lines ?? []).filter((l) => l.text.trim() || (l.n >= lo && l.n <= hi))
        return (
          <div key={i} className="mark-ev">
            <div className="refchip-pop-head">
              <Chip kind="ref" tone="evidence" icon={glyphOf(String(p.file ?? ''))} className="refchip-pop-chip" onClick={() => void quotedPlace(at, words).then(open)}>
                {`${p.file}:${p.line}`}
              </Chip>
              {i === 0 && <span className="refchip-pop-value">{value}</span>}
            </div>
            <div className="refchip-lines mono">
              {rows.map((l) => {
                // a long line shows the words around the ones the check found, cut at words
                const cut = lineWindow(l.text, l.highlight)
                const text = l.text.slice(cut.from, cut.to)
                const [x, y] = l.highlight ? [l.highlight[0] - cut.from, l.highlight[1] - cut.from] : [-1, -1]
                return (
                  <div key={l.n} className="refchip-line mark-ev-line">
                    <span className="mark-ev-n">{l.n}</span>
                    <span className="mark-ev-text">
                      {cut.lead && '…'}
                      {x >= 0 ? (
                        <>
                          {text.slice(0, x)}
                          <span className={CITED}>{text.slice(x, y)}</span>
                          {text.slice(y)}
                        </>
                      ) : (
                        text || ' '
                      )}
                      {cut.tail && '…'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </>
  )
}

type Resolved = { state: 'loading' } | { state: 'failed' } | { state: 'gone' } | { state: 'table'; grid: Grid; at: At } | { state: 'lines'; lines: string[]; from: number; to: number }

/** Whether the card still shows what the check read: the same cell in the same table, or the same cited lines. A
 * check's own copy of the card (`table`, `output`) that the card still shows is kept, with its other cited cells and
 * its highlights; else the card's output now is shown, or, when the place is gone, the copy with a note. Pure. */
export function sameAsChecked(snap: { grid: Grid; at: At } | null, output: string | undefined, highlight: [number, number][] | undefined, live: Resolved): boolean {
  if (live.state === 'table' && snap) {
    const cell = (g: Grid, at: At) => g.rows[at.r]?.values[at.c]
    return snap.grid.cols[snap.at.c] === live.grid.cols[live.at.c] && snap.grid.rows[snap.at.r]?.label === live.grid.rows[live.at.r]?.label && cell(snap.grid, snap.at) === cell(live.grid, live.at)
  }
  if (live.state === 'lines' && output != null) {
    const first = highlight?.length ? highlight[0][0] : -1
    const line = first < 0 ? null : output.slice(output.lastIndexOf('\n', first - 1) + 1).split('\n')[0]
    return line != null && live.lines.slice(live.from, live.to + 1).some((l) => l === line)
  }
  return false
}

/** what a card's evidence says when the card changed after its check: the cell it cites shows another value now, or
 * the place (a line of its output, a cell of a column renamed) no longer holds what the check read */
export const CHANGED_NOW = 'The card changed after the check. It shows this now:'
export const CHANGED_READ = 'The card changed after the check. The check read this:'

/** A value a card shows: the card's chip, by the card's title now, over the table around the cited cell, or the
 * printed lines around the cited one, as the card shows them now (api.resolveRef, as RefChip reads them). A line of the
 * printed output is named as the citation's chip names it (lib/refs cardPartLabel): `printed output · line 8` in the
 * card, after the card's title elsewhere. The check's own copy shows while the card is read and stays when the card
 * still shows the same (sameAsChecked). When the card changed, a note says so over the cell as it is now, or over the
 * copy when the place no longer holds what the check read. */
function CardEvidence({ ev, value }: { ev: Evidence; value: string }) {
  const open = useContext(OpenPlace)
  const home = useContext(CiteHome)
  const own = printedTable(ev.table, value)
  const [got, setGot] = useState<Resolved>({ state: 'loading' })
  const [now, setNow] = useState('')
  const ref = ev.ref ?? `card:${ev.card}`
  useEffect(() => {
    const p = parseRef(ref)
    const ws = workspaceFromUrl() ?? ''
    let live = true
    api
      .resolveRef(ws, ref)
      .then((r) => {
        if (!live) return
        if (typeof r.meta?.title === 'string') setNow(r.meta.title)
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
      .catch(() => live && setGot({ state: 'failed' }))
    return () => {
      live = false
    }
  }, [ref])
  const card = ev.card ?? (parseRef(ref) as { cellId?: string } | null)?.cellId ?? ''
  const name = useRefLabel(`card:${card}`)
  const copy = !!own || ev.output != null
  // the check's copy while the card is read, and after when the card still shows the same; else the card now
  // (a card that could not be read leaves the copy as it is, with no note)
  const checked = copy && (got.state === 'loading' || got.state === 'failed' || got.state === 'gone' || sameAsChecked(own, ev.output, ev.highlight, got))
  // a line of the output that reads otherwise now is no longer the place the check read: its copy shows
  const reread = copy && !checked && got.state === 'lines'
  const changed = reread || (copy && got.state === 'gone') ? CHANGED_READ : copy && !checked ? CHANGED_NOW : ''
  const title = now || ev.title || name || 'card'
  const at = parseRef(ref)
  const head = (at?.kind === 'cell' && at.out != null && at.line != null && cardPartLabel(at, title, home === at.cellId)) || title
  const table = checked || reread ? own : got.state === 'table' ? got : null
  return (
    <div className="mark-ev">
      <div className="refchip-pop-head">
        <Chip kind="ref" tone="evidence" icon="cell" face="sans" className="refchip-pop-chip" onClick={() => open(ref)}>
          {head}
        </Chip>
        {!table ? <span className="refchip-pop-value">{value}</span> : null}
      </div>
      {changed && <div className="mark-pop-state mark-ev-changed">{changed}</div>}
      {table ? (
        <TablePreview grid={table.grid} at={table.at} also={'also' in table ? table.also : undefined} />
      ) : (checked || reread) && ev.output != null ? (
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
    // of a long line, the words around its first highlighted span (lineWindow)
    const start = starts[i]
    const mark = sorted.find(([x, y]) => y > start && x < start + lines[i].length)
    const cut = lineWindow(lines[i], mark && [Math.max(0, mark[0] - start), Math.min(lines[i].length, mark[1] - start)])
    const a = start + cut.from
    const b = start + cut.to
    let pos = a
    const parts: ReactNode[] = cut.lead ? ['…'] : []
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
    if (cut.tail) parts.push('…')
    out.push(
      <div key={i} className="refchip-line">
        {lines[i] ? parts : ' '}
      </div>,
    )
  }
  if (to < lines.length) out.push(<div key="below" className="refchip-line mark-ev-more">…</div>)
  return out
}

/** The part of a line, `from` to `to`, that a mark's label shows: the whole line when it is LINE_SHOWN characters or
 * fewer; else the words around its marked span `at`, from the first that starts at most LINE_BEFORE characters before
 * it to the last that ends at most LINE_AFTER characters after it, or its first LINE_SHOWN characters' words when
 * nothing on it is marked. `lead` and `tail` say where it is cut, for a "…". A line the check cut short (it keeps 600
 * characters from 150 before the words, mid-word, with "…") is cut again here, at a word. Pure. */
export function lineWindow(text: string, at?: readonly [number, number]): { from: number; to: number; lead: boolean; tail: boolean } {
  if (text.length <= LINE_SHOWN) return { from: 0, to: text.length, lead: false, tail: false }
  const [a, b] = at ?? [0, 0]
  let from = Math.max(0, a - LINE_BEFORE)
  // the start of the next word, unless the marked words come first
  if (from > 0 && !/\s/.test(text[from - 1])) {
    const gap = text.slice(from, a).search(/\s/)
    if (gap >= 0) from += gap
  }
  while (from < a && /\s/.test(text[from])) from++
  let to = Math.min(text.length, at ? b + LINE_AFTER : LINE_SHOWN)
  // the end of the word before, unless the marked words end later
  if (to < text.length) {
    let k = to
    while (k > b && !/\s/.test(text[k])) k--
    if (k > b) to = k
    while (to > b && /\s/.test(text[to - 1])) to--
  }
  return { from, to, lead: from > 0, tail: to < text.length }
}
