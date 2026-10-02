// Styled lines to elements, for a Client's table or a render hook's: one Text per line, one nested Text per segment.
import type { BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { Line, Seg } from './draw'

type TextC = ElementConstructor<TextProps>
type BoxC = ElementConstructor<BoxProps>

function seg(Text: TextC, s: Seg): RenderElement {
  const p: TextProps = {}
  if (s.fg) p.color = s.fg
  if (s.bg) p.backgroundColor = s.bg
  if (s.b) p.bold = true
  if (s.d) p.dimColor = true
  if (s.i) p.italic = true
  if (s.u) p.underline = true
  if (s.inv) p.inverse = true
  return Text({ ...p, children: s.s })
}

export function paintLine(Text: TextC, l: Line): RenderElement {
  return Text({ wrap: 'truncate-end', children: l.length ? l.map(s => seg(Text, s)) : ' ' })
}

export function paintLines(Box: BoxC, Text: TextC, lines: Line[]): RenderElement {
  return Box({ flexDirection: 'column', children: lines.map(l => paintLine(Text, l)) })
}
