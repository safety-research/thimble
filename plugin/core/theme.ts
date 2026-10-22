// theme.ts: Claude Code's theme as thimble's colors read it, 'dark' or 'light'. Most of thimble draws in Claude Code's
// theme keys (`merged`, `planMode`, `claude`), which follow the theme by themselves; what draws in its own colors (the
// cards' palette, the explainers' tint inside a citation) asks this module which set to use.
//
//   themeOf(value)   Claude Code's `theme` setting as a set: its light themes the light one, every other the dark one
//                    (`auto` too: Claude Code does not say what the terminal matched)
//   themeNow($)      the set now, from the `theme` row of /config, read again when the last read is a second old
//   CITE_TINT        the cited words' soft tint, and CODE_INK a line of code's color, per set (the citations' card,
//                    the evidence pane, the Claims pane)
//
// No hook tells a plugin that the person picked another theme (/theme and /config write it themselves), so the drawing
// hooks ask: the screen draws again when the theme changes, and the first drawing after it reads the new one. A card
// whose drawing was made for the other theme then asks for a new one, as at a new width (cards/draw.ts frame).
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
export type Theme = 'dark' | 'light'

const FRESH_MS = 1000

let current: Theme = 'dark'
let readAt = -Infinity

/** The cited words' tint, per theme: a soft purple behind them that reads on a dark and a light background. */
export const CITE_TINT: Record<Theme, string> = { dark: '#3d3560', light: '#ebe4fd' }
/** The color of a line of code, per theme: Claude Code's theme has no key for code, so a calm blue. */
export const CODE_INK: Record<Theme, string> = { dark: '#9cdcfe', light: '#2b5fa8' }

export const themeOf = (value: unknown): Theme => (String(value ?? 'dark').startsWith('light') ? 'light' : 'dark')

export async function themeNow($: Engine): Promise<Theme> {
  let now = 0
  try { now = await $.clock.now() } catch { /* read every time */ }
  if (now && now - readAt < FRESH_MS) return current
  readAt = now
  try {
    const next = themeOf((await $.config.list()).find(r => r.key === 'theme')?.value)
    if (next !== current) {
      current = next
      // what was drawn in the other set draws again (a drawing hook asks this; the screen draws after it)
      $.clock.after(0, () => { try { $.ui.invalidate('ui.render') } catch { /* a session with no screen */ } })
    }
  } catch {
    // the set as last read
  }
  return current
}

/** For tests: the dark set, read again at the next ask. */
export function resetTheme(): void {
  current = 'dark'
  readAt = -Infinity
}
