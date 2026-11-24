// The keys at the selection: words selected with the mouse in one of Claude's answers, in main's chat or a side
// thread's, take two of the terminal's keys that act on selected words (plugin/marks/cite.ts, plugin/explain/seam.ts).
// They show at the selection as the terminal's bar shows them, in its order, `c cite · e explain`, each key and its word
// in the color of what it gives: the citations' purple, the Explainers check's color. A key acts while such a selection
// stands and the focus is in no text field, and a click on it acts too; Escape, or a click elsewhere, drops the
// selection. e shows only while the chat shows the Explainers check's comments (on, with Chat in its Show in), as the
// terminal leaves e out while Explainers is off; the workbench has no switch for c. Asking about words stays with the ⌘
// pointer: a ⌘-click or a ⌘-drag over them opens its ask box (pointer/CmdPointer.tsx). The words a key takes are the
// terminal's (plugin/marks/asked.mjs pickedWords).
//
//   c   the words become a citation of their answer (backend marks.cite), placed with the terminal's own code
//       (asked.mjs citeAt), or the citation they stand in opens; the citation's label opens on it at once
//       (marks/marks.ts wantMark), checking, then verified or failed with its evidence, as any citation's
//   e   the words take an explainer (backend explain.py), tinted in the Explainers color while it is written (useAsking,
//       which the chat draws), and its comment opens on them once written (answerComments.ts wantComment); words an
//       explainer or a heads-up stands on open that one
//
// c and e act on the words where they were selected: words may stand more than once in a row, so the keys take which
// of their places the selection lies on (rankIn, asked.mjs rankOf). c places its citation there, and e sends the place
// in the row's text, where the server keeps the explainer, on the sentence that holds it.
//
// Each text row a chat draws notes itself here (noteRow) by its anchor, `chat:<id>#<index>`, with its turn, its text
// and its marks, which the keys read; a row of an answer still being written takes no key.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CITE_WHY, citeAt, pickedPlace, pickedWords, rankOf } from '../../../../plugin/marks/asked.mjs'
import { sentenceSpan } from '../../../../plugin/marks/message.js'
import { api, marksApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { MarkItem } from '../marks/marks'
import { wantMark } from '../marks/marks'
import { useChecks } from '../report/Checks'
import { checkColour, coversOf } from '../report/checkComments'
import { typingIn } from '../shell/undo'
import { plainQuote, timesIn, wantComment, wordsAt } from './answerComments'

/** A text row as a chat draws it (chat/Rows), which the keys read. */
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
 * draws it with which of its places of them they are, and the Explainers check's color. */
export interface Asking {
  chat: string
  row: number
  words: string
  /** the sentence that holds them; the words alone when the page found no place for them */
  quote: string
  /** which of the sentence's places of the words they are, from 0 (answerComments.ts wordsAt) */
  nth: number
  colour: string
}

let asking: readonly Asking[] = []
const askingSubs = new Set<() => void>()
const setAsking = (next: readonly Asking[]) => {
  asking = next
  askingSubs.forEach((f) => f())
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
/** The explainers' check (backend explain.py CHECK). */
const EXPLAINERS = 'explainers'
/** The strip's distance (px) from the selection, and from the window's edges. */
const GAP = 6
const MARGIN = 8

/** A selection the keys take: words of one text row of an answer that is done, with the row's element and the range,
 * and which of the row's places of the words it lies on (rankIn; none when the page cannot tell). */
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

/** The selection as the keys take it (module note): null for none, for one that crosses rows or leaves the answers,
 * and while the ⌘ pointer points or its box is open, which take the selection for themselves. */
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

/** The citations of a row the keys read: Claude's by their order in its text, then those asked about with c. */
const itemsOf = (row: PickedRow) => [...(row.checks ?? []), ...(row.asked ?? [])]

/** c: the words cited where they were selected (module note). */
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

/** Where e's tint stands while the explainer is written: the sentence that holds the words' place as the row draws it
 * (plugin/marks/message.js sentenceSpan), and which of its places of them they are; the words alone with no place. */
function tintWhileWritten(place: ReturnType<typeof pickedPlace>, words: string): Pick<Asking, 'quote' | 'nth'> {
  if (!place) return { quote: words, nth: 0 }
  const [a, b] = sentenceSpan(place.shown, place.at)
  const sentence = place.shown.slice(a, b)
  if (!wordsAt(plainQuote(sentence), words)) return { quote: words, nth: 0 }
  return { quote: sentence, nth: timesIn(plainQuote(place.shown.slice(a, place.at.start)), words) }
}

/** e: the words explained where they were selected (module note), tinted in `colour` while their explainer is written:
 * the server takes their row and their place in its text, and the tint stands on them in their sentence as the row
 * draws it. */
async function explain(ws: string, p: Picked, colour: string): Promise<void> {
  const place = pickedPlace(p.row.text, itemsOf(p.row), p.words, SIGNS, p.nth)
  const mine: Asking = { chat: p.row.chat, row: p.row.index, words: p.words, ...tintWhileWritten(place, p.words), colour }
  setAsking([...asking, mine])
  try {
    const at = place?.written ? { start: place.written.start, end: place.written.end } : {}
    const got = await api.explain(ws, { chat: p.row.chat, turn: p.row.turn!, words: p.words, row: p.row.index, ...at })
    wantComment(got.id)
  } catch (e) {
    toast(`Could not explain: ${why(e)}`)
  } finally {
    setAsking(asking.filter((a) => a !== mine))
  }
}

/** A key at the selection: its letter and word, the color of what it gives, and what it does with the words. */
interface Key {
  key: string
  word: string
  colour: string
  run: (p: Picked) => void
}

/** The keys at the selection, over the page (module note). */
export function SelectionKeys({ ws }: { ws: string }) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const strip = useRef<HTMLDivElement>(null)
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
      if (strip.current?.contains(e.target as Node)) return
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
  }
  // c and e act on the words they took, which the selection leaves
  const keys: Key[] = [
    { key: 'c', word: 'cite', colour: 'var(--cite-line)', run: (p) => void cite(ws, p) },
    ...(explainOn ? [{ key: 'e', word: 'explain', colour: checkColour(explainers), run: (p: Picked) => void explain(ws, p, checkColour(explainers)) }] : []),
  ]
  const act = (k: Key, via: 'key' | 'click') => {
    if (!picked) return
    track('ui-click', { target: `key:${k.key}`, detail: { via, chat: picked.row.chat } })
    drop()
    k.run(picked)
  }

  // the keys, while the focus is in no text field
  useEffect(() => {
    if (!picked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typingIn(document.activeElement)) return
      if (e.key === 'Escape') return drop()
      const k = keys.find((x) => x.key === e.key)
      if (!k) return
      e.preventDefault()
      act(k, 'key')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // under the selection's last line, else over its first, inside the window; hidden while the words are scrolled out of
  // their chat
  useLayoutEffect(() => {
    const el = strip.current
    if (!el || !picked) return
    const place = () => {
      const rects = Array.from(picked.range.getClientRects()).filter((r) => r.width > 0 || r.height > 0)
      const box = picked.range.getBoundingClientRect()
      const [first, last] = [rects[0] ?? box, rects[rects.length - 1] ?? box]
      const list = picked.el.closest('.chat-list')?.getBoundingClientRect()
      el.style.visibility = list && (last.bottom < list.top || first.top > list.bottom) ? 'hidden' : ''
      const below = last.bottom + GAP
      const top = below + el.offsetHeight <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, first.top - GAP - el.offsetHeight)
      el.style.left = `${Math.max(MARGIN, Math.min(last.left, window.innerWidth - el.offsetWidth - MARGIN))}px`
      el.style.top = `${top}px`
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [picked])

  if (!picked) return null
  return createPortal(
    <div ref={strip} className="pick-keys" role="toolbar" aria-label="Selected words" data-panel="pick" style={{ left: MARGIN, top: 0 }} onMouseDown={(e) => e.preventDefault()}>
      {keys.map((k, i) => (
        <Fragment key={k.key}>
          {i > 0 && <span className="pick-keys-dot" aria-hidden="true">·</span>}
          <button type="button" className="pick-key" data-key={k.key} style={{ color: k.colour }} onClick={() => act(k, 'click')}>
            <span className="pick-key-letter">{k.key}</span> {k.word}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  )
}
