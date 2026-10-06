// A video report as a film (pure, no `$`): each scene of the storyboard drawn as terminal lines at a moment, with the
// card animated by anim.ts and the value the line on screen cites lit, the frames listed with how long each holds, and
// each frame as ANSI text, which helper/film.py renders to PNG (Chromium, the lab's ansi2png cells) and ffmpeg encodes.
// The narration is not drawn here: each frame carries its caption, which film.py sets in a band under the drawing.
import { animFrame, cropFrame, focusItem } from './anim'
import { cut, fold, width } from './draw'
import type { CardData, Line, Seg } from './draw'
import { COLORS } from './paint'
import { FRAME_MS, frameAt, headParts, timing } from './play'
import type { Scene, Timing } from './play'
import { calloutOf, captionFocus, spoken } from './report'

/** The film's grid: 112 by 26 cells of 11 by 22 px is 1232 by 572 px, which film.py sets in a 1280 by 720 frame above
 *  the caption band. */
export const FILM_COLS = 112
export const FILM_ROWS = 26

/** Claude Code's dark theme keys (the colours COLORS names) as RGB, for the film. */
export const DARK: Record<string, string> = {
  text: '#e6edf3',
  inactive: '#8b949e',
  subtle: '#3d444d',
  userMessageBackground: '#262c36',
  selectionBg: '#1f4a7a',
  remember: '#79b8ff',
  error: '#ff7b72',
  success: '#3fb950',
  warning: '#d29922',
  permission: '#b392f0',
}

function rgb(color: string | undefined, palette: Record<string, string>): string | null {
  const hex = color ? (palette[color] ?? color) : ''
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? `${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}` : null
}

/** Lines as ANSI text, one line per row, each segment with its colours (24-bit) and styles. */
export function ansiOf(lines: readonly Line[], palette: Record<string, string> = DARK): string {
  return lines
    .map(l =>
      l
        .map(s => {
          const p = ['0']
          if (s.b) p.push('1')
          if (s.d) p.push('2')
          if (s.i) p.push('3')
          if (s.u) p.push('4')
          if (s.inv) p.push('7')
          const fg = rgb(s.fg, palette)
          const bg = rgb(s.bg, palette)
          if (fg) p.push(`38;2;${fg}`)
          if (bg) p.push(`48;2;${bg}`)
          return `\x1b[${p.join(';')}m${s.s}`
        })
        .join('') + '\x1b[0m',
    )
    .join('\n')
}

const ease = (p: number) => 1 - (1 - Math.max(0, Math.min(1, p))) ** 3

/** A shown value counting up with t (digits scaled, separators and words kept), as the player's tiles count. */
export function countUp(display: string, t: number): string {
  if (t >= 1) return display
  const m = /^(\D*?)([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(.*)$/.exec(display)
  if (!m) return display.slice(0, Math.round(display.length * t))
  const [, pre = '', sign = '', int = '', frac = '', post = ''] = m
  const v = Number(`${int.replace(/,/g, '')}${frac}`) * ease(t)
  let s = v.toFixed(frac ? frac.length - 1 : 0)
  if (int.includes(',')) {
    const [i = '', f] = s.split('.')
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '')
  }
  return `${pre}${sign}${s}${post}`
}

/** `l` with `by` blank cells before it. */
const indent = (l: Line, by: number): Line => (by > 0 ? [{ s: ' '.repeat(by) }, ...l] : l)

/** A box of `w` columns around `body` (each line at most w - 4 wide), its border in the rule grey. */
function box(body: readonly Line[], w: number, _lit: boolean): Line[] {
  const b = { fg: COLORS.rule }
  const pad = (l: Line): Line => {
    const n = l.reduce((a, s) => a + width(s.s), 0)
    return [{ s: '│ ', ...b }, ...l, { s: ' '.repeat(Math.max(0, w - 4 - n)) }, { s: ' │', ...b }]
  }
  return [[{ s: `╭${'─'.repeat(w - 2)}╮`, ...b }], ...body.map(pad), [{ s: `╰${'─'.repeat(w - 2)}╯`, ...b }]]
}

/** A tile: a cited value counting up and the place it is cited from. */
function tile(value: string, place: string, w: number, lit: boolean): Line[] {
  return box([[{ s: cut(value, w - 4) || ' ', ...(lit ? { bg: COLORS.selected } : {}) }], [{ s: cut(place, w - 4), d: true }]], w, lit)
}

export type FilmScene = Scene & { tiles?: { ref: string; display: string; place: string }[] }

/** A scene at `ms` as `cols` by `rows` lines: its heading, then its card animated (the value the current line cites
 *  lit, its label at the right of the question), its tiles counting up, or for the title scene the title typing in and
 *  the scenes to come listed. The scene's number and count stand at the bottom right. */
export function sceneLines(scene: FilmScene, card: CardData | null | undefined, ms: number, n: number, of: number, cols = FILM_COLS, rows = FILM_ROWS, tm: Timing = timing(scene)): Line[] {
  const fr = frameAt(scene, ms, tm)
  const out: Line[] = [[]]
  const cap = fr.current >= 0 ? scene.captions[fr.current] : undefined
  if (scene.kind === 'title') {
    while (out.length < Math.floor(rows / 3) - 1) out.push([])
    const title = fold(scene.heading || 'Video', cols - 12)
    let left = Math.round(title.reduce((a, l) => a + width(l), 0) * Math.min(1, fr.t * 2))
    title.forEach((l, i) => {
      const typed = [...l].slice(0, Math.max(0, left)).join('')
      left -= width(l)
      out.push([{ s: '    ' }, { s: typed || ' ' }])
    })
    out.push([])
    const items = scene.contents ?? []
    items.slice(0, rows - out.length - 3).forEach((c, i) => {
      if (fr.t < 0.3 + (0.6 * i) / Math.max(1, items.length)) return
      out.push([{ s: `      ${String(i + 1).padStart(2)}  `, fg: COLORS.dim }, { s: cut(c, cols - 12) }])
    })
  } else {
    if (scene.heading) for (const l of fold(scene.heading, cols - 6).slice(0, 2)) out.push([{ s: '  ' }, { s: l }])
    // what the scene shows stands in the rows under its heading, a little above their middle
    const shows: Line[] = []
    const room = rows - 1 - out.length - 1
    if (scene.kind === 'card') {
      const w = Math.min(cols - 2, 124)
      const x0 = Math.max(0, Math.floor((cols - w) / 2))
      if (!card) shows.push(indent([{ s: '× this card cannot be drawn', fg: COLORS.problem }], x0))
      else {
        const inner = w - 4
        const focus = cap?.focus ? captionFocus(card, cap.focus) : undefined
        const plotRows = Math.max(5, Math.min(18, room - 6))
        const lay = animFrame(card, inner, fr.t, focus, plotRows)
        const k = focus ? focusItem(card, lay.items, focus) : -1
        const item = k >= 0 && fr.t >= 1 ? lay.items[k] : undefined
        const { q, tip } = headParts(card.question, item ? (item.value ? `${item.label}  ${item.value}` : item.label) : '', inner)
        const head: Line = [{ s: q }, ...(tip ? [{ s: ' '.repeat(Math.max(2, inner - width(q) - width(tip))) }, { s: tip } as Seg] : [])]
        // a card taller than the rows left is cropped around the lit value (anim.ts)
        for (const l of box([head, ...cropFrame(card, lay, inner, Math.max(1, room - 4), k, plotRows)], w, Boolean(item))) shows.push(indent(l, x0))
        const step = scene.captions.find(c => c.focus.startsWith('step:'))?.focus.slice(5) ?? ''
        const callout = calloutOf(step)
        if (callout && fr.t >= 1) shows.push(indent([{ s: callout }], x0 + 2))
      }
    } else if (scene.tiles?.length) {
      const per = Math.min(4, scene.tiles.length)
      const tw = Math.min(per === 1 ? 72 : 34, Math.floor((cols - 8) / per) - 2)
      const x0 = Math.max(4, Math.floor((cols - per * tw - 2 * (per - 1)) / 2))
      for (let r = 0; r < scene.tiles.length; r += per) {
        const row = scene.tiles.slice(r, r + per).map(t => tile(countUp(t.display, fr.t), t.place, tw, cap !== undefined && cap.focus === t.ref))
        if (r) shows.push([])
        for (let y = 0; y < 4; y++) shows.push(indent(row.flatMap((b, i) => [...(i ? [{ s: '  ' }] : []), ...b[y]!]), x0))
      }
    }
    const top = Math.max(1, Math.floor((room - shows.length) / 3))
    for (let i = 0; i < top; i++) out.push([])
    out.push(...shows)
  }
  while (out.length < rows - 1) out.push([])
  out.length = rows - 1
  const count = `${n} / ${of}  `
  out.push([{ s: ' '.repeat(Math.max(0, cols - width(count))) }, { s: count, d: true }])
  return out
}

export type FilmFrame = { ansi: string; ms: number; caption: string }
export type FilmLine = { start: number; end: number; text: string }
export type Film = { cols: number; rows: number; frames: FilmFrame[]; lines: FilmLine[]; seconds: number; starts: number[] }

/** The film of a storyboard: frames every FRAME_MS while a scene animates, then one each time the line on screen
 *  changes, each held until the next; identical neighbours merged. `lines` are the narration's lines with when each is
 *  said (seconds from the start), for a voice; `starts` when each scene starts (ms). */
export function filmOf(scenes: readonly FilmScene[], card: (id: string) => CardData | null | undefined, cols = FILM_COLS, rows = FILM_ROWS): Film {
  const frames: FilmFrame[] = []
  const lines: FilmLine[] = []
  const starts: number[] = []
  let at = 0
  scenes.forEach((s, i) => {
    const tm = timing(s)
    starts.push(at)
    const marks = new Set<number>([0, tm.total])
    for (let ms = FRAME_MS; ms < tm.anim; ms += FRAME_MS) marks.add(ms)
    marks.add(tm.anim)
    for (const t of tm.starts) marks.add(t)
    const times = [...marks].filter(t => t <= tm.total).sort((a, b) => a - b)
    const data = s.card ? card(s.card) : null
    for (let j = 0; j < times.length - 1; j++) {
      const ms = times[j]!
      // the scene just after the mark: a line that starts at it is on screen
      const fr = frameAt(s, ms + 1, tm)
      const cap = fr.current >= 0 ? spoken(s.captions[fr.current]!.text) : ''
      const ansi = ansiOf(sceneLines(s, data, ms + 1, i + 1, scenes.length, cols, rows, tm))
      const dur = times[j + 1]! - ms
      const prev = frames.at(-1)
      if (prev && prev.ansi === ansi && prev.caption === cap) prev.ms += dur
      else frames.push({ ansi, ms: dur, caption: cap })
    }
    s.captions.forEach((c, k) => {
      const start = (at + tm.starts[k]!) / 1000
      lines.push({ start: Math.round(start * 100) / 100, end: Math.round((start + (s.secs?.[k] ?? 4.5)) * 100) / 100, text: spoken(c.text) })
    })
    at += tm.total
  })
  return { cols, rows, frames, lines, seconds: Math.round(at / 100) / 10, starts }
}
