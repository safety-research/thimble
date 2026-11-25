// The toolbar at the selection: words selected with the mouse in one of Claude's answers, in main's chat or a side
// thread's, show a small toolbar just above them, next to where the selection ends (under them when there is no room
// above), with two buttons, Explain and Cite. They do with the words what the terminal's e and c do
// (plugin/explain/seam.ts, plugin/marks/cite.ts), each a button of the workbench with its icon and its word. A click on
// one acts while such a selection stands; Escape, a click elsewhere, or a selection outside the answers takes the
// toolbar away. Explain shows only while the chat shows the Explainers check's comments (on, with Chat in its Show in),
// as the terminal leaves e out while Explainers is off; the workbench has no switch for Cite. Asking about words stays
// with the ⌘ pointer: a ⌘-click or a ⌘-drag over them opens its ask box (pointer/CmdPointer.tsx), and the toolbar does
// not show while it points or its box is open. The words a button takes are the terminal's (plugin/marks/asked.mjs
// pickedWords).
//
//   Explain   the words take an explainer (backend explain.py), tinted in the Explainers color while it is written
//             (useAsking, which the chat draws), and its comment card opens beside them at once, a spinner where its
//             text will stand (chat/Rows, AnswerComment.tsx); once written, the text takes the spinner's place in that
//             card, and a failure says why there. Words an explainer or a heads-up stands on open that one at once
//   Cite      the words become a citation of their answer (backend marks.cite), placed with the terminal's own code
//             (asked.mjs citeAt), or the citation they stand in opens; the citation's label opens on it at once
//             (marks/marks.ts wantMark), checking, then verified or failed with its evidence, as any citation's
//
// Explain and Cite act on the words where they were selected: words may stand more than once in a row, so the toolbar
// takes which of their places the selection lies on (rankIn, asked.mjs rankOf). Cite places its citation there, and
// Explain sends the place in the row's text, where the server keeps the explainer, on the sentence that holds it.
//
// The card of an explainer being written is the chat's, which notes here while it stands open (cardShown). Closed
// before the explainer is written, by Escape, a click elsewhere or another comment, it does not open again by itself:
// the written explainer's words show its tint, as any explainer's, and a failure is a toast.
//
// The toolbar stands over the line above the words, where a citation or a card's chip opens its box on hover. After a
// click with the pointer, the toolbar stays where it was, unseen and with no buttons, until the pointer moves, presses
// or turns the wheel, so a pointer that did not move hovers nothing under it. A click from the keyboard takes the
// toolbar away at once.
//
// Each text row a chat draws notes itself here (noteRow) by its anchor, `chat:<id>#<index>`, with its turn, its text
// and its marks, which the toolbar reads; a row of an answer still being written shows no toolbar.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CITE_WHY, citeAt, pickedPlace, pickedWords, rankOf } from '../../../../plugin/marks/asked.mjs'
import { sentenceSpan } from '../../../../plugin/marks/message.js'
import { Button } from '../components/Button'
import type { IconName } from '../components/Icon'
import { api, marksApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { Check } from '../lib/types'
import type { MarkItem } from '../marks/marks'
import { wantMark } from '../marks/marks'
import { useChecks } from '../report/Checks'
import { coversOf } from '../report/checkComments'
import { typingIn } from '../shell/undo'
import { plainQuote, timesIn, wantComment, wordsAt } from './answerComments'

/** A text row as a chat draws it (chat/Rows), which the toolbar reads. */
export interface PickedRow {
  chat: string
  index: number
  /** the turn its `done` record names; none while the answer is written */
  turn?: string
  text: string
  checks?: (MarkItem | undefined)[]
  asked?: MarkItem[]
  streaming: boolean
}

const rows = new Map<string, PickedRow>()

/** A chat draws this text row now. */
export function noteRow(row: PickedRow): void {
  rows.set(`chat:${row.chat}#${row.index}`, row)
}

/** Words whose explainer is being written: the chat and the row they stand in, the sentence that holds them as the row
 * draws it with which of its places of them they are, and the Explainers check (its id, name and palette place), which
 * their tint and their card take. */
export interface Asking {
  /** what its tint and its card go by until the explainer is written */
  id: string
  chat: string
  row: number
  words: string
  /** the sentence that holds them; the words alone when the page found no place for them */
  quote: string
  /** which of the sentence's places of the words they are, from 0 (answerComments.ts wordsAt) */
  nth: number
  check: string
  check_name: string
  color: number
  /** the explainer's comment, written while its card stands open: that card shows it */
  written?: string
  /** why it was not written, which its card says */
  failed?: string
}

let asking: readonly Asking[] = []
const askingSubs = new Set<() => void>()
const setAsking = (next: readonly Asking[]) => {
  asking = next
  askingSubs.forEach((f) => f())
}
const changeAsking = (id: string, change: Partial<Asking>) => setAsking(asking.map((a) => (a.id === id ? { ...a, ...change } : a)))
const dropAsking = (id: string) => setAsking(asking.filter((a) => a.id !== id))
let askingSeq = 0

// the cards of words being explained that stand open now (cardShown)
const openCards = new Set<string>()

/** The chat opened comment `id`'s card. For the card of words being explained, it notes that the card stands open, and
 * gives what notes that it closed: its words then keep their tint only while the explainer is written (module note). */
export function cardShown(id: string): (() => void) | undefined {
  if (!asking.some((a) => a.id === id)) return undefined
  openCards.add(id)
  return () => {
    openCards.delete(id)
    const a = asking.find((x) => x.id === id)
    if (a && (a.written || a.failed)) dropAsking(id)
  }
}

/** The words whose explainer is being written, which the chat tints (chat/Rows). */
export function useAsking(): readonly Asking[] {
  return useSyncExternalStore(
    (f) => {
      askingSubs.add(f)
      return () => void askingSubs.delete(f)
    },
    () => asking,
  )
}

/** The signs the page draws after a citation, which a selection may hold: × after a failed one, ↻ after a stale one. */
const SIGNS = '×↻'
/** What a row draws that its text does not hold as words: a chip (its name or value), the sign after a citation and its
 * spinner (rankIn). */
const NOT_WORDS = '.refchip, .mark-glyph, .mark-spin'
/** The explainers' check (backend explain.py CHECK), and the heads-ups', whose words an explainer never shares. */
const EXPLAINERS = 'explainers'
const HEADS = 'heads-up'
/** The toolbar's distance (px) from the selection, and from the window's edges. */
const GAP = 6
const MARGIN = 8

/** A selection the toolbar takes: words of one text row of an answer that is done, with the row's element and the
 * range, and which of the row's places of the words it lies on (rankIn; none when the page cannot tell). */
export interface Picked {
  el: HTMLElement
  row: PickedRow
  words: string
  range: Range
  nth?: number
}

/** Which of the places of `words` in the row `el` draws the selection `range` lies on (asked.mjs rankOf): the row's
 * words as drawn, without NOT_WORDS, and where the selection starts in them. */
function rankIn(el: HTMLElement, range: Range, words: string): number | undefined {
  const before = document.createRange()
  before.setStart(el, 0)
  before.setEnd(range.startContainer, range.startOffset)
  let drawn = ''
  let at = 0
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.parentElement?.closest(NOT_WORDS)) continue
    const text = n.nodeValue ?? ''
    if (n === range.startContainer) at = drawn.length + range.startOffset
    else if (before.intersectsNode(n)) at = drawn.length + text.length
    drawn += text
  }
  return rankOf(drawn, words, at, SIGNS)
}

/** The selection as the toolbar takes it (module note): null for none, for one that crosses rows or leaves the
 * answers, and while the ⌘ pointer points or its box is open, which take the selection for themselves. */
export function pickedNow(): Picked | null {
  const sel = document.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  if (document.body.hasAttribute('data-cmd') || document.querySelector('.pointer-box')) return null
  const range = sel.getRangeAt(0)
  const rowOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('.chat-text[data-anchor]') ?? null
  const el = rowOf(range.startContainer)
  if (!el || rowOf(range.endContainer) !== el) return null
  const row = rows.get(el.dataset.anchor ?? '')
  if (!row || row.streaming || !row.turn) return null
  const { words } = pickedWords(sel.toString())
  return words ? { el, row, words, range, nth: rankIn(el, range, words) } : null
}

/** An error's words without the status the server's answer opens with (lib/api). */
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d{3}\s+/, '')
const toast = (text: string) => bus.emit('toast', { text, kind: 'error' })

/** The citations of a row the toolbar reads: Claude's by their order in its text, then those asked about with Cite. */
const itemsOf = (row: PickedRow) => [...(row.checks ?? []), ...(row.asked ?? [])]

/** Cite: the words cited where they were selected (module note). */
async function cite(ws: string, p: Picked): Promise<void> {
  const turn = p.row.turn!
  const got = citeAt(p.row.text, itemsOf(p.row), p.words, SIGNS, p.nth)
  // a citation of Claude's that no check holds yet: its check starts as its turn ends
  if (got.why === 'unchecked') return toast('Could not cite: those words are in a citation still being checked; try again in a moment.')
  if (got.why) return toast(`Could not cite: ${got.why === 'code' ? CITE_WHY.code : CITE_WHY.missing(p.words)}`)
  if (got.n != null) return wantMark(turn, got.n)
  try {
    const made = await marksApi.cite(ws, { chat: p.row.chat, turn, row: p.row.index, start: got.start!, end: got.end!, words: got.words!, sentence: got.sentence! })
    wantMark(made.turn, made.n)
  } catch (e) {
    toast(`Could not cite: ${why(e)}`)
  }
}

/** Where Explain's tint stands while the explainer is written: the sentence that holds the words' place as the row
 * draws it (plugin/marks/message.js sentenceSpan), and which of its places of them they are; the words alone with no
 * place. */
function tintWhileWritten(place: ReturnType<typeof pickedPlace>, words: string): Pick<Asking, 'quote' | 'nth'> {
  if (!place) return { quote: words, nth: 0 }
  const [a, b] = sentenceSpan(place.shown, place.at)
  const sentence = place.shown.slice(a, b)
  if (!wordsAt(plainQuote(sentence), words)) return { quote: words, nth: 0 }
  return { quote: sentence, nth: timesIn(plainQuote(place.shown.slice(a, place.at.start)), words) }
}

/** The comments of the tints over a text the chat draws (chat/markdown.tsx), from the innermost out, each with its
 * check; the tint of words whose explainer is being written goes by its card. */
function tintsOn(node: Node): { id: string; check: string }[] {
  const out: { id: string; check: string }[] = []
  const up = (el: Element | null | undefined) => el?.closest<HTMLElement>('mark.answer-tint[data-answer-comment], mark.answer-tint[data-answer-writing]')
  for (let t = up(node.parentElement); t; t = up(t.parentElement)) out.push({ id: t.dataset.answerComment ?? t.dataset.answerWriting ?? '', check: t.dataset.check ?? '' })
  return out
}

/** The explainer or heads-up that the selected words stand on, which Explain opens as it is, as the server answers
 * (backend explain.py _standing): an explainer whose tint holds all of the words, one being written too, else a
 * heads-up whose tint meets them; null for none. The words are the selected texts that hold more than white space and
 * quotes. */
function standingAt(p: Picked): string | null {
  const over: { id: string; check: string }[][] = []
  const walk = document.createTreeWalker(p.el, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!p.range.intersectsNode(n) || n.parentElement?.closest(NOT_WORDS)) continue
    const text = n.nodeValue ?? ''
    const part = text.slice(n === p.range.startContainer ? p.range.startOffset : 0, n === p.range.endContainer ? p.range.endOffset : text.length)
    if (/[^\s"“”'‘’`]/.test(part)) over.push(tintsOn(n))
  }
  const holds = (over[0] ?? []).find((t) => t.check === EXPLAINERS && over.every((o) => o.some((x) => x.id === t.id)))
  return holds?.id ?? over.flat().find((t) => t.check === HEADS)?.id ?? null
}

/** Explain: the words explained where they were selected (module note), tinted in the Explainers check's color while
 * their explainer is written, its card open beside them: the server takes their row and their place in its text, and
 * the tint stands on them in their sentence as the row draws it. */
async function explain(ws: string, p: Picked, check: Pick<Check, 'id' | 'name' | 'colour'>): Promise<void> {
  const standing = standingAt(p)
  if (standing) return wantComment(standing)
  const place = pickedPlace(p.row.text, itemsOf(p.row), p.words, SIGNS, p.nth)
  const mine: Asking = { id: `writing:${++askingSeq}`, chat: p.row.chat, row: p.row.index, words: p.words, ...tintWhileWritten(place, p.words), check: check.id, check_name: check.name, color: check.colour }
  setAsking([...asking, mine])
  wantComment(mine.id)
  try {
    const at = place?.written ? { start: place.written.start, end: place.written.end } : {}
    const got = await api.explain(ws, { chat: p.row.chat, turn: p.row.turn!, words: p.words, row: p.row.index, ...at })
    if (openCards.has(mine.id)) changeAsking(mine.id, { written: got.id })
    else dropAsking(mine.id)
  } catch (e) {
    const failed = `Could not explain: ${why(e)}`
    if (openCards.has(mine.id)) return changeAsking(mine.id, { failed })
    dropAsking(mine.id)
    toast(failed)
  }
}

/** A button of the toolbar: its word, the icon of what it gives, and what it does with the words. */
interface Action {
  id: 'explain' | 'cite'
  label: string
  icon: IconName
  run: (p: Picked) => void
}

/** A line of the selection on screen, as its range's client rects give it. */
type Line = Pick<DOMRectReadOnly, 'top' | 'right' | 'bottom'>

/** Where the toolbar, `w` by `h`, stands (module note): just above the selection's first line, centered on where the
 * selection ends, the right of its last line; under that line when there is no room above; MARGIN inside the window,
 * `view` wide and high. Pure. */
export function barPlace(first: Line, last: Line, w: number, h: number, view: { width: number; height: number }): { left: number; top: number } {
  const above = first.top - GAP - h
  const top = above >= MARGIN ? above : Math.max(MARGIN, Math.min(last.bottom + GAP, view.height - MARGIN - h))
  return { left: Math.max(MARGIN, Math.min(last.right - w / 2, view.width - MARGIN - w)), top }
}

/** The toolbar at the selection, over the page (module note). */
export function SelectionBar({ ws }: { ws: string }) {
  const [picked, setPicked] = useState<Picked | null>(null)
  /** after a click with the pointer, the toolbar's size, kept where it was until the pointer moves (module note) */
  const [gone, setGone] = useState<{ width: number; height: number } | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const checks = useChecks(ws)
  const explainers = checks.list.find((c) => c.id === EXPLAINERS)
  const explainOn = !!explainers?.shown && coversOf(explainers).includes('answers')

  // the selection read again as it changes, once the mouse is up: while a drag selects, nothing shows
  useEffect(() => {
    let down = false
    let frame = 0
    const read = () => {
      frame = 0
      setPicked(down ? null : pickedNow())
    }
    const later = () => {
      if (!frame) frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(read) : window.setTimeout(read, 16)
    }
    const press = (e: MouseEvent) => {
      if (bar.current?.contains(e.target as Node)) return
      down = e.button === 0
      if (down) setPicked(null)
    }
    const release = () => {
      down = false
      later()
    }
    document.addEventListener('selectionchange', later)
    document.addEventListener('mousedown', press, true)
    document.addEventListener('mouseup', release, true)
    return () => {
      document.removeEventListener('selectionchange', later)
      document.removeEventListener('mousedown', press, true)
      document.removeEventListener('mouseup', release, true)
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [])

  const drop = () => {
    document.getSelection()?.removeAllRanges()
    setPicked(null)
    setGone(null)
  }
  // the buttons of the features that are on, in this order; each acts on the words it took, which the selection leaves
  const cites: Action = { id: 'cite', label: 'Cite', icon: 'cite', run: (p) => void cite(ws, p) }
  const explains: Action = { id: 'explain', label: 'Explain', icon: 'circle-help', run: (p) => void (explainers && explain(ws, p, explainers)) }
  const actions = explainOn ? [explains, cites] : [cites]
  // `pointer`: a click with the pointer, which counts its clicks; a key's click counts none
  const act = (a: Action, pointer: boolean) => {
    if (!picked) return
    track('ui-click', { target: picked.el.dataset.anchor ?? '', detail: { action: a.id, from: 'selection' } })
    drop()
    if (pointer && bar.current) setGone({ width: bar.current.offsetWidth, height: bar.current.offsetHeight })
    a.run(picked)
  }

  // the toolbar's place after a click with the pointer, kept until the pointer moves (a move with no movement, which
  // some browsers send while the pointer stays still, is not one), presses or turns the wheel
  useEffect(() => {
    if (!gone) return
    const end = () => setGone(null)
    const move = (e: PointerEvent) => {
      if (e.movementX || e.movementY) end()
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerdown', end, true)
    window.addEventListener('wheel', end, { capture: true, passive: true })
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerdown', end, true)
      window.removeEventListener('wheel', end, true)
    }
  }, [gone])

  // Escape drops the selection, while the focus is in no text field
  useEffect(() => {
    if (!picked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || typingIn(document.activeElement)) return
      drop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked])

  // just above the words, next to where they end, else under them (barPlace); hidden while the words are scrolled
  // out of their chat
  useLayoutEffect(() => {
    const el = bar.current
    if (!el || !picked) return
    const place = () => {
      const all = Array.from(picked.range.getClientRects())
      const rects = all.some((r) => r.width > 0) ? all.filter((r) => r.width > 0) : all.filter((r) => r.height > 0)
      const box = picked.range.getBoundingClientRect()
      const [first, last] = [rects[0] ?? box, rects[rects.length - 1] ?? box]
      const list = picked.el.closest('.chat-list')?.getBoundingClientRect()
      el.style.visibility = list && (last.bottom < list.top || first.top > list.bottom) ? 'hidden' : ''
      const at = barPlace(first, last, el.offsetWidth, el.offsetHeight, { width: window.innerWidth, height: window.innerHeight })
      el.style.left = `${at.left}px`
      el.style.top = `${at.top}px`
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [picked, actions.length])

  // after a click with the pointer the same element stays, unseen and empty, where the toolbar was (module note)
  const cover = picked ? null : gone
  if (!picked && !cover) return null
  return createPortal(
    <div
      ref={bar}
      className={cover ? 'pick-bar is-gone' : 'pick-bar overlay'}
      role={cover ? undefined : 'toolbar'}
      aria-label={cover ? undefined : 'Selected words'}
      aria-hidden={cover ? true : undefined}
      data-panel="pick"
      style={{ left: MARGIN, top: 0, ...cover }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {!cover &&
        actions.map((a) => (
          <Button key={a.id} icon={a.icon} data-action={a.id} onClick={(e) => act(a, e.detail > 0)}>
            {a.label}
          </Button>
        ))}
    </div>,
    document.body,
  )
}
