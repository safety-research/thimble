// Colours, and styled lines to elements, for a Client's table or a render hook's: one Text per line, one nested Text per
// segment.
//
// A colour is a key of Claude Code's theme where one fits, so text, links, problems and highlights follow the theme the
// analyst picked (light, dark, daltonized, ANSI). Chart series have no theme key, so they are mid-luminance colours that
// keep 3:1 contrast on light and on dark backgrounds (tests/cards.test.ts checks both).
import type { BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { Line, Seg } from './draw'

type TextC = ElementConstructor<TextProps>
type BoxC = ElementConstructor<BoxProps>

export const SERIES = ['#2f7de1', '#c2710c', '#1f9d55', '#9061f9', '#0f9a8f', '#e0457b'] as const

export const COLORS = {
  series: [...SERIES] as string[],
  negative: '#e5484d',
  /** a mark under the pointer, and the readout of its value */
  accent: 'text',
  text: 'text',
  dim: 'inactive',
  /** borders, axes and rules */
  rule: 'subtle',
  /** the background of the row or column under the pointer */
  cursor: 'userMessageBackground',
  /** the background of a cited value in the lines a citation panel shows */
  highlight: 'selectionBg',
  /** the background of the open menu's target (a passage, a card's title, a mark), clear on light and dark themes */
  menu: 'selectionBg',
  code: 'permission',
  link: 'remember',
  problem: 'error',
  ok: 'success',
  warn: 'warning',
}

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
