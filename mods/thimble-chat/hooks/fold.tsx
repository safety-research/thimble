// A prompt thimble-chat sent main (a fix request, a verification request), drawn as one dim line that a click unfolds
// to the whole message: a Client surface module, drawn on Claude Code's drawing thread (no `$`). The engine counts such
// a row as expanded whenever its body fits under the speaker label, so `isExpanded` cannot decide the fold here.
import type { ClientModule, RenderElement } from 'claude-code'

import { COLORS, cut } from './draw'

type Props = { head: string; items: string[]; body: string; cols: number }
type S = { open: boolean; hover: boolean }

const Fold: ClientModule<Props, S> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = surface.columns || props.cols || 80
  const st = surface.state ?? { open: false, hover: false }
  surface.onPointer(ev => {
    const cur = surface.state ?? { open: false, hover: false }
    if (ev.type === 'leave') {
      if (cur.hover) surface.setState({ ...cur, hover: false })
      return
    }
    const onHead = ev.y === 0
    if (ev.type === 'down' && onHead) {
      surface.setState({ open: !cur.open, hover: true })
      return
    }
    if (onHead !== cur.hover) surface.setState({ ...cur, hover: onHead })
  })
  if (surface.state === undefined) surface.setState(st)
  const toggle = st.open ? 'hide the message' : 'show the message'
  const rows: RenderElement[] = [
    Text({
      wrap: 'truncate-end',
      children: [
        Text({ dimColor: true, children: `› ${cut(props.head, Math.max(20, cols - toggle.length - 6))} · ` }),
        Text({ color: st.hover ? COLORS.accent : COLORS.dim, underline: true, children: toggle }),
      ],
    }),
  ]
  for (const item of props.items) rows.push(Text({ color: COLORS.chip.differs, wrap: 'truncate-end', children: `  ${item}` }))
  if (st.open) rows.push(Box({ paddingLeft: 2, children: Text({ dimColor: true, wrap: 'wrap', children: props.body }) }))
  return Box({ flexDirection: 'column', children: rows })
}

export default Fold
