// A paragraph (or a table) whose citations are chips: a Client surface module, drawn on Claude Code's drawing thread (no `$`).
// It wraps the paragraph to its region, colours each chip by its citation's status, shows the ref over a hovered chip,
// and posts a click to the hooks module (register.tsx, `ui.message`): a left click opens the citation's panel, a right
// click (or a modified one) puts the citation into the prompt.
import type { ClientModule, RenderElement } from 'claude-code'

import { blockLayout, lineWidth, width } from './draw'
import type { ChipView } from './draw'
import type { Run, TableRuns } from './lib'
import { paintLine } from './paint'

type Props = {
  cols: number
  block: { prefix: string; heading: number; quote: boolean; runs: Run[]; table?: TableRuns }
  chips: ChipView[]
  ids: string[]
  debug?: boolean
}
type S = { hover: number }

const Para: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = surface.columns || props.cols || 80
  const st = surface.state ?? { hover: -1 }
  const lay = blockLayout(props.block, props.chips, cols, st.hover)

  // set on every call, so the listener reads this call's props
  surface.onPointer(ev => {
    const cur = surface.state ?? { hover: -1 }
    if (ev.type === 'leave') {
      if (cur.hover !== -1) surface.setState({ hover: -1 })
      return
    }
    const k = lay.spans.find(s => s.line === ev.y && ev.x >= s.x0 && ev.x < s.x1)?.chip ?? -1
    if (ev.type === 'down') {
      const secondary = ev.button === 'right' || Boolean(ev.shift || ev.alt || ev.ctrl)
      // one post per frame reaches the hooks module, so the pointer event rides along for the debug log
      if (k >= 0) surface.post({ type: secondary ? 'cite' : 'open', id: props.ids[k] ?? '', ev: props.debug ? ev : null })
      else if (props.debug) surface.post({ type: 'pointer', where: 'chip', ev })
    }
    if (k !== cur.hover) {
      surface.setState({ hover: k })
      // the band shows the hovered chip's ref and status, whatever room the paragraph has for a tip
      if (ev.type === 'move') surface.post({ type: 'hover', id: k >= 0 ? (props.ids[k] ?? '') : '' })
    }
  })
  if (surface.state === undefined) surface.setState({ hover: -1 })

  const rows: RenderElement[] = lay.lines.map(l => paintLine(Text, l))
  const span = st.hover >= 0 ? lay.spans.find(s => s.chip === st.hover) : undefined
  const tip = st.hover >= 0 ? props.chips[st.hover]?.tip : undefined
  // a tip over the line above the chip, or below it on a first line, or on a one-line paragraph after its text (an
  // absolute Box is clipped to the region, which is one row tall then)
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
    if (text) {
      rows.push(
        Box({
          position: 'absolute',
          top,
          left,
          children: Text({ backgroundColor: '#1f2428', color: '#e6edf3', children: ` ${text} ` }),
        }),
      )
    }
  }
  return Box({ flexDirection: 'column', children: rows })
}

export default Para
