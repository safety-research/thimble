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

/** The theme the palette arrays hold now, and whether thimble knows it is the one Claude Code draws in (`known`). */
const painted = { theme: 'dark' as Theme, known: true }

/** The palette arrays filled with `theme`'s colors (light for a light Claude Code theme, Dark for any other); null when
 *  the theme is not known (themeFrom), which draws Dark's palette and the backgrounds in theme keys (passageTint). */
export function setTheme(theme: Theme | null): void {
  const t = theme ?? 'dark'
  painted.theme = t
  painted.known = theme !== null
  SERIES.splice(0, SERIES.length, ...(t === 'light' ? SERIES_LIGHT : SERIES_DARK))
  LABEL_HUES.splice(0, LABEL_HUES.length, ...(t === 'light' ? LABEL_LIGHT : LABEL_DARK))
  PICKED_HUES.splice(0, PICKED_HUES.length, ...(t === 'light' ? PICKED_LIGHT : PICKED_DARK))
}

export function themeNow(): Theme {
  return painted.theme
}

/**
 * The theme Claude Code draws in, from its `theme` setting (the /config row's value), as Claude Code resolves it:
 * `light`, `light-daltonized` and `light-ansi` are light, the `dark` ones dark; a custom theme (`custom:<slug>`) is its
 * file's `base` (`customBase`), dark when it is disabled in safe mode. `auto` (match terminal) is what the terminal's
 * background is: Claude Code asks the terminal (OSC 11) and tells no plugin, so thimble reads what Claude Code falls back
 * on, COLORFGBG (`fgbg`, its last field a color 0-15: 0-6 and 8 dark, else light). Null when nothing says which (`auto`
 * with no COLORFGBG, a plugin's theme): the drawing then puts no background of its own color behind text.
 */
export function themeFrom(setting: unknown, fgbg?: string, customBase?: string): Theme | null {
  const s = String(setting ?? '').trim()
  if (!s) return 'dark'
  if (s.endsWith('(disabled in safe mode)')) return 'dark'
  if (s === 'auto') {
    const bg = Number((fgbg ?? '').split(';').at(-1) || NaN)
    if (!Number.isInteger(bg) || bg < 0 || bg > 15) return null
    return bg <= 6 || bg === 8 ? 'dark' : 'light'
  }
  if (s.startsWith('custom:')) return customBase ? (customBase.startsWith('light') ? 'light' : 'dark') : null
  return s.startsWith('light') ? 'light' : 'dark'
}

/** Label color `place` (1-12, then 13-18) in the theme's palette; a check's color is a place 1-8 of the same table. */
export function labelHex(place: number, theme: Theme = painted.theme): string {
  const labels = theme === 'light' ? LABEL_LIGHT : LABEL_DARK
  const picked = theme === 'light' ? PICKED_LIGHT : PICKED_DARK
  if (place > labels.length && place <= labels.length + picked.length) return picked[place - labels.length - 1]!
  return labels[(Math.max(1, Math.round(place)) - 1) % labels.length]!
}

/** The label color places a chart's series take after the seven of SERIES (live feedback, 10-17: twelve lines in seven
 *  colors read as "too few colors"): brown, a dark purple (a pale violet on Dark), cerulean, chestnut, red, olive and
 *  grass green, in that order, a hue the seven lack first and the one nearest a series' last. Picked by place so each
 *  theme has its own of each, every one of the fourteen at least as far from every other (8.8 in OKLab ×100, in both
 *  themes) as the seven series are from each other (9.0 on Dark). */
const MORE_SERIES = [7, 16, 10, 11, 13, 5, 9] as const

/** Series `i`'s color in a chart with a color field: the browser's seven series, then MORE_SERIES; past fourteen the
 *  colors come round again. */
export function seriesHue(i: number): string {
  const k = Math.max(0, Math.floor(i)) % (SERIES.length + MORE_SERIES.length)
  return k < SERIES.length ? SERIES[k]! : labelHex(MORE_SERIES[k - SERIES.length]!)
}

/** The flag a passage a check commented on carries in the reply's margin, in the check's color. */
export const FLAG = '⚑'

/** The background a theme's terminal is taken to have, which a tint blends toward. */
const GROUND: Record<Theme, string> = { dark: '#1e1e1e', light: '#ffffff' }

/** A passage's tint: `hex` blended toward the theme's background, `share` of it the color (0.16 as drawn, 0.3 while
 *  its comment is open in the panel): a pale wash on a light theme, a dark one on a dark theme. */
export function tintOf(hex: string, theme: Theme, share: number): string {
  const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [a, b] = [rgb(hex), rgb(GROUND[theme])]
  if (a.some(Number.isNaN)) return GROUND[theme]
  return `#${a.map((v, i) => Math.round(v * share + b[i]! * (1 - share)).toString(16).padStart(2, '0')).join('')}`
}

/** The background of a passage a check commented on: the check's color `hex` as a tint of the theme (16%, 30% while its
 *  comment is open in the panel, `lit`); while the theme is not known, a theme key Claude Code resolves for the theme
 *  it draws in (COLORS.wash, COLORS.selected while lit), since a tint for the wrong theme hides the text on it. */
export function passageTint(hex: string, lit: boolean): string {
  if (!painted.known) return lit ? COLORS.selected : COLORS.wash
  return tintOf(hex, painted.theme, lit ? 0.3 : 0.16)
}

/** Where a citation's value stands in its place (its cited lines, a card's cited cell or row, the code that types it):
 *  Claude Code's violet (COLORS.cite: rgb(175,135,255) on dark themes, rgb(135,0,255) on light) blended toward the
 *  theme's background, so the text on it keeps its own color (v9 review: "the cited value highlighted in purple in the
 *  source text"); while the theme is not known, the selection background (COLORS.selected), a theme key. */
export function citeHighlight(theme?: Theme): string {
  if (!theme && !painted.known) return COLORS.selected
  return (theme ?? painted.theme) === 'light' ? tintOf('#8700ff', 'light', 0.18) : tintOf('#af87ff', 'dark', 0.35)
}

// What each colour means (SPEC.md, "The visual system", section 4): letters in the text colour or dim; lines in
// the rule grey; links in blue; citations in purple, a card's evidence too (an example's ● and its ↗ place); a panel's
// title and its selected row in the accent; the word "new" and a citation panel's `checked` in green; a palette hue
// only on the glyphs and marks of a region's one colour field; red only for a problem; the selection background on a
// choice in use. No other colour: no warning amber, and no green but those two.
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
  /** a link, underlined: the place after ↗, a label's name on a card; the "?" and "↳" margins */
  link: 'remember',
  /** a citation, underlined, wherever it stands (prose, a takeaway, a `[ card ]` chip, the prompt, its panel's title):
   *  Claude Code's violet (rgb(175,135,255) on dark themes, rgb(135,0,255) on light, magenta on ANSI), the theme key
   *  closest to the browser's citation purple */
  cite: 'merged',
  /** where you are: a panel's title, the selected row */
  accent: 'suggestion',
  /** the word "new" and "N new" */
  fresh: 'success',
  /** a citation's state word `checked` in its panel's bar (MATT-NOTES "Mockup feedback", citation panel C) */
  checked: 'success',
  /** the background of a tip beside what is under the pointer (a view's region) */
  tip: 'userMessageBackground',
  /** a passage a check commented on, while the theme is not known (passageTint) */
  wash: 'userMessageBackground',
  /** the background of the analyst's question in a side thread, as Claude Code draws a prompt in its chat */
  prompt: 'userMessageBackground',
  /** the rules above and below an entry box (entry.tsx), as Claude Code draws its prompt box's border */
  entry: 'promptBorder',
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
