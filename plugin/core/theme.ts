// theme.ts: which of thimble's two hex sets, 'dark' or 'light', suits the theme Claude Code draws in now. Most of
// thimble draws in Claude Code's theme keys (`merged`, `planMode`, `permission`, `selectionBg`,
// `userMessageBackground`), which Claude Code resolves to the shade of the theme it draws in, auto included; prefer a
// key. Only what has no key (the cards' palette, the explainers' tints) asks this module which hex set to use.
//
//   themeOf(value, o)  Claude Code's `theme` setting as a set, as Claude Code resolves it:
//                        light, light-daltonized, light-ansi            the light set; dark, dark-* the dark set
//                        custom:<slug>                                  its base (o.base, from its file)
//                        auto ("match terminal")                        what the terminal reports in COLORFGBG (o.fgbg),
//                                                                       as Claude Code reads it
//                      Claude Code also asks the terminal for its background (OSC 11), and keeps the answer to itself.
//                      When COLORFGBG says nothing, auto is the light set: its colors read on a light and on a dark
//                      background (contrast 3.2 or more on both), and the dark set's do not on a light one.
//   themeNow($)        the set now, from the `theme` row of /config, read again when the last read is a second old
//   themeLast()        the set as the last themeNow read it, for a drawing that has no `$` (marks/view.ts citeLook)
//
// No hook tells a plugin that the person picked another theme (/theme and /config write it themselves), so the drawing
// hooks ask: the screen draws again when the theme changes, and the first drawing after it reads the new one. A card
// whose drawing was made for the other theme then asks for a new one, as at a new width (cards/draw.ts frame).
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
export type Theme = 'dark' | 'light'

/** thimble's color: its name on the bar, the keys it names, the citations' turning glyph. Claude Code's color for a
 *  merged pull request, a purple in every theme: #8700ff on the light ones (contrast 6.0 on white), #af87ff on the
 *  dark ones (6.1 on #1e1e1e), magenta on the ANSI ones. Every drawing asks for it as it draws, never keeps it in a
 *  constant, so a change here reaches all of thimble. The pure modules get it from the module that draws them
 *  (core/askcell.js as `color`, the Client squeeze/chips.tsx in its props). */
export function accent(): string {
  return 'merged'
}

const FRESH_MS = 1000

let current: Theme = 'dark'
let readAt = -Infinity

/** COLORFGBG (`fg;bg`, or `fg;default;bg`) as Claude Code reads it: the last field is the background's color number,
 *  0–6 and 8 dark, the others light; null when it says nothing. */
export function themeOfFgbg(value: unknown): Theme | null {
  const last = String(value ?? '').split(';').at(-1) ?? ''
  if (!/^\d+$/.test(last)) return null
  const n = Number(last)
  if (n > 15) return null
  return n <= 6 || n === 8 ? 'dark' : 'light'
}

export function themeOf(value: unknown, o: { fgbg?: unknown; base?: unknown } = {}): Theme {
  const v = String(value ?? 'dark')
  if (v === 'auto') return themeOfFgbg(o.fgbg) ?? 'light'
  if (v.startsWith('light')) return 'light'
  if (v.startsWith('dark')) return 'dark'
  // a custom theme draws over its base; a plugin's theme whose base is not known, by its name
  if (typeof o.base === 'string' && o.base && o.base !== v) return themeOf(o.base, { fgbg: o.fgbg })
  return /light/i.test(v) ? 'light' : 'dark'
}

/** A custom theme's base, from its file in Claude Code's themes folder (`custom:<slug>` is `themes/<slug>.json`). */
async function baseOf($: Engine, value: string): Promise<string | undefined> {
  const slug = value.startsWith('custom:') ? value.slice('custom:'.length) : ''
  if (!slug || /[/\\]|\.\./.test(slug)) return undefined
  const quiet = (p: Promise<string | undefined>) => p.catch(() => undefined)
  try {
    const dir = (await quiet($.env.get('CLAUDE_CONFIG_DIR'))) || `${(await quiet($.env.get('HOME'))) ?? ''}/.claude`
    const base = JSON.parse(String(await $.fs.read(`${dir.replace(/\/+$/, '')}/themes/${slug}.json`)))?.base
    return typeof base === 'string' ? base : undefined
  } catch {
    return undefined
  }
}

export async function themeNow($: Engine): Promise<Theme> {
  let now = 0
  try { now = await $.clock.now() } catch { /* read every time */ }
  if (now && now - readAt < FRESH_MS) return current
  readAt = now
  try {
    const value = String((await $.config.list()).find(r => r.key === 'theme')?.value ?? 'dark')
    let fgbg: string | undefined
    if (value === 'auto') { try { fgbg = await $.env.get('COLORFGBG') } catch { fgbg = undefined } }
    const base = value.startsWith('custom:') ? await baseOf($, value) : undefined
    const next = themeOf(value, { fgbg, base })
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

export function themeLast(): Theme {
  return current
}

/** For tests: the dark set, read again at the next ask. */
export function resetTheme(): void {
  current = 'dark'
  readAt = -Infinity
}
