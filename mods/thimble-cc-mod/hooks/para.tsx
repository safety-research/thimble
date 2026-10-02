// A paragraph (or a table) of a reply that holds citations: a Client surface module, drawn on Claude Code's drawing
// thread (no `$`). It wraps the block to its region, draws each citation as a link (cite.ts), animates the spinner of
// a citation a fix round or a verification is working on, shows the hovered citation's ref beside it, and hands each
// press to gestures.tsx with what is under the pointer: a citation, a table row, or the sentence of the word there.
// While the right-click menu is open on one of its passages, that passage is shaded.
import type { ClientModule, RenderElement } from 'claude-code'

import { blockLayout, passageAt } from './cite'
import type { ChipView } from './cite'
import { lineWidth, width } from './draw'
import { menuLines, onPointer, send } from './gestures'
import type { Target } from './gestures'
import type { Run, TableRuns } from './lib'
import { paintLine } from './paint'

type Props = {
  cols: number
  block: { prefix: string; heading: number; quote: boolean; runs: Run[]; table?: TableRuns }
  chips: ChipView[]
  /** each citation's claim key (cite.ts claimKey) */
  ids: string[]
  raws: string[]
  menu?: Target | null
}
type S = { hover: number; frame: number }

const TIP_BG = '#1f2428'
const TIP_FG = '#e6edf3'

// each instance's latest props, for its spinner tick
const latest = new WeakMap<object, Props>()

const Para: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = surface.columns || props.cols || 80
  const st = surface.state ?? { hover: -1, frame: 0 }
  const lay = blockLayout(props.block, props.chips, cols, st.hover, st.frame)
  latest.set(surface, props)

  // set on every call, so the listener reads this call's layout
  surface.onPointer(ev => {
    const cur = surface.state ?? { hover: -1, frame: 0 }
    if (ev.type === 'leave') {
      if (cur.hover !== -1) surface.setState({ ...cur, hover: -1 })
      return
    }
    const k = lay.spans.find(s => s.line === ev.y && ev.x >= s.x0 && ev.x < s.x1)?.chip ?? -1
    if ((ev.type === 'down' || ev.type === 'up') && ev.button) {
      const target: Target | null = k >= 0 ? { kind: 'citation', ref: props.raws[k] ?? '', text: props.chips[k]?.label ?? '', claim: props.ids[k] ?? '' } : passageAt(lay, ev.x, ev.y)
      if (target) onPointer(target, { button: ev.button, shift: Boolean(ev.shift), ctrl: Boolean(ev.ctrl), alt: Boolean(ev.alt), type: ev.type === 'down' ? 'press' : 'release' }, surface)
    }
    if (k !== cur.hover) {
      surface.setState({ ...cur, hover: k })
      // the band shows the hovered citation's ref and status, whatever room the paragraph has for a tip
      if (ev.type === 'move') send(surface, { type: 'hover', id: k >= 0 ? (props.ids[k] ?? '') : '' })
    }
  })
  if (surface.state === undefined) {
    surface.setState(st)
    surface.every(150, () => {
      const p = latest.get(surface)
      const cur = surface.state
      if (p && cur && p.chips.some(c => c.spin)) surface.setState({ ...cur, frame: cur.frame + 1 })
    })
  }

  const rows: RenderElement[] = menuLines(lay, props.raws, props.menu).map(l => paintLine(Text, l))
  const span = st.hover >= 0 ? lay.spans.find(s => s.chip === st.hover) : undefined
  const tip = st.hover >= 0 ? props.chips[st.hover]?.tip : undefined
  // a tip over the line above the citation, or below it on a first line, or on a one-line paragraph after its text
  // (an absolute Box is clipped to the region, which is one row tall then)
  if (span && tip) {
    const room = Math.max(10, cols - 3)
    let text = width(tip) > room ? `${tip.slice(0, room - 1)}…` : tip
    let top = span.line > 0 ? span.line - 1 : lay.lines.length > 1 ? span.line + 1 : 0
    let left = Math.max(0, Math.min(span.x0, cols - width(text) - 2))
    if (lay.lines.length === 1) {
      const end = lineWidth(lay.lines[0]!) + 2
      const free = cols - end - 2
      text = free >= 12 ? (width(tip) > free ? `${tip.slice(0, free - 1)}…` : tip) : ''
      left = end
      top = 0
    }
    if (text) rows.push(Box({ position: 'absolute', top, left, children: Text({ backgroundColor: TIP_BG, color: TIP_FG, children: ` ${text} ` }) }))
  }
  return Box({ flexDirection: 'column', children: rows })
}

export default Para
