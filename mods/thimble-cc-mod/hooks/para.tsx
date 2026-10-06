// A paragraph (or a table) of a reply that holds citations: a Client surface module, drawn on Claude Code's drawing
// thread (no `$`). It wraps the block to its region, draws each citation as a link (cite.ts), ◌ beside a citation a
// fix round or a verification is working on, draws the citation under the pointer in inverse with its tip on a quiet
// box beside it, and hands each press to gestures.tsx with what is under the pointer: a citation, a table row, or the
// sentence of the word there. A right-click does what a click does.
//
// A Client holds the pointer from press to release, so the terminal cannot select its text: the paragraph selects it
// itself. A drag lights the cells it covers and, on release, the text goes to the clipboard (register.tsx copies it);
// a press and release on one cell is a click, acted on at the release. Beside a selection, an "ask about this" Button
// (its press is the person's own, so register.tsx opens a side thread about the selected text at any width).
//
// A hovered citation is lit and tipped only while the pointer moves over it: a press, a move off the region, a
// reflow of the transcript (a pane opening beside it) or a hover in another paragraph clears it, since the engine does
// not always report the pointer leaving.
import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import { blockLayout, passageAt } from './cite'
import type { ChipView } from './cite'
import { lineWidth, shade, width } from './draw'
import { onPointer, send } from './gestures'
import type { Target } from './gestures'
import type { Run, TableRuns } from './lib'
import { COLORS, paintLine } from './paint'

type Props = {
  cols: number
  block: { prefix: string; heading: number; quote: boolean; runs: Run[]; table?: TableRuns }
  chips: ChipView[]
  /** each citation's claim key (cite.ts claimKey) */
  ids: string[]
  raws: string[]
  /** no longer read: there is no menu */
  menu?: Target | null
}
/** A selection, from the cell pressed to the cell the drag is on (either order). */
type Sel = { y0: number; x0: number; y1: number; x1: number }
/** `cols`: the width the hover and the selection were set at; after a reflow they are stale. */
type S = { hover: number; frame: number; cols: number; sel?: Sel | null }

// a left press not yet released, per instance: where, on what, and whether the pointer has moved off its cell
const pressed = new WeakMap<object, { y: number; x: number; target: Target | null; moved: boolean }>()
// where each instance drew its "ask about this" Button, so a press on it is the Button's, not a new selection
const askAt = new WeakMap<object, { line: number; x0: number; x1: number }>()
const ASK = ' ask '

/** The selection's cells, line by line, in reading order. */
function selCells(sel: Sel, lines: number): { line: number; x0: number; x1: number }[] {
  const [a, b] = sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1) ? [{ y: sel.y0, x: sel.x0 }, { y: sel.y1, x: sel.x1 }] : [{ y: sel.y1, x: sel.x1 }, { y: sel.y0, x: sel.x0 }]
  const out: { line: number; x0: number; x1: number }[] = []
  for (let y = Math.max(0, a.y); y <= Math.min(lines - 1, b.y); y++) out.push({ line: y, x0: y === a.y ? Math.max(0, a.x) : 0, x1: y === b.y ? b.x + 1 : 9999 })
  return out
}

/** The text a selection covers: wrapped lines joined by a space, a table's rows by a newline. */
export function selectedText(lines: readonly { s: string }[][], sel: Sel, table: boolean): string {
  return selCells(sel, lines.length)
    .map(c => Array.from((lines[c.line] ?? []).map(g => g.s).join('')).slice(c.x0, c.x1).join('').trimEnd())
    .join(table ? '\n' : ' ')
    .trim()
}

// the instance whose citation is hovered: one at a time
let hovered: ClientSurface<S> | null = null

function unhover(surface: ClientSurface<S>): void {
  const cur = surface.state
  if (hovered === surface) hovered = null
  if (!cur || cur.hover === -1) return
  try {
    surface.setState({ ...cur, hover: -1 })
    send(surface, { type: 'hover', id: '' })
  } catch {
    // an instance that is gone has nothing to clear
  }
}

const Para: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const cols = surface.columns || props.cols || 80
  const st = surface.state ?? { hover: -1, frame: 0, cols }
  const hover = st.cols === cols ? st.hover : -1
  const lay = blockLayout(props.block, props.chips, cols, hover, st.frame)

  // set on every call, so the listener reads this call's layout
  surface.onPointer(ev => {
    const cur = surface.state ?? { hover: -1, frame: 0, cols }
    const k = lay.spans.find(s => s.line === ev.y && ev.x >= s.x0 && ev.x < s.x1)?.chip ?? -1
    const targetAt = (x: number, y: number): Target | null => {
      const c = lay.spans.find(s => s.line === y && x >= s.x0 && x < s.x1)?.chip ?? -1
      return c >= 0 ? { kind: 'citation', ref: props.raws[c] ?? '', text: props.chips[c]?.label ?? '', claim: props.ids[c] ?? '' } : passageAt(lay, x, y)
    }
    const mods = { shift: Boolean(ev.shift), ctrl: Boolean(ev.ctrl), alt: Boolean(ev.alt) }
    // a left press starts a click or a selection; the release tells which
    const ask = askAt.get(surface)
    if (ask && ev.y === ask.line && ev.x >= ask.x0 && ev.x < ask.x1 && ev.button === 'left' && (ev.type === 'down' || ev.type === 'up')) return
    if (ev.type === 'down' && ev.button === 'left') {
      unhover(surface)
      pressed.set(surface, { y: ev.y, x: ev.x, target: targetAt(ev.x, ev.y), moved: false })
      if (cur.sel) surface.setState({ ...(surface.state ?? cur), sel: null })
      return
    }
    if (ev.type === 'move' && ev.button === 'left') {
      const p = pressed.get(surface)
      if (!p) return
      if (ev.y !== p.y || ev.x !== p.x) p.moved = true
      if (p.moved) surface.setState({ ...(surface.state ?? cur), cols, hover: -1, sel: { y0: p.y, x0: p.x, y1: Math.max(0, Math.min(lay.lines.length - 1, ev.y)), x1: Math.max(0, ev.x) } })
      return
    }
    if (ev.type === 'up' && ev.button === 'left') {
      const p = pressed.get(surface)
      pressed.delete(surface)
      if (!p) return
      if (!p.moved) {
        if (p.target) onPointer(p.target, { button: 'left', ...mods, type: 'press' }, surface)
        return
      }
      const sel = surface.state?.sel
      const text = sel ? selectedText(lay.lines, sel, Boolean(props.block.table)) : ''
      // one post: a later one in the same frame would replace it; a redraw shows "ask about this" by the selection
      if (text) send(surface, { type: 'copy', text })
      surface.setState({ ...(surface.state ?? cur), sel: text ? sel : null })
      return
    }
    if ((ev.type === 'down' || ev.type === 'up') && ev.button) {
      const target = targetAt(ev.x, ev.y)
      if (target) onPointer(target, { button: ev.button, ...mods, type: ev.type === 'down' ? 'press' : 'release' }, surface)
      if (ev.type === 'down') unhover(surface)
      return
    }
    if (ev.type !== 'move' || ev.x < 0 || ev.y < 0 || ev.x >= cols || ev.y >= lay.lines.length) {
      unhover(surface)
      return
    }
    if (k === cur.hover && cur.cols === cols) return
    if (k < 0) {
      unhover(surface)
      return
    }
    if (hovered && hovered !== surface) unhover(hovered)
    hovered = surface
    surface.setState({ ...cur, hover: k, cols })
    // the band shows the hovered citation's ref and status, whatever room the paragraph has for a tip
    send(surface, { type: 'hover', id: props.ids[k] ?? '' })
  })
  if (surface.state === undefined) surface.setState(st)

  const sel = st.cols === cols ? st.sel : null
  const lit = sel ? shade(lay.lines, selCells(sel, lay.lines.length), COLORS.selected) : lay.lines
  const rows: RenderElement[] = lit.map(l => paintLine(Text, l))
  const span = hover >= 0 ? lay.spans.find(s => s.chip === hover) : undefined
  const tip = hover >= 0 ? props.chips[hover]?.tip : undefined
  // the tip on a quiet box on the row below the citation, or above it on the paragraph's last row; on a one-line
  // paragraph after its text (an absolute Box is clipped to the region, which is one row tall then)
  if (span && tip) {
    const room = Math.max(10, cols - 3)
    let text = width(tip) > room ? `${tip.slice(0, room - 1)}…` : tip
    let top = span.line < lay.lines.length - 1 ? span.line + 1 : Math.max(0, span.line - 1)
    let left = Math.max(0, Math.min(span.x0, cols - width(text) - 2))
    if (lay.lines.length === 1) {
      const end = lineWidth(lay.lines[0]!) + 2
      const free = cols - end - 2
      text = free >= 12 ? (width(tip) > free ? `${tip.slice(0, free - 1)}…` : tip) : ''
      left = end
      top = 0
    }
    if (text) rows.push(Box({ position: 'absolute', top, left, children: Text({ backgroundColor: COLORS.tip, children: ` ${text} ` }) }))
  }
  // a released selection: "ask about this" on the line below its end, or at the right of its last line
  askAt.delete(surface)
  if (sel && !pressed.get(surface)) {
    const cells = selCells(sel, lay.lines.length)
    const end = cells.at(-1)
    if (end) {
      const w = width(ASK)
      const below = end.line + 1 < lay.lines.length
      const line = below ? end.line + 1 : end.line
      const x0 = Math.max(0, below ? Math.min(Math.min(end.x1, lineWidth(lay.lines[end.line]!)) - 1, cols - w) : cols - w)
      askAt.set(surface, { line, x0, x1: x0 + w })
      rows.push(Box({ position: 'absolute', top: line, left: x0, children: Button({ key: 'sel-ask', label: ASK, plain: true, variant: 'primary', onPress: () => undefined }) }))
    }
  }
  return Box({ flexDirection: 'column', children: rows })
}

export default Para
