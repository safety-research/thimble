// palette.js: what each tone looks like, on a light page and on a dark terminal. Both renderers read it, so a tone
// means the same color in the terminal and the browser.
//
// A tone names a meaning, not a color: ink (the text), dim (secondary), rule (lines: borders, axes, tracks), accent
// (the one thing to look at), good, bad, warn, unseen (data that is not in hand, drawn hatched), and c1..c6 for
// categories. Programs use only tone names; colors live here.

export const LIGHT = {
  paper: '#ffffff', ink: '#1d1b18', dim: '#8a847a', rule: '#d8d4cb', accent: '#2a78c4', good: '#3f8a3e', bad: '#c94f4a',
  warn: '#b7791f', unseen: '#b9b2a6', c1: '#1f8a84', c2: '#7b5bb6', c3: '#a8875a', c4: '#5b6b82', c5: '#c25c8a', c6: '#7c8a2e',
  select: '#e6eefb', hover: '#f3f1ec',
}
export const DARK = {
  paper: '#1e1e1e', ink: '#e6e3dd', dim: '#8f8a82', rule: '#4b4945', accent: '#5aa2e6', good: '#6bbf5e', bad: '#e5736c',
  warn: '#e0a43a', unseen: '#6e6a63', c1: '#3cc2b9', c2: '#a98be0', c3: '#cfae7e', c4: '#8fa1bd', c5: '#e384b2', c6: '#b2c24f',
  select: '#26384f', hover: '#2a2a2a',
}

/** The color of `tone` in `theme` ('light' | 'dark'); unknown tones read as ink. */
export function hex(tone, theme = 'dark') {
  const p = theme === 'light' ? LIGHT : DARK
  return p[tone] || p.ink
}

/**
 * The terminal's color for a tone in a `Text` element: Claude Code's own theme keys where one fits, so text follows
 * the theme a person picked (ink is the default text color, so it is left out); the palette's hex elsewhere.
 */
export function termColor(tone, theme = 'dark') {
  if (tone === 'ink' || !tone) return undefined
  if (tone === 'dim' || tone === 'unseen') return 'inactive'
  if (tone === 'rule') return 'subtle'
  return hex(tone, theme)
}
