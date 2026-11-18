// The keys at the selection: words selected with the mouse in one of Claude's answers, in main's chat or a side
// thread's, take the terminal's three keys that act on selected words (plugin/marks/cite.ts, plugin/explain/seam.ts,
// plugin/threads/seam.ts). They show at the selection as the terminal's bar shows them, in its order, `c cite · e
// explain · a ask`, each key and its word in the color of what it gives: the citations' purple, the Explainers check's
// color, the accent of the ask box. A key acts while such a selection stands and the focus is in no text field, and a
// click on it acts too; Escape, or a click elsewhere, drops the selection. e shows only while the chat shows the
// Explainers check's comments (on, with Chat in its Show in), as the terminal leaves e out while Explainers is off; the
// workbench has no switch for c or a. The words a key takes are the terminal's (plugin/marks/asked.mjs pickedWords).
//
//   c   the words become a citation of their answer (backend marks.cite), placed with the terminal's own code
//       (asked.mjs citeAt), or the citation they stand in opens; the citation's label opens on it at once
//       (marks/marks.ts wantMark), checking, then verified or failed with its evidence, as any citation's
//   e   the words take an explainer (backend explain.py), tinted in the Explainers color while it is written (useAsking,
//       which the chat draws), and its comment opens on them once written (answerComments.ts wantComment); words an
//       explainer or a heads-up stands on open that one
//   a   the ⌘ pointer's ask box opens on the words, as a ⌘-drag over them opens it (pointer/CmdPointer.tsx, bus
//       askSelection), and Enter there starts the side thread
//
// Each text row a chat draws notes itself here (noteRow) by its anchor, `chat:<id>#<index>`, with its turn, its text
// and its marks, which the keys read; a row of an answer still being written takes no key.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CITE_WHY, citeAt, pickedWords } from '../../../../plugin/marks/asked.mjs'
import { api, marksApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { MarkItem } from '../marks/marks'
import { wantMark } from '../marks/marks'
import { useChecks } from '../report/Checks'
import { checkColour, coversOf } from '../report/checkComments'
import { typingIn } from '../shell/undo'
import { wantComment } from './answerComments'

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

/** Words whose explainer is being written: the chat and the row they stand in, and the Explainers check's color. */
export interface Asking {
  chat: string
  row: number
  words: string
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
/** The explainers' check (backend explain.py CHECK). */
const EXPLAINERS = 'explainers'
/** The strip's distance (px) from the selection, and from the window's edges. */
const GAP = 6
const MARGIN = 8

/** A selection the keys take: words of one text row of an answer that is done, with the row's element and the range. */
export interface Picked {
  el: HTMLElement
  row: PickedRow
  words: string
  range: Range
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
  return words ? { el, row, words, range } : null
}

/** An error's words without the status the server's answer opens with (lib/api). */
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d{3}\s+/, '')
const toast = (text: string) => bus.emit('toast', { text, kind: 'error' })

/** c: the words cited (module note). */
async function cite(ws: string, p: Picked): Promise<void> {
  const turn = p.row.turn!
  const got = citeAt(p.row.text, [...(p.row.checks ?? []), ...(p.row.asked ?? [])], p.words, SIGNS)
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

/** e: the words explained (module note), tinted in `colour` while their explainer is written. */
async function explain(ws: string, p: Picked, colour: string): Promise<void> {
  const mine: Asking = { chat: p.row.chat, row: p.row.index, words: p.words, colour }
  setAsking([...asking, mine])
  try {
    const got = await api.explain(ws, { chat: p.row.chat, turn: p.row.turn!, words: p.words })
    wantComment(got.id)
  } catch (e) {
    toast(`Could not explain: ${why(e)}`)
  } finally {
    setAsking(asking.filter((a) => a !== mine))
  }
}

/** A key at the selection: its letter and word, the color of what it gives, and what it does with the words; `keep`:
 * the selection stays for what it opens. */
interface Key {
  key: string
  word: string
  colour: string
  run: (p: Picked) => void
  keep?: boolean
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
  // c and e act on the words they took, which the selection leaves; a leaves the selection to the ⌘ pointer, whose box
  // takes it
  const keys: Key[] = [
    { key: 'c', word: 'cite', colour: 'var(--cite-line)', run: (p) => void cite(ws, p) },
    ...(explainOn ? [{ key: 'e', word: 'explain', colour: checkColour(explainers), run: (p: Picked) => void explain(ws, p, checkColour(explainers)) }] : []),
    { key: 'a', word: 'ask', colour: 'var(--accent-ink)', run: () => bus.emit('askSelection', {}), keep: true },
  ]
  const act = (k: Key, via: 'key' | 'click') => {
    if (!picked) return
    track('ui-click', { target: `key:${k.key}`, detail: { via, chat: picked.row.chat } })
    if (k.keep) setPicked(null)
    else drop()
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
