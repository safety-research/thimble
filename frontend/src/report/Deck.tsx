// The deck: a rail of numbered slides at the left and the chosen slide at the centre, 16:9 at a fixed design size
// scaled to the stage, with the slide's format above and speaker notes below. The same editor lays out the frame before
// a write and edits the written deck after one (backend report_types.apply_deck, PUT …/deck). A slide's layout
// (model.ts PRESETS) arranges its cells: text, card slots (filled by drag, the picker, or a double-click in the
// sidebar) or a quote. Switching layouts keeps every cell. The rail adds, duplicates, deletes and reorders slides. Text
// cells read as prose and become fields on a click, saved after SAVE_DEBOUNCE_MS, on blur and on unmount. ⌘ held while
// typing in a slide's lines tints them, and ⌘↵ sends their text to main as a request on that slide (lib/agentKey); a
// card main makes for it lands on the slide. Text that overflows its cell is flagged above the slide and on its
// thumbnail. The arrow keys move while the deck has focus.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Button, Segmented } from '../components/Button'
import { Chip } from '../components/Chip'
import { Menu, Popover, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { addAgentZone, askMain, tintElement, whenMainIdle } from '../lib/agentKey'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import { teleport } from '../lib/teleport'
import type { DeckDoc, DeckSlide, WriteupSentence } from '../lib/types'
import { CARD_MIME, usedCells } from './cards'
import type { CheckLook, DocComment } from './checkComments'
import { SAVE_DEBOUNCE_MS, whenShown, type DocFilter } from './Editor'
import { EvidencePop, useEvidence } from './Evidence'
import { FigurePicker, FigureView } from './FigureBlock'
import { glyphOf, LayoutGlyph, LayoutPicker, presetGlyph } from './LayoutGlyph'
import { addSlot, applyPreset, deckBody, dropCard, duplicateSlide, editSlide, FIGURE_WIDTHS, linesFromText, moveItem, newSlide, PRESETS, presetOf, removeSlot, sentenceStands, slotsOf, type EditSlide } from './model'
import { Prose } from './Prose'
import { useCanvas } from './ReportPage'
import { Sidebar, type SidebarProps } from './Sidebar'

/** A new id in the server's alphabet, eight hex digits (report_types.BLOCK_ID_RE), so none reads as a paragraph's `p`. */
const mint = (): string => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
/** the slide's design size: every slide is laid out at this size and scaled to the stage */
const SLIDE_W = 960
const SLIDE_H = 540
/** the drag's data type: a slide dragged along the rail carries its index under it */
const SLIDE_MIME = 'application/x-thimble-slide'

export interface DeckHandle {
  /** a card double-clicked in the sidebar: onto the chosen slide */
  insertCard: (cellId: string) => void
}

export interface DeckViewProps {
  ws: string
  slug: string
  /** the written deck, or its frame before a write (`frame`) */
  doc: DeckDoc
  /** the tab's token on the editor's saves */
  client: string
  onSaved: (doc: DeckDoc) => void
  /** the document's open comments, the checks that are on, how their checks are drawn, and the comment the Checks
   * pane picked */
  comments: readonly DocComment[]
  on: ReadonlySet<string>
  look: CheckLook
  picked: DocComment | null
  filter: DocFilter | null
  ref?: Ref<DeckHandle>
}

interface DeckState {
  title: string
  slides: EditSlide[]
}

const derive = (doc: DeckDoc): DeckState => {
  const slides = (doc.slides ?? []).map(editSlide)
  return { title: doc.title ?? '', slides: slides.length ? slides : [newSlide(mint)] }
}

/** The deck's state over the stored deck and its saves: a change is saved after SAVE_DEBOUNCE_MS; a deck from outside
 * (another tab, a write, the chat's edit) or this tab's own save replaces the state while nothing typed is pending. */
function useDeckEdit(ws: string, slug: string, doc: DeckDoc, client: string, onSaved: (doc: DeckDoc) => void) {
  const [state, setState] = useState<DeckState>(() => derive(doc))
  const current = useRef(state)
  const dirty = useRef(false)
  const timer = useRef<number | null>(null)
  const inflight = useRef<Promise<void> | null>(null)
  const queued = useRef(false)

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    if (inflight.current) {
      queued.current = true
      return
    }
    dirty.current = false
    const body = deckBody(current.current.title, current.current.slides, client)
    const p = (async () => {
      try {
        const saved = await docsApi.putDeck(ws, slug, body)
        track('report-frame-edit', { target: `report:${slug}`, detail: { deck: true, slides: body.slides.length } })
        onSaved(saved)
      } catch (e) {
        dirty.current = true
        bus.emit('toast', { text: `Could not save the ${slug}. ${(e as Error).message}`, kind: 'error' })
      } finally {
        inflight.current = null
        if (queued.current) {
          queued.current = false
          void flush()
        }
      }
    })()
    inflight.current = p
    await p
  }, [ws, slug, client, onSaved])

  const change = useCallback(
    (next: (s: DeckState) => DeckState) => {
      current.current = next(current.current)
      setState(current.current)
      dirty.current = true
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  const seen = useRef(doc)
  useEffect(() => {
    if (doc === seen.current) return
    seen.current = doc
    if (dirty.current || inflight.current) return
    current.current = derive(doc)
    setState(current.current)
  }, [doc])

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
      if (dirty.current) void flush()
    },
    [flush],
  )
  return { state, change, flush }
}

export function DeckView({ ws, slug, doc, client, onSaved, comments, on, look, picked, filter, ref }: DeckViewProps) {
  const edit = useDeckEdit(ws, slug, doc, client, onSaved)
  const root = useRef<HTMLDivElement | null>(null)
  // an empty deck opens with the caret in its slide's heading (in a hidden tab, once the tab is shown)
  useEffect(() => {
    const empty = edit.state.slides.length === 1 && !edit.state.slides[0].heading.trim() && !edit.state.slides[0].lines.length
    if (!empty) return
    return whenShown(root.current, () => root.current?.querySelector<HTMLTextAreaElement>('.wu-sl-h')?.focus())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const slides = edit.state.slides
  const [n, setN] = useState(0)
  const count = slides.length
  const at = Math.min(n, count - 1)
  const slide = slides[at]
  const ev = useEvidence(comments, on, look, picked)
  // the stored sentences by id, for a line's citations, tags and tint while it reads as prose
  const stored = useMemo(() => {
    const out = new Map<string, WriteupSentence>()
    for (const s of doc.slides ?? []) for (const x of s.sentences ?? []) out.set(x.id, x)
    return out
  }, [doc])
  // a comment picked in the Checks pane: the slide its passage is on comes forward
  useEffect(() => {
    if (!picked) return
    const i = slides.findIndex((s) => s.id === picked.sid || s.lines.some((x) => x.id === picked.sid) || s.quote?.id === picked.sid)
    if (i >= 0) setN(i)
  }, [picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const setSlide = useCallback((i: number, patch: Partial<EditSlide> | ((s: EditSlide) => EditSlide)) => edit.change((d) => ({ ...d, slides: d.slides.map((s, k) => (k === i ? (typeof patch === 'function' ? patch(s) : { ...s, ...patch }) : s)) })), [edit])
  const addSlide = (layout: string) => {
    edit.change((d) => ({ ...d, slides: [...d.slides.slice(0, at + 1), newSlide(mint, layout), ...d.slides.slice(at + 1)] }))
    setN(at + 1)
    track('ui-click', { target: `report:${slug}`, detail: { action: 'slide-add', layout } })
  }
  const setLayout = (layout: string) => {
    setSlide(at, (s) => applyPreset(s, layout))
    track('ui-click', { target: `report:${slug}#${slide.id}`, detail: { action: 'slide-layout', layout } })
  }
  const setSlots = (next: EditSlide | null, action: 'slot-add' | 'slot-remove') => {
    if (!next) return
    setSlide(at, next)
    track('ui-click', { target: `report:${slug}#${slide.id}`, detail: { action, slots: slotsOf(next) } })
  }
  const duplicate = (i: number) => {
    edit.change((d) => ({ ...d, slides: [...d.slides.slice(0, i + 1), duplicateSlide(d.slides[i], mint), ...d.slides.slice(i + 1)] }))
    setN(i + 1)
  }
  const remove = (i: number) => {
    edit.change((d) => {
      const rest = d.slides.filter((_, k) => k !== i)
      return { ...d, slides: rest.length ? rest : [newSlide(mint)] }
    })
    setN(Math.max(0, i - 1))
  }
  const move = (from: number, to: number) => {
    if (from === to) return
    edit.change((d) => ({ ...d, slides: moveItem(d.slides, from, to) }))
    setN(to > from ? to - 1 : to)
  }
  const putCard = useCallback(
    (i: number, cellId: string, slot: number | null = null) => {
      setSlide(i, (s) => dropCard(s, cellId, mint, slot))
      track('ui-click', { target: `card:${cellId}`, detail: { action: 'slide-card', slug } })
    },
    [setSlide, slug],
  )
  useImperativeHandle(ref, () => ({ insertCard: (cellId: string) => putCard(at, cellId) }), [putCard, at])

  // ⌘↵ in a slide's lines: the text goes to main as a request made on that slide, which shows it is out until the card
  // main makes for it lands on the slide or main's turn ends
  const asks = useRef(new Map<string, string>())
  const idle = useRef(new Map<string, () => void>())
  const [asking, setAsking] = useState<ReadonlySet<string>>(() => new Set())
  const slidesRef = useRef(slides)
  slidesRef.current = slides
  const settle = useCallback((request: string, slideId: string) => {
    asks.current.delete(request)
    idle.current.get(request)?.()
    idle.current.delete(request)
    setAsking((a) => {
      if (![...asks.current.values()].includes(slideId)) {
        const next = new Set(a)
        next.delete(slideId)
        return next
      }
      return a
    })
  }, [])
  useEffect(() => () => idle.current.forEach((cancel) => cancel()), [])
  useEffect(
    () =>
      bus.on('cardRequest', ({ request, card }) => {
        const id = asks.current.get(request)
        if (!id) return
        const i = slidesRef.current.findIndex((x) => x.id === id)
        if (i >= 0) putCard(i, card)
        settle(request, id)
      }),
    [putCard, settle],
  )
  const askSlide = async (slideId: string, text: string) => {
    try {
      await edit.flush()
      const request = await askMain(ws, text, { doc: slug, after: `report:${slug}#${slideId}` })
      asks.current.set(request, slideId)
      setAsking((a) => new Set(a).add(slideId))
      idle.current.set(request, whenMainIdle(ws, () => settle(request, slideId)))
      track('ui-click', { target: `report:${slug}#${slideId}`, detail: { action: 'ask', request } })
    } catch (e) {
      bus.emit('toast', { text: `Could not send the request. ${(e as Error).message}`, kind: 'error' })
    }
  }

  const go = (to: number) => setN(Math.min(count - 1, Math.max(0, to)))
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault()
      go(at + 1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault()
      go(at - 1)
    }
  }
  const sets = filter?.sets ?? null
  const dim = (s: EditSlide) => !!sets && s.lines.length > 0 && !s.lines.some((x) => sentenceStands(sets, x.id))
  const [over, setOver] = useState<Record<string, boolean>>({})
  const addItems: MenuItem[] = PRESETS.map((p) => ({
    id: p.id,
    label: (
      <span className="wu-layout-item">
        <LayoutGlyph slide={presetGlyph(p)} />
        {p.label}
      </span>
    ),
    onSelect: () => addSlide(p.id),
  }))
  const slots = slotsOf(slide)
  const more = addSlot(slide)
  const fewer = removeSlot(slide)
  return (
    <div className="wu-deck" ref={root} tabIndex={0} onKeyDown={onKey} data-deck={slug} data-slide={slide.id} onMouseOver={ev.onOver} onMouseLeave={ev.onLeave}>
      <Rail ws={ws} slug={slug} slides={slides} at={at} over={over} dim={dim} onPick={setN} onMove={move} onDuplicate={duplicate} onRemove={remove} onCard={(i, id) => putCard(i, id)} addItems={addItems} />
      <div className="wu-deck-stage">
        <div className="wu-deck-tools">
          <LayoutPicker value={presetOf(slide)} onChange={setLayout} />
          {slide.layout !== 'quote' && (
            <span className="wu-deck-slots" role="group" aria-label="Card slots">
              <Button variant="icon" size="sm" icon="minus" title="Remove a card slot" disabled={!fewer} onClick={() => setSlots(fewer, 'slot-remove')} />
              <span className="wu-deck-slots-n">{slots === 1 ? '1 card slot' : `${slots} card slots`}</span>
              <Button variant="icon" size="sm" icon="plus" title="Add a card slot" disabled={!more} onClick={() => setSlots(more, 'slot-add')} />
            </span>
          )}
          {slide.layout === 'figure' && (
            <Segmented
              size="sm"
              label="Figure side"
              value={slide.side}
              onChange={(v) => setSlide(at, { side: v })}
              options={[
                { value: 'left', label: 'Cards left' },
                { value: 'right', label: 'Cards right' },
              ]}
            />
          )}
          {slide.layout === 'figure' && <Segmented size="sm" label="Figure width" value={String(slide.width)} onChange={(v) => setSlide(at, { width: Number(v) })} options={FIGURE_WIDTHS.map((w) => ({ value: String(w), label: `${w}%` }))} />}
          <span className="wu-deck-tools-gap" />
          {asking.has(slide.id) && (
            <span className="wu-deck-asking" role="status">
              <Spinner size={10} label="working" />
              Sent to main
            </span>
          )}
          {over[slide.id] && (
            <Chip kind="status" tone="warning" icon="warning">
              Text runs past the slide
            </Chip>
          )}
        </div>
        <SlideFrame key={slide.id} onOver={(v) => setOver((o) => (o[slide.id] === v ? o : { ...o, [slide.id]: v }))}>
          <SlideBody ws={ws} slug={slug} slide={slide} stored={stored} flags={ev.flags} dim={dim(slide)} foot={doc.frame ? '' : `${ws} · draft ${doc.generation ?? 1}`} onChange={(patch) => setSlide(at, patch)} onCard={(id, slot) => putCard(at, id, slot)} onAsk={(text) => void askSlide(slide.id, text)} onBlur={() => void edit.flush()} />
        </SlideFrame>
        <InlineCell ws={ws} slug={slug} id={`${slide.id}-notes`} className="wu-slide-notes" label="Notes" value={slide.notes} onCommit={(v) => setSlide(at, { notes: v })} onBlur={() => void edit.flush()} />
      </div>
      <EvidencePop comments={ev.hovered} look={look} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- the rail

interface RailProps {
  ws: string
  slug: string
  slides: EditSlide[]
  at: number
  over: Record<string, boolean>
  dim: (s: EditSlide) => boolean
  onPick: (i: number) => void
  onMove: (from: number, to: number) => void
  onDuplicate: (i: number) => void
  onRemove: (i: number) => void
  onCard: (i: number, cellId: string) => void
  addItems: MenuItem[]
}

/** The rail: a thumbnail per slide, its number and its layout drawn under its heading; drag one to move it, drop a
 * card on one to put it on that slide; its hover actions duplicate and delete it; + adds a slide of a layout after the
 * chosen one. */
function Rail({ slug, slides, at, over, dim, onPick, onMove, onDuplicate, onRemove, onCard, addItems }: RailProps) {
  const [target, setTarget] = useState<number | null>(null)
  const kind = (e: DragEvent) => (Array.from(e.dataTransfer.types).includes(SLIDE_MIME) ? 'slide' : Array.from(e.dataTransfer.types).includes(CARD_MIME) ? 'card' : null)
  return (
    <div className="wu-deck-rail" role="listbox" aria-label="Slides">
      {slides.map((s, i) => (
        <div
          key={s.id}
          role="option"
          aria-selected={i === at}
          tabIndex={-1}
          className={`wu-thumb-row${target === i ? ' wu-thumb-target' : ''}`}
          draggable
          data-anchor={`report:${slug}#${s.id}`}
          onClick={() => onPick(i)}
          onDragStart={(e) => {
            e.dataTransfer.setData(SLIDE_MIME, String(i))
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            const k = kind(e)
            if (!k) return
            e.preventDefault()
            e.dataTransfer.dropEffect = k === 'slide' ? 'move' : 'copy'
            if (target !== i) setTarget(i)
          }}
          onDragLeave={() => setTarget((t) => (t === i ? null : t))}
          onDrop={(e) => {
            e.preventDefault()
            setTarget(null)
            const from = e.dataTransfer.getData(SLIDE_MIME)
            if (from !== '') onMove(Number(from), i)
            else {
              const card = e.dataTransfer.getData(CARD_MIME)
              if (card) onCard(i, card)
            }
          }}
        >
          <span className="wu-thumb-n">{i + 1}</span>
          <span className={`wu-thumb${i === at ? ' active' : ''}${dim(s) ? ' wu-dim' : ''}`}>
            <span className="wu-thumb-h">{s.heading}</span>
            <LayoutGlyph slide={glyphOf(s)} heading={false} stretch className="wu-sketch" />
            {over[s.id] && <span className="wu-thumb-over" aria-label="Text runs past the slide" />}
          </span>
          <span className="wu-thumb-acts">
            <Button variant="icon" size="sm" icon="cell-add" title="Duplicate" aria-label="Duplicate slide" onClick={(e) => (e.stopPropagation(), onDuplicate(i))} />
            <Button variant="icon" size="sm" icon="trash" title="Delete" aria-label="Delete slide" onClick={(e) => (e.stopPropagation(), onRemove(i))} />
          </span>
        </div>
      ))}
      <Menu label="New slide" items={addItems} trigger={<Button variant="icon" size="sm" icon="plus" title="New slide" aria-label="New slide" className="wu-thumb-add" />} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- the slide

/** The slide's 16:9 box: the slide laid out at its design size and scaled to the stage's width; `onOver` hears
 * whether any text cell runs past its room. */
function SlideFrame({ children, onOver }: { children: ReactNode; onOver: (over: boolean) => void }) {
  const box = useRef<HTMLDivElement | null>(null)
  const inner = useRef<HTMLDivElement | null>(null)
  const [k, setK] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setK(el.clientWidth / SLIDE_W)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // a text cell whose content is taller than its room; read after each render and whenever a cell's size changes
  useEffect(() => {
    const el = inner.current
    if (!el) return
    // the slide, each text cell, and each layout's column or row, whose content can run past it while the cell does not
    const cells = () => Array.from(el.querySelectorAll<HTMLElement>('.wu-slide, .wu-cell-text, .wu-sl-quote, .wu-sl-title, .wu-sl-row, .wu-sl-cards, .wu-sl-stack'))
    const check = () => onOver(cells().some((c) => c.scrollHeight > c.clientHeight + 2))
    check()
    const ro = new ResizeObserver(check)
    for (const c of cells()) {
      ro.observe(c)
      for (const kid of Array.from(c.children)) ro.observe(kid)
    }
    return () => ro.disconnect()
  })
  return (
    <div className="wu-slide-box" ref={box}>
      <div className="wu-slide-scaled" ref={inner} style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${k})`, visibility: k ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

interface SlideBodyProps {
  ws: string
  slug: string
  slide: EditSlide
  stored: ReadonlyMap<string, WriteupSentence>
  flags: ReturnType<typeof useEvidence>['flags']
  dim: boolean
  /** where the slide comes from, at its foot: the corpus and the draft of a written deck */
  foot: string
  onChange: (patch: Partial<EditSlide>) => void
  onCard: (cellId: string, slot: number | null) => void
  /** ⌘↵ in the lines: their text as typed, sent to main */
  onAsk: (text: string) => void
  onBlur: () => void
}

/** One slide in its layout: the heading, then the cells the layout shows. */
function SlideBody({ ws, slug, slide, stored, flags, dim, foot, onChange, onCard, onAsk, onBlur }: SlideBodyProps) {
  const [dropAt, setDropAt] = useState<number | 'any' | null>(null)
  const isCard = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(CARD_MIME)
  const slotOf = (e: DragEvent): number | null => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]')
    return hit ? Number(hit.dataset.slot) : null
  }
  const lines = <Lines ws={ws} slug={slug} slide={slide} stored={stored} flags={flags} onChange={onChange} onAsk={onAsk} onBlur={onBlur} />
  const n = slotsOf(slide)
  // where a card dropped on the slide outside any slot lands: the first empty slot, else the last
  const landing = Math.min(slide.figures.length, Math.max(n, 1) - 1)
  const slot = (i: number) => (
    <FigureSlot key={i} ws={ws} slug={slug} index={i} figure={slide.figures[i] ?? null} target={dropAt === i || (dropAt === 'any' && i === landing)} onPick={(id) => onCard(id, i)} onRemove={() => onChange({ figures: slide.figures.filter((_, k) => k !== i) })} onCaption={(caption) => onChange({ figures: slide.figures.map((f, k) => (k === i ? { ...f, caption } : f)) })} onBlur={onBlur} />
  )
  const cards = (cols: number, className: string) => (
    <div className={className} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(n / cols)}, minmax(0, 1fr))` }}>
      {Array.from({ length: n }, (_, i) => slot(i))}
    </div>
  )
  const heading = <TextField className="wu-sl-h" label="Heading" value={slide.heading} onChange={(v) => onChange({ heading: v.replace(/\n/g, ' ') })} onBlur={onBlur} />
  let body: ReactNode
  switch (slide.layout) {
    case 'title':
      body = (
        <div className="wu-sl-title">
          {heading}
          {lines}
        </div>
      )
      break
    case 'figure':
      body = (
        <>
          {heading}
          <div className={`wu-sl-row${slide.side === 'left' ? ' wu-sl-row-left' : ''}`} style={{ gridTemplateColumns: slide.side === 'left' ? `${slide.width}fr ${100 - slide.width}fr` : `${100 - slide.width}fr ${slide.width}fr` }}>
            {lines}
            {n > 1 ? cards(1, 'wu-sl-stack') : slot(0)}
          </div>
        </>
      )
      break
    case 'card':
      body = (
        <>
          <span className="wu-sl-kicker">{heading}</span>
          {slot(0)}
        </>
      )
      break
    case 'figures':
      body = (
        <>
          {heading}
          {cards(slide.grid && n === 4 ? 2 : n, `wu-sl-cards${slide.grid && n === 4 ? ' wu-sl-grid' : ''}`)}
        </>
      )
      break
    case 'quote':
      // the quote cell takes a quote of a record, or a card that shows one (an example, a picture of a message) when
      // the slide has a figure and no quote; the lines stand under it as its context
      body = (
        <div className="wu-sl-quote">
          <span className="wu-sl-kicker">{heading}</span>
          {!slide.quote?.text && slide.figures[0] ? <div className="wu-sl-qfig">{slot(0)}</div> : <QuoteCell ws={ws} slug={slug} slide={slide} stored={stored} flags={flags} onChange={onChange} onBlur={onBlur} />}
          {lines}
        </div>
      )
      break
    default:
      body = (
        <>
          {heading}
          {lines}
        </>
      )
  }
  return (
    <div
      className={`wu-slide wu-layout-${slide.layout}${dim ? ' wu-dim' : ''}`}
      data-anchor={`report:${slug}#${slide.id}`}
      data-anchor-text={slide.heading}
      onDragOver={(e) => {
        if (!isCard(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        const at = slotOf(e)
        setDropAt(at ?? 'any')
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropAt(null)
      }}
      onDrop={(e) => {
        if (!isCard(e)) return
        e.preventDefault()
        setDropAt(null)
        const id = e.dataTransfer.getData(CARD_MIME)
        if (id) onCard(id, slotOf(e))
      }}
    >
      {body}
      {foot && <span className="wu-slide-src">{foot}</span>}
    </div>
  )
}

/** the smallest share of its type size a slide's lines shrink to before they are said to run past the slide */
const FIT_MIN = 0.7

/** A text cell's type scaled down in steps until its text fits its room, as a slide program fits text to its box, down
 * to FIT_MIN; its text changing starts again at full size. */
function useAutoFit(text: string): { cell: (el: HTMLDivElement | null) => void; fit: number } {
  const el = useRef<HTMLDivElement | null>(null)
  const [fit, setFit] = useState(1)
  useLayoutEffect(() => setFit(1), [text])
  useLayoutEffect(() => {
    const c = el.current
    if (c && fit > FIT_MIN && c.scrollHeight > c.clientHeight + 2) setFit((f) => Math.max(FIT_MIN, Math.round(f * 90) / 100))
  })
  return { cell: (node) => void (el.current = node), fit }
}

/** The slide's lines: prose with its citations and tints, a field on a click (one line per sentence), their type
 * fitted to their room. */
function Lines({ ws, slug, slide, stored, flags, onChange, onAsk, onBlur }: Pick<SlideBodyProps, 'ws' | 'slug' | 'slide' | 'stored' | 'flags' | 'onChange' | 'onAsk' | 'onBlur'>) {
  const sentences = slide.lines.map((l) => sentenceOf(l, stored))
  const text = slide.lines.map((l) => l.text).join('\n')
  const { cell, fit } = useAutoFit(`${slide.layout}\n${text}`)
  return (
    <EditableCell
      className={`wu-cell-text wu-sl-lines${slide.bullets ? ' wu-sl-bullets' : ''}`}
      label="Lines"
      text={text}
      fit={fit}
      cellRef={cell}
      onCommit={(value) => onChange({ lines: linesFromText(value, slide.lines, mint) })}
      onAsk={onAsk}
      onBlur={onBlur}
    >
      {sentences.length > 0 &&
        (slide.bullets ? (
          <ul>
            {sentences.map((s) => (
              <li key={s.id}>
                <Prose ws={ws} slug={slug} sentences={[s]} flags={flags} className="wu-slide-line" />
              </li>
            ))}
          </ul>
        ) : (
          <Prose ws={ws} slug={slug} sentences={sentences} flags={flags} className="wu-slide-line" />
        ))}
    </EditableCell>
  )
}

/** A quote slide's quote, its text large with its citation, and its speaker under it. */
function QuoteCell({ ws, slug, slide, stored, flags, onChange, onBlur }: Pick<SlideBodyProps, 'ws' | 'slug' | 'slide' | 'stored' | 'flags' | 'onChange' | 'onBlur'>) {
  const q = slide.quote
  const set = (patch: Partial<{ text: string; speaker: string }>) => onChange({ quote: { id: q?.id ?? mint(), text: q?.text ?? '', speaker: q?.speaker ?? '', ...patch } })
  return (
    <>
      <EditableCell className={`wu-cell-text wu-sl-q wu-sl-q-${quoteSize(q?.text ?? '')}`} label="Quote" text={q?.text ?? ''} onCommit={(text) => set({ text: text.replace(/\n+/g, ' ').trim() })} onBlur={onBlur}>
        {q?.text && <Prose ws={ws} slug={slug} sentences={[sentenceOf(q, stored)]} flags={flags} />}
      </EditableCell>
      <TextField className="wu-sl-who" label="Speaker" value={q?.speaker ?? ''} onChange={(v) => set({ speaker: v.replace(/\n/g, ' ') })} onBlur={onBlur} />
    </>
  )
}

/** A quote's type size by its length, so a long quote still fits the slide: short, medium or long. */
const quoteSize = (text: string): 's' | 'm' | 'l' => (text.length <= 120 ? 's' : text.length <= 240 ? 'm' : 'l')

/** The stored sentence a line shows, while its text is the stored one; else the line as typed. */
function sentenceOf(line: { id: string; text: string }, stored: ReadonlyMap<string, WriteupSentence>): WriteupSentence {
  const s = stored.get(line.id)
  return s && s.text === line.text ? s : { id: line.id, text: line.text, refs: [], tags: [] }
}

interface FigureSlotProps {
  ws: string
  slug: string
  index: number
  figure: { id: string; cell: string; caption: string } | null
  /** a card dragged over the slide would land here */
  target: boolean
  onPick: (cellId: string) => void
  onRemove: () => void
  onCaption: (caption: string) => void
  onBlur: () => void
}

/** A figure slot: the card scaled to fit it, with × at its corner and its caption under it; empty, an empty cell that
 * takes a dropped card or opens the picker on a click. */
function FigureSlot({ ws, slug, index, figure, target, onPick, onRemove, onCaption, onBlur }: FigureSlotProps) {
  const [picking, setPicking] = useState(false)
  const el = useRef<HTMLDivElement | null>(null)
  if (!figure)
    return (
      <div ref={el} className={`wu-cell-fig wu-cell-empty${target ? ' wu-cell-target' : ''}`} data-slot={index}>
        <button type="button" className="wu-cell-pick" aria-label="Pick a card" onClick={() => setPicking(true)} />
        <Popover anchor={el} open={picking} onClose={() => setPicking(false)} label="Cards" width={320} className="wu-slot-picker">
          <FigurePicker
            ws={ws}
            onPick={(c) => {
              setPicking(false)
              onPick(c.id)
            }}
            onClose={() => setPicking(false)}
          />
        </Popover>
      </div>
    )
  return (
    <div className={`wu-cell-fig${target ? ' wu-cell-target' : ''}`} data-slot={index}>
      <FitBox>
        <FigureView ws={ws} figure={{ id: figure.id, cell: figure.cell, caption: figure.caption }} bare />
      </FitBox>
      <div className="wu-cell-fig-foot">
        <InlineCell ws={ws} slug={slug} id={`${figure.id}-caption`} className="wu-sl-cap" label="Caption" value={figure.caption} onCommit={(v) => onCaption(v.replace(/\n+/g, ' ').trim())} onBlur={onBlur} />
        <button type="button" className="wu-slide-src wu-slide-src-link" onClick={() => teleport(figure.cell)}>
          from canvas
        </button>
      </div>
      <Button variant="icon" size="sm" icon="x" title="Remove" aria-label="Remove figure" className="wu-cell-x" onClick={onRemove} />
    </div>
  )
}

/** Its content scaled down, never up, to fit its box, so a tall chart or a wide table stays whole in its slot. The
 * content is laid out at the box's width (or its widest table's), and the layout width never depends on the scale,
 * since a chart drawn to its width grows taller as it widens. */
function FitBox({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null)
  const inner = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const b = box.current
    const el = inner.current
    if (!b || !el) return
    const fit = () => {
      const bw = b.clientWidth
      const bh = b.clientHeight
      if (!bw || !bh) return
      el.style.width = `${bw}px`
      const w = Math.max(bw, el.scrollWidth, ...Array.from(el.querySelectorAll<HTMLElement>('table'), (t) => t.scrollWidth))
      el.style.width = `${w}px`
      const h = el.scrollHeight
      const k = Math.min(1, bw / w, h ? bh / h : 1)
      el.style.transform = k < 0.995 ? `scale(${k})` : ''
      // content scaled narrower than its box stands at the box's centre
      el.style.marginLeft = k < 0.995 ? `${Math.max(0, (bw - w * k) / 2)}px` : ''
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(b)
    ro.observe(el)
    for (const kid of Array.from(el.children)) ro.observe(kid)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="wu-fit" ref={box}>
      <div className="wu-fit-in" ref={inner}>
        {children}
      </div>
    </div>
  )
}

interface EditableCellProps {
  className: string
  /** the field's name for assistive tech; nothing shows it */
  label: string
  /** the cell's text as the field edits it */
  text: string
  onCommit: (text: string) => void
  onBlur: () => void
  /** the cell as it reads: prose with its citations */
  children: ReactNode
  /** the share of its type size the cell's text is set at (useAutoFit) */
  fit?: number
  /** the element that reads as prose, for the fit's measure */
  cellRef?: (el: HTMLDivElement | null) => void
  /** ⌘↵ in the field (lib/agentKey): the field closes on the cell's text as it was, and what was typed goes here */
  onAsk?: (text: string) => void
}

/** A text cell that reads as prose and becomes a field on a click (or Enter, or a double click on a line a comment
 * tints, whose single click shows the comment), committed on blur; Escape leaves the field as it was. A click that ends
 * a selection leaves the prose for the selection's Comment. An empty cell is drawn as an empty cell. */
export function EditableCell({ className, label, text, onCommit, onBlur, children, fit = 1, cellRef, onAsk }: EditableCellProps) {
  const style = fit < 1 ? ({ '--fit': fit } as React.CSSProperties) : undefined
  const [editing, setEditing] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  // a field closed by ⌘↵ commits nothing when its blur follows
  const asked = useRef(false)
  const now = useRef({ editing, onAsk })
  now.current = { editing, onAsk }
  useEffect(() => {
    if (editing != null) asked.current = false
    const root = box.current
    if (editing == null || !root || !onAsk) return
    return addAgentZone(root, () => {
      const typed = now.current.editing?.trim()
      const send = now.current.onAsk
      if (!typed || !send) return null
      return {
        tint: tintElement(() => box.current),
        send: () => {
          asked.current = true
          setEditing(null)
          send(typed)
        },
      }
    })
  }, [editing != null, !!onAsk]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const t = field.current
    if (editing == null || !t) return
    t.style.height = '0px'
    t.style.height = `${t.scrollHeight}px`
  }, [editing])
  useEffect(() => {
    if (editing != null) field.current?.focus()
  }, [editing != null]) // eslint-disable-line react-hooks/exhaustive-deps
  if (editing != null)
    return (
      <div key="editing" ref={box} className={`${className} wu-cell-editing`} style={style}>
        <textarea
          ref={field}
          className="wu-cell-field"
          aria-label={label}
          value={editing}
          spellCheck
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(null)
            }
          }}
          onBlur={() => {
            if (editing !== text && !asked.current) onCommit(editing)
            asked.current = false
            setEditing(null)
            onBlur()
          }}
        />
      </div>
    )
  // its own element, not the field's, so it opens at its top rather than where the field was scrolled
  return (
    <div
      key="reading"
      ref={cellRef}
      style={style}
      className={`${className}${text.trim() ? '' : ' wu-cell-empty'}`}
      role="textbox"
      aria-label={label}
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as Element).closest('a, button, .refchip')) return
        // a selection made in the cell is the analyst's to comment on (SelectComment.tsx), and a click on a tinted
        // sentence holds its evidence card (Documents.tsx), so neither opens the field; a double click or Enter does
        const sel = document.getSelection()
        if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return
        if ((e.target as Element).closest('[data-cids]')) return
        setEditing(text)
      }}
      onDoubleClick={() => setEditing(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          setEditing(text)
        }
      }}
    >
      {children}
    </div>
  )
}

/** A text cell of a slide's own (the notes, a figure's caption) that reads as prose, its citations as chips rather than
 * their markup, and becomes a field on a click. */
function InlineCell({ ws, slug, id, className, label, value, onCommit, onBlur }: { ws: string; slug: string; id: string; className: string; label: string; value: string; onCommit: (v: string) => void; onBlur: () => void }) {
  return (
    <EditableCell className={className} label={label} text={value} onCommit={onCommit} onBlur={onBlur}>
      {value.trim() && <Prose ws={ws} slug={slug} sentences={[{ id, text: value, refs: [], tags: [] }]} />}
    </EditableCell>
  )
}

/** A plain text field as tall as its text (a heading, a speaker), drawn as an empty cell until it has text. */
function TextField({ className, label, value, onChange, onBlur }: { className: string; label: string; value: string; onChange: (v: string) => void; onBlur: () => void }) {
  const el = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const t = el.current
    if (!t) return
    t.style.height = '0px'
    t.style.height = `${t.scrollHeight}px`
  }, [value])
  return <textarea ref={el} className={`wu-tpl ${className}${value.trim() ? '' : ' wu-tpl-empty'}`} value={value} rows={1} aria-label={label} spellCheck onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
}

/** The cards a deck shows as figures, for the sidebar's ✓. */
export function deckCells(doc: DeckDoc | null): string[] {
  return (doc?.slides ?? []).flatMap((s: DeckSlide) => [s.figure, ...(s.figures ?? [])].filter((f): f is { id: string; cell: string; caption: string } => !!f?.cell).map((f) => f.cell))
}

/** The slides' sidebar: the canvas's cards, as the report's sidebar lists them, to drag onto a slide or place on the
 * chosen one with a double-click, then the Checks pane. */
export function DeckSidebar({ ws, doc, slug, onInsert, onHide, over, checks, comments }: Omit<SidebarProps, 'cells' | 'groups' | 'used' | 'doc'> & { doc: DeckDoc | null; slug: string }) {
  const { cells, groups } = useCanvas(ws)
  const used = useMemo(() => usedCells(deckCells(doc)), [doc])
  return <Sidebar ws={ws} cells={cells} groups={groups} used={used} onInsert={onInsert} onHide={onHide} over={over} doc={slug} checks={checks} comments={comments} />
}
