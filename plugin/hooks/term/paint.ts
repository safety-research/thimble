// Colours, and styled lines to elements, for a Client's table or a render hook's: one Text per line, one nested Text per
// segment.
//
// A colour is a key of Claude Code's theme where one fits, so text, links, problems and highlights follow the theme the
// analyst picked (light, dark, daltonized, ANSI). Chart series and label colors have no theme key: they are the
// browser's own (palette.gen.ts, written from frontend/src/styles/tokens.css by scripts/dev/sync_palette.py), its light
// paper's on a light Claude Code theme and its Dark paper's on any other (setTheme), so one card has the same colors in
// the terminal and the browser.
import type { BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { Line, Seg } from './draw'
import { LABEL_DARK, LABEL_LIGHT, PICKED_DARK, PICKED_LIGHT, SERIES_DARK, SERIES_LIGHT } from './palette.gen'

type TextC = ElementConstructor<TextProps>
type BoxC = ElementConstructor<BoxProps>

export type Theme = 'dark' | 'light'

// the arrays the drawing reads, which setTheme fills in place with the theme's palette: the chart series (the browser's
// --viz-1..7 of the default accent), the label colors a label's values take by place (--label-1..12, backend
// concepts.COLOUR_NAMES, in that order; 0, a value with no color, is dim), and the colors only a pick gives
// (--label-13..18: red, a dark red, violet, a dark purple, pink, a dark pink)
export const SERIES: string[] = [...SERIES_DARK]
export const LABEL_HUES: string[] = [...LABEL_DARK]
export const PICKED_HUES: string[] = [...PICKED_DARK]

/** The theme the palette arrays hold now. */
const painted = { theme: 'dark' as Theme }

/** The palette arrays filled with `theme`'s colors (light for a light Claude Code theme, Dark for any other). */
export function setTheme(theme: Theme): void {
  painted.theme = theme
  SERIES.splice(0, SERIES.length, ...(theme === 'light' ? SERIES_LIGHT : SERIES_DARK))
  LABEL_HUES.splice(0, LABEL_HUES.length, ...(theme === 'light' ? LABEL_LIGHT : LABEL_DARK))
  PICKED_HUES.splice(0, PICKED_HUES.length, ...(theme === 'light' ? PICKED_LIGHT : PICKED_DARK))
}

export function themeNow(): Theme {
  return painted.theme
}

/** Label color `place` (1-12, then 13-18) in the theme's palette; a check's color is a place 1-8 of the same table. */
export function labelHex(place: number, theme: Theme = painted.theme): string {
  const labels = theme === 'light' ? LABEL_LIGHT : LABEL_DARK
  const picked = theme === 'light' ? PICKED_LIGHT : PICKED_DARK
  if (place > labels.length && place <= labels.length + picked.length) return picked[place - labels.length - 1]!
  return labels[(Math.max(1, Math.round(place)) - 1) % labels.length]!
}

/** The flag a passage a check commented on carries in the reply's margin, in the check's color. */
export const FLAG = '⚑'

/** The background a theme's terminal is taken to have, which a tint blends toward. */
const GROUND: Record<Theme, string> = { dark: '#1e1e1e', light: '#ffffff' }

/** A passage's tint: `hex` blended toward the theme's background, `share` of it the color (0.16 as drawn, 0.3 while
 *  its comment is open in the panel). */
export function tintOf(hex: string, theme: Theme, share: number): string {
  const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [a, b] = [rgb(hex), rgb(GROUND[theme])]
  if (a.some(Number.isNaN)) return GROUND[theme]
  return `#${a.map((v, i) => Math.round(v * share + b[i]! * (1 - share)).toString(16).padStart(2, '0')).join('')}`
}

// What each colour means (SPEC.md, "The visual system", section 4): letters in the text colour or dim; lines in
// the rule grey; links in blue; a panel's title and its selected row in the accent; the word "new" in green; a palette
// hue only on the glyphs and marks of a region's one colour field; red only for a problem; the selection background on
// a choice in use. No other colour: no warning amber, and no green but "new".
export const COLORS = {
  /** the chart series: SERIES itself, so a theme change repaints them */
  series: SERIES,
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
  /** the background of the analyst's question in a side thread, as Claude Code draws a prompt in its chat */
  prompt: 'userMessageBackground',
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
