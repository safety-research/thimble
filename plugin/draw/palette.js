// palette.js: what each tone looks like, on a light page and on a dark terminal. Both renderers read it, so a tone
// means the same color in the terminal and the browser.
//
// A tone names a meaning, not a color: ink (the text), dim (secondary), rule (lines: borders, axes, tracks), accent
// (the one thing to look at), good, bad, warn, unseen (data that is not in hand, drawn hatched), c1..c6 for
// categories, and cite, explain and heads (the colors of Claude's marks: a citation, a term explained, an important
// detail). Programs use only tone names; colors live here.

export const LIGHT = {
  paper: '#ffffff', ink: '#1d1b18', dim: '#8a847a', rule: '#d8d4cb', accent: '#2a78c4', good: '#3f8a3e', bad: '#c94f4a',
  warn: '#b7791f', unseen: '#b9b2a6', c1: '#1f8a84', c2: '#7b5bb6', c3: '#a8875a', c4: '#5b6b82', c5: '#c25c8a', c6: '#7c8a2e',
  select: '#e6eefb', hover: '#f3f1ec', cite: '#8b3fd9', explain: '#1f8a85', heads: '#c2610f',
}
export const DARK = {
  paper: '#1e1e1e', ink: '#e6e3dd', dim: '#8f8a82', rule: '#4b4945', accent: '#5aa2e6', good: '#6bbf5e', bad: '#e5736c',
  warn: '#e0a43a', unseen: '#6e6a63', c1: '#3cc2b9', c2: '#a98be0', c3: '#cfae7e', c4: '#8fa1bd', c5: '#e384b2', c6: '#b2c24f',
  select: '#26384f', hover: '#2a2a2a', cite: '#b36bff', explain: '#62d2c6', heads: '#f2a24b',
}

// Claude Code's `auto` theme follows the terminal's background, which a plugin cannot read: the terminal shell says
// so (setAutoTheme) and draws as on the dark theme, whose colors read on a light background too, but for its
// neutrals. Those it draws in Claude Code's own theme colors (termColor), which Claude Code resolves for the background
// it found; and a faint tone steps back toward a middle gray rather than toward a paper, so a bar's track is pale on
// a light page and on a dark one.
let autoTheme = false
const MID = '#8c8c8c'
/** Whether the theme is Claude Code's `auto` (the terminal's own background, light or dark). */
export function setAutoTheme(on) {
  autoTheme = !!on
}

/** The color of `tone` in `theme` ('light' | 'dark'); unknown tones read as ink. A tone with `-faint` is its color a
 *  third of the way from the paper: it keeps its hue and steps back. */
export function hex(tone, theme = 'dark') {
  const p = theme === 'light' ? LIGHT : DARK
  const f = /^(.+)-faint$/.exec(String(tone || ''))
  if (f) return autoTheme ? mix(p[f[1]] || p.ink, MID, 0.45) : mix(p[f[1]] || p.ink, p.paper, 0.34)
  return p[tone] || p.ink
}

/** `a` with `share` of it kept and the rest `b`, both #rrggbb. */
export function mix(a, b, share) {
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const x = rgb(a), y = rgb(b)
  return '#' + x.map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, '0')).join('')
}

/**
 * The terminal's color for a tone in a `Text` element: Claude Code's own theme keys where one fits, so text follows
 * the theme a person picked; the palette's hex elsewhere. Ink is the terminal's own text color (left out) where the
 * text stands on the terminal's background, as in the transcript; on a background Claude Code paints from the theme
 * (`painted`: a pane), it is the theme's text color, `text`, which the theme sets to read on that background.
 */
export function termColor(tone, theme = 'dark', { painted = false } = {}) {
  if (tone === 'ink' || !tone) return painted ? 'text' : undefined
  if (tone === 'dim' || tone === 'unseen') return 'inactive'
  // (under `auto`, a neutral's faint tone, such as a bar's track, is Claude Code's own pale gray for the theme it found)
  if (autoTheme && /^(ink|dim|unseen|rule)-faint$/.test(tone)) return 'subtle'
  if (/-faint$/.test(tone)) return hex(tone, theme)
  if (tone === 'rule') return 'subtle'
  return hex(tone, theme)
}

// the tones that carry no color of their own: on the selection they read as the theme's text
const NEUTRAL = /^(ink|paper|dim|unseen|rule)(-faint)?$/

/**
 * The color of a selected cell's text, on Claude Code's selection background (`selectionBg`): the theme's text color
 * for text in a neutral tone and for text drawn on a fill of its own (a bar's label in `paper`, whose fill the
 * selection replaces), so it reads on the light and the dark theme alike; a colored tone keeps its color.
 */
export function selectedColor(tone, theme = 'dark', onFill = false) {
  if (onFill || !tone || NEUTRAL.test(tone)) return 'text'
  return termColor(tone, theme, { painted: true })
}

/** The same for a cell drawn as pixels (a Raster), on the palette's `select`: the palette's ink, or the tone's hex. */
export function selectedHex(tone, theme = 'dark', onFill = false) {
  if (onFill || !tone || NEUTRAL.test(tone)) return hex('ink', theme)
  return hex(tone, theme)
}

/**
 * The color of a selected mark (a bar's cells, a spark, a plot's dots): its own color halfway to the theme's text, so
 * it lights up (paler on the dark theme, deeper on the light one) and keeps its hue, and the parts of a stacked bar stay
 * apart. A mark is selected by its color alone: its cell's ground stays as it was, so the gap between bars on
 * neighboring rows stays (paint.js). A track (`rule`) keeps its color.
 */
export function selectedMark(tone, theme = 'dark') {
  const t = tone || 'ink'
  if (t === 'rule') return hex(t, theme)
  // (under `auto` the ink is not known: a mark deepens toward the middle gray, which reads on either background)
  return mix(hex(t, theme), autoTheme ? MID : hex('ink', theme), autoTheme ? 0.7 : 0.5)
}
