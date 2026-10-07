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

// thimble's workbench palette (frontend/src/styles/tokens.css --viz-*, --label-*: Okabe–Ito with a violet), its red
// left out for problems, each hue's lightness moved so it keeps 3:1 on white, the light panel, black and the dark panel
export const SERIES = ['#1d7fc0', '#b77300', '#00946a', '#b96895', '#8c65e8', '#927543', '#87861a'] as const

// the label colors a label's values take (the browser's --label-1..12, backend concepts.COLOUR_NAMES, in that order),
// each hue's lightness moved so it keeps 3:1 on white, the light panel, black and the dark panel; 0, a value with no
// color (a label's negative), is dim
export const LABEL_HUES = ['#0373fa', '#cc730a', '#09803e', '#1288c6', '#927802', '#00947f', '#b45e00', '#026bd3', '#299b2a', '#037aa8', '#af4d02', '#038aa1'] as const

// What each colour means (SPEC.md, "The visual system", section 4): letters in the text colour or dim; lines in
// the rule grey; links in blue; a panel's title and its selected row in the accent; the word "new" in green; a palette
// hue only on the glyphs and marks of a region's one colour field; red only for a problem; the selection background on
// a choice in use. No other colour: no warning amber, and no green but "new".
export const COLORS = {
  series: [...SERIES] as string[],
  text: 'text',
  /** secondary: read after the thing it belongs to */
  dim: 'inactive',
  /** lines only: rules, card borders, tracks, axes, tree guides, a diagram's boxes and edges */
  rule: 'subtle',
  /** the background Claude Code draws a docked pane on, the whole panel */
  panel: 'composerSidebarBackground',
  /** a choice in use among those shown: a card's parameter, a filter that is on, a cited value in its lines, text
   *  being dragged; clear on the panel in light and dark themes */
  selected: 'selectionBg',
  /** a problem, and only a problem */
  problem: 'error',
  /** a link, underlined: a citation's value, the place after ↗, a label's name on a card; the "?" and "↳" margins */
  link: 'remember',
  /** where you are: a panel's title, the selected row */
  accent: 'suggestion',
  /** the word "new" and "N new" */
  fresh: 'success',
  /** the background of the tip of the citation under the pointer */
  tip: 'userMessageBackground',
  /** inline code in the mod's own paragraphs */
  code: 'permission',
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

const same = (a: Seg, b: Seg) => a.fg === b.fg && a.bg === b.bg && !a.b === !b.b && !a.d === !b.d && !a.i === !b.i && !a.u === !b.u && !a.inv === !b.inv

/** Neighbouring segments of one style as one, so a chart drawn cell by cell stays a small tree. */
function merged(l: Line): Line {
  const out: Line = []
  for (const s of l) {
    const prev = out.at(-1)
    if (prev && same(prev, s)) out[out.length - 1] = { ...prev, s: prev.s + s.s }
    else out.push(s)
  }
  return out
}

export function paintLine(Text: TextC, l: Line): RenderElement {
  return Text({ wrap: 'truncate-end', children: l.length ? merged(l).map(s => seg(Text, s)) : ' ' })
}

export function paintLines(Box: BoxC, Text: TextC, lines: Line[]): RenderElement {
  return Box({ flexDirection: 'column', children: lines.map(l => paintLine(Text, l)) })
}
