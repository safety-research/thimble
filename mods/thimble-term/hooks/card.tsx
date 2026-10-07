// A card's insides as an interactive panel: a Client surface module, drawn on Claude Code's drawing thread (no `$`).
// Copied from thimble-cc-mod's hooks/card.tsx and changed for thimble-term's card layout (Matt, 2026-10-07): the
// border is the drawing's (reply.tsx cardBlock, a Box with a full round border in the rule grey and a cell of padding),
// so the card's takeaway can stand inside it too; in it, the card's title in bold, one blank row, then the plot or body
// directly; everything else the card shows below the plot: the readout row (the value under the pointer, plain, or
// what thimble is doing to the card), the label rows, the params row. In the card pane the question is the panel's
// title, so the region starts with the plot. The chart is text (block, braille and box-drawing characters), so the
// Client can redraw it per pointer move: the mark under the pointer has its label in inverse and its value on the
// readout row. Presses on a mark, a record, a node, the title or the card itself go to the gestures (onPointer), which
// decide what a click or a double-click does. The one control row is the card's params: a choice runs the card's script
// again with it. A card that read a label shows it on a row, its name a link, and a press on the name or its ↗ (any
// button) opens the label in the panel. As in para.tsx, a move off the card, a reflow or a hover on another card clears
// the hovered mark.
import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import { focusItem } from './anim'
import type { Focus } from './anim'
import { cardLayout, cut, labelHead, width } from './draw'
import type { CardData, CardMeta, Item, Line, Seg } from './draw'
import { onPointer, send } from './gestures'
import type { Target } from './gestures'
import { COLORS, paintLine } from './paint'

/** `focus`: a mark to light while nothing is hovered, such as the step a story's beat names. */
type Props = { card: CardData; cols: number; plotRows?: number; debug?: boolean; meta?: CardMeta; pane?: boolean; focus?: Focus }
/** `cols`: the width the hover was set at; after a reflow it is stale. `act`: the param choice or label under the
 *  pointer. */
type S = { hover: number; act: string; cols: number }

// the region starts at the card's content: its border and padding are the drawing's Box
const X0 = 0
const FRAME_X = 0

// the card whose mark or param is hovered: one at a time
let hovered: ClientSurface<S> | null = null

function unhover(surface: ClientSurface<S>): void {
  const cur = surface.state
  if (hovered === surface) hovered = null
  if (!cur || (cur.hover === -1 && !cur.act)) return
  try {
    surface.setState({ ...cur, hover: -1, act: '' })
  } catch {
    // an instance that is gone has nothing to clear
  }
}

type Hot = { x0: number; x1: number; param: string; value: string }

/** The params row: each param's name dim, its choices 2 cells apart, the one in use on the selection background, one
 *  under the pointer in inverse; and where each other choice is. */
function paramRow(card: CardData, hoverKey: string): { line: Line; hots: Hot[] } | null {
  const params = card.params ?? []
  if (!params.length) return null
  const line: Line = []
  const hots: Hot[] = []
  let x = 0
  const push = (seg: Seg, hot?: { param: string; value: string }) => {
    if (hot) hots.push({ x0: x, x1: x + width(seg.s), ...hot })
    line.push(seg)
    x += width(seg.s)
  }
  params.forEach((p, i) => {
    if (i) push({ s: '    ' })
    push({ s: `${p.name}  `, fg: COLORS.dim })
    p.choices.forEach((c, j) => {
      if (j) push({ s: '  ' })
      const value = String(c)
      if (value === String(p.value)) push({ s: String(c), bg: COLORS.selected })
      else {
        const on = hoverKey === `${p.name}=${value}`
        push({ s: String(c), ...(on ? { inv: true } : {}) }, { param: p.name, value })
      }
    })
  })
  return { line, hots }
}

function itemTarget(item: Item, card: CardData): Target {
  const t: Target = { kind: item.kind, ref: item.open, cardId: card.id }
  if (item.text) t.text = item.text
  // what the mark is called besides its value (a bar's label, a point's date), for a thread's header
  if (item.label && item.label !== item.text) t.label = item.value ? `${item.label}: ${item.value}` : item.label
  if (card.source?.script) t.script = card.source.script
  return t
}

function cardTarget(card: CardData): Target {
  const t: Target = { kind: 'card', ref: `card:${card.id}`, text: card.question, cardId: card.id }
  if (card.source?.script) t.script = card.source.script
  return t
}

const Card: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = surface.columns || props.cols || 80
  // the room inside the border and its padding
  const inner = Math.max(20, cols - FRAME_X)
  const fresh: S = { hover: -1, act: '', cols }
  const st = surface.state ?? fresh
  const stale = st.cols !== cols
  const hover = stale ? -1 : st.hover
  const card = props.card
  const meta = props.meta ?? {}
  const pane = Boolean(props.pane)

  let lay = cardLayout(card, inner, hover, props.plotRows)
  const shown = hover >= 0 ? hover : props.focus ? focusItem(card, lay.items, props.focus) : -1
  if (shown !== hover) lay = cardLayout(card, inner, shown, props.plotRows)
  const prow = paramRow(card, stale ? '' : st.act)
  const head = labelHead(card, inner, !stale && st.act.startsWith('label:') ? st.act.slice(6) : '')
  // rows of the region: the title and the blank row under it (none in the pane), the body, then the readout row (where
  // the card has marks to point at or a state to say), the label rows, the params row
  const top = pane ? 0 : 2
  const readout = lay.items.length > 0 || Boolean(meta.busy) || Boolean(meta.error)
  const headTop = top + lay.lines.length + (readout ? 1 : 0)
  const prowY = headTop + head.lines.length
  const rowsTall = surface.rows || Infinity

  const targetAt = (i: number): Target => (i >= 0 && lay.items[i] ? itemTarget(lay.items[i]!, card) : cardTarget(card))
  const select = (cur: S, i: number, act: string) => {
    if (i === cur.hover && act === cur.act && cur.cols === cols) return
    if (i < 0 && !act) return unhover(surface)
    if (hovered && hovered !== surface) unhover(hovered)
    hovered = surface
    surface.setState({ ...cur, hover: i, act, cols })
  }

  // set on every call, so the listener reads this call's layout and props
  surface.onPointer(ev => {
    const cur = surface.state ?? fresh
    const cx = ev.x - X0
    const hot = prow && ev.y === prowY ? prow.hots.find(h => cx >= h.x0 && cx < h.x1) : undefined
    // a label row: its name and its ↗ name its label
    const li = ev.y - headTop
    const lhot = li >= 0 && li < head.lines.length ? head.hots[li] : undefined
    const slug = lhot && cx >= lhot.x0 && cx < lhot.x1 ? head.slugs[li] : undefined
    const i = hot || slug ? -1 : lay.hit(cx, ev.y - top)
    const act = hot ? `${hot.param}=${hot.value}` : slug ? `label:${slug}` : ''
    const plain = !ev.shift && !ev.ctrl && !ev.alt
    if (ev.type === 'down' || ev.type === 'up') {
      if (slug) {
        if (ev.type === 'down') send(surface, { type: 'label-open', slug })
        return
      }
      if (hot && plain && (ev.button ?? 'left') === 'left') {
        if (ev.type === 'down') send(surface, { type: 'param', card: card.id, name: hot.param, value: hot.value })
        return
      }
      onPointer(targetAt(i), ev, surface)
      if (ev.type === 'down') select(cur, i, act)
      return
    }
    if (ev.type !== 'move' || ev.x < 0 || ev.y < 0 || ev.x >= cols || ev.y >= rowsTall) {
      unhover(surface)
      return
    }
    select(cur, i, act)
  })
  // Keys only in the pane: a Client with a key listener keeps the keyboard after a click, so in the chat the analyst's
  // typing would go to the card instead of the prompt.
  if (pane) {
    surface.onKey(ev => {
      const cur = surface.state ?? fresh
      const n = lay.items.length
      const step = ev.key === 'up' || ev.key === 'left' ? -1 : ev.key === 'down' || ev.key === 'right' ? 1 : 0
      if (step && n) {
        surface.setState({ ...cur, cols, hover: Math.min(n - 1, Math.max(0, (cur.hover < 0 ? (step > 0 ? -1 : n) : cur.hover) + step)) })
        return
      }
      if ((ev.key === 'return' || ev.key === 'enter') && cur.hover >= 0) {
        onPointer(targetAt(cur.hover), { button: 'left', shift: Boolean(ev.shift), ctrl: Boolean(ev.ctrl), alt: false, type: 'press' }, surface)
      }
    })
  }
  if (surface.state === undefined) surface.setState(st)

  // the readout: the value under the pointer, plain, or what the mod is doing to the card
  const item = shown >= 0 ? lay.items[shown] : undefined
  const right: Seg | null = item
    ? { s: cut(item.value ? `${item.label}  ${item.value}` : item.label, Math.max(12, Math.floor(inner * 0.6))) }
    : meta.busy
      ? { s: cut(meta.busy, 40), fg: COLORS.dim }
      : meta.error
        ? { s: cut(meta.error, Math.max(12, Math.floor(inner * 0.6))), fg: COLORS.problem }
        : null
  const rows: RenderElement[] = []
  // the title in bold, then one blank row (in the pane the question is the panel's title)
  if (!pane) rows.push(paintLine(Text, [{ s: cut(card.question, inner), b: true }]), paintLine(Text, []))
  // the plot or body, directly
  rows.push(...lay.lines.map(l => paintLine(Text, l)))
  // below it: the readout against the right edge, the label rows, the params row
  if (readout) rows.push(paintLine(Text, right ? [{ s: ' '.repeat(Math.max(0, inner - width(right.s))) }, right] : []))
  rows.push(...head.lines.map(l => paintLine(Text, l)))
  if (prow) rows.push(paintLine(Text, prow.line))
  return Box({ flexDirection: 'column', width: cols, children: rows })
}

export default Card
