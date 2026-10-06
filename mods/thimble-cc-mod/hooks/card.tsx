// A card as an interactive panel: a Client surface module, drawn on Claude Code's drawing thread (no `$`). It stands
// between a rule above and a rule below, as wide as the card, with no side borders, so its text keeps the stream's
// text axis (views/SPEC.md, "The visual system", rule 11). The chart is text (block, braille and box-drawing
// characters), so the Client can redraw it per pointer move: the mark under the pointer has its label in inverse and
// its value shows at the right of the title. Presses on a mark, a record, a node or
// the card itself go to the gestures (onPointer), which decide what a click, a double-click or a right-click does. The
// one control row is the card's params: a choice runs the card's script again with it. A card that read a label shows
// it on a line under its title, and a press there (any button) opens the label in the panel. A label card's records
// carry "agree" and "disagree", whose presses go to register.tsx as the label's verdicts. As in para.tsx, a move off
// the card, a reflow or a hover on another card clears the hovered mark.
import type { ClientModule, ClientSurface } from 'claude-code'

import { focusItem } from './anim'
import type { Focus } from './anim'
import { cardLayout, cut, labelHead, menuShade, width } from './draw'
import type { CardData, CardMeta, Item, LabelUi, Line, Seg } from './draw'
import { isMenuTarget, onPointer, send } from './gestures'
import type { Target } from './gestures'
import { COLORS, paintLine } from './paint'

/** `focus`: a mark to light while nothing is hovered, such as the step a story's beat names. */
type Props = { card: CardData; cols: number; plotRows?: number; debug?: boolean; meta?: CardMeta; pane?: boolean; menu?: Target | null; focus?: Focus }
/** `cols`: the width the hover was set at; after a reflow it is stale. `act`: the param choice, label or label card
 *  control under the pointer. On a label card, `choose`: the record whose other values show; `pending`: a verdict sent
 *  (`<ref>=<value>`) and `was`, that record as the card showed it then, so "saving…" lasts until the card changes. */
type S = { hover: number; act: string; cols: number; choose?: string; pending?: string; was?: string }

const PAD_X = 0 // no border or padding at the left: the card's text starts on the stream's axis

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
  // what the mark is called besides its value (a bar's label, a point's date), for the menu and a thread's header
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
  const { Box, Text, Button } = surface.elements
  const cols = surface.columns || props.cols || 80
  const inner = Math.max(20, cols)
  const fresh: S = { hover: -1, act: '', cols }
  const st = surface.state ?? fresh
  const stale = st.cols !== cols
  const hover = stale ? -1 : st.hover
  const card = props.card
  const meta = props.meta ?? {}

  // while a right-click's menu is open on the card its border is lit and its title shaded; on one of its marks, that
  // mark is drawn hovered and shaded
  const menuOnCard = isMenuTarget(cardTarget(card), props.menu)
  // a verdict waits until the record it was sent for changes on the card (labels.py writes the card again)
  const [pRef] = (st.pending ?? '').split('=')
  const waiting = Boolean(st.pending) && JSON.stringify((card.examples ?? []).find(x => x.ref === pRef) ?? null) === st.was
  const ui: LabelUi = { act: stale ? '' : st.act, ...(st.choose ? { choose: st.choose } : {}), ...(waiting ? { pending: st.pending! } : {}) }
  let lay = cardLayout(card, inner, hover, props.plotRows, ui)
  const menuItem = props.menu ? lay.items.findIndex(it => isMenuTarget(itemTarget(it, card), props.menu)) : -1
  const shown = hover >= 0 ? hover : menuItem >= 0 ? menuItem : props.focus ? focusItem(card, lay.items, props.focus) : -1
  if (shown !== hover) lay = cardLayout(card, inner, shown, props.plotRows, ui)
  const prow = paramRow(card, stale ? '' : st.act)
  const head = labelHead(card, inner, !stale && st.act.startsWith('label:') ? st.act.slice(6) : '')
  const top = 2 + head.lines.length + (prow ? 1 : 0) // border, title, labels, params
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
    const cx = ev.x - PAD_X
    const prowY = 2 + head.lines.length
    const hot = prow && ev.y === prowY ? prow.hots.find(h => cx >= h.x0 && cx < h.x1) : undefined
    // a label line: the whole line names its label
    const slug = ev.y >= 2 && ev.y < 2 + head.lines.length && cx >= 0 && cx < inner ? head.slugs[ev.y - 2] : undefined
    const ctl = lay.hots?.find(h => h.line === ev.y - top && cx >= h.x0 && cx < h.x1 && h.key)
    const i = hot || slug || ctl ? -1 : lay.hit(cx, ev.y - top)
    const act = hot ? `${hot.param}=${hot.value}` : slug ? `label:${slug}` : ctl ? ctl.key : ''
    const plain = !ev.shift && !ev.ctrl && !ev.alt
    // the title is a Button (its press opens the card's thread, as the person's own click): a left click there is its
    if (ev.y === (props.pane ? 0 : 1) && (ev.button ?? 'left') === 'left' && (ev.type === 'down' || ev.type === 'up')) return
    if (ev.type === 'down' || ev.type === 'up') {
      if (slug) {
        if (ev.type === 'down') send(surface, { type: 'label-open', slug })
        return
      }
      if (ctl && plain && (ev.button ?? 'left') === 'left') {
        if (ev.type !== 'down') return
        const a = ctl.act
        if (a.op === 'verdict') {
          send(surface, { type: 'label-verdict', card: card.id, slug: a.slug, ref: a.ref, value: a.value })
          surface.setState({ ...cur, cols, act: '', choose: '', pending: `${a.ref}=${a.value}`, was: JSON.stringify((card.examples ?? []).find(x => x.ref === a.ref) ?? null) })
        } else surface.setState({ ...cur, cols, act: '', choose: a.op === 'choose' ? a.ref : '' })
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
  if (props.pane) {
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

  // the title, and at its right the value under the pointer, or what the mod is doing to the card
  const item = shown >= 0 ? lay.items[shown] : undefined
  const right: Seg | null = item
    ? { s: cut(item.value ? `${item.label}  ${item.value}` : item.label, Math.max(12, Math.floor(inner * 0.6))) }
    : meta.busy
      ? { s: cut(meta.busy, 40), fg: COLORS.dim }
      : meta.error
        ? { s: cut(meta.error, Math.max(12, Math.floor(inner * 0.6))), fg: COLORS.problem }
        : null
  const rw = right ? width(right.s) + 2 : 0
  const title = cut(card.question, Math.max(8, inner - rw))
  // the title: a plain Button (the pointer inverts it), whose press register.tsx answers (ui.press) with a side thread
  // about the card; at its right the value under the pointer, against the card's right edge
  const tail: Line = right ? [{ s: ' '.repeat(Math.max(2, inner - width(title) - width(right.s))) }, right] : []
  const titleButton = Button({ key: `card-title:${card.id}`, label: title, plain: true, onPress: () => undefined })
  const rule = paintLine(Text, [{ s: '─'.repeat(cols), fg: COLORS.rule }])
  const titleRow = Box({ flexDirection: 'row', ...(menuOnCard ? { backgroundColor: COLORS.selected } : {}), children: [titleButton, paintLine(Text, tail)] })
  // in a stream the card stands between rules; in the card pane its title is the panel's title row, the rule under it
  // the header's (views/SPEC.md, "A panel's header")
  const rows = props.pane ? [titleRow, rule] : [rule, titleRow]
  rows.push(...head.lines.map(l => paintLine(Text, l)))
  if (prow) rows.push(paintLine(Text, prow.line))
  rows.push(...(menuItem >= 0 && shown === menuItem ? menuShade(lay, menuItem) : lay.lines).map(l => paintLine(Text, l)))
  rows.push(rule)
  return Box({ flexDirection: 'column', width: cols, children: rows })
}

export default Card
