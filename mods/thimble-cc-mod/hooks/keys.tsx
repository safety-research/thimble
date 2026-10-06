// A slide deck's page row: a Client (no `$`) that draws "‹  3 of 9  ›" and turns ← and → (once a click or the mod's
// focus has given it the keys) and clicks on its arrows into page turns, which the hooks module applies
// (register.tsx's ui.message, reports.tsx reportNav).
import type { ClientModule } from 'claude-code'

import { send } from './gestures'

type Props = { label: string; cols: number }

const Keys: ClientModule<Props, Record<string, never>> = (props, surface) => {
  const { Box, Text } = surface.elements
  // flush left (nothing is centred): ‹, the page, › each a gutter apart; a click on ‹ turns back, on › forward
  const label = props.label.replace(' / ', ' of ')
  const next0 = 1 + 2 + label.length + 2
  const turn = (op: 'prev' | 'next') => send(surface, { type: 'report-nav', op })
  surface.onKey(ev => {
    if (ev.key === 'left' || ev.key === 'pageup') turn('prev')
    else if (ev.key === 'right' || ev.key === 'pagedown' || ev.key === ' ' || ev.key === 'space') turn('next')
  })
  surface.onPointer(ev => {
    if (ev.type !== 'down' || ev.button !== 'left') return
    if (ev.x < 2) turn('prev')
    else if (ev.x >= next0 - 1 && ev.x <= next0 + 1) turn('next')
  })
  return Box({ flexDirection: 'row', children: [Text({ children: '‹  ' }), Text({ dimColor: true, children: label }), Text({ children: '  ›' })] })
}

export default Keys
