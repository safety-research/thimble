// Text contrast from the design tokens (src/styles/tokens.css): every text colour against the grounds it sits on, for
// every paper and accent the theme offers (src/lib/theme.ts), at WCAG AA (4.5:1) or more, and the reader's syntax
// colours at 6:1 (comments at 4.5:1). The tokens are resolved as the browser does: the paper's and the accent's blocks
// over :root, color-mix in oklab (with `transparent` as alpha), and an ink tint composited over the ground under it.
// This keeps a token edit from making text too faint to read.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { ACCENTS, PAPERS } from '../../src/lib/theme.ts'

const CSS = readFileSync(path.resolve(__dirname, '../../src/styles/tokens.css'), 'utf8')
type Env = Record<string, string>
type Rgba = [number, number, number, number]

/** The custom properties a paper and an accent resolve to: every block whose selector list names :root, the paper or
 * the accent (or both), in source order. */
function tokensFor(paper: string, accent: string): Env {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  const env: Env = {}
  const names = new Set([':root', `:root[data-paper='${paper}']`, `:root[data-accent='${accent}']`, `:root[data-paper='${paper}'][data-accent='${accent}']`])
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1].split(';').pop() ?? '').split(',').map((s) => s.trim())
    if (!selectors.some((s) => names.has(s))) continue
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i > 0 && decl.trim().startsWith('--')) env[decl.slice(0, i).trim()] = decl.slice(i + 1).trim().replace(/\s+/g, ' ')
    }
  }
  return env
}

// ---- colour: [r, g, b, a] in sRGB 0..1
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const delin = (c: number) => {
  c = Math.min(1, Math.max(0, c))
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
}
function toOklab([r, g, b]: number[]): number[] {
  ;[r, g, b] = [r, g, b].map(lin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
function fromOklab([L, a, b]: number[]): number[] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(delin)
}
/** color-mix(in oklab, c1 p1, c2 p2), premultiplied by alpha as the spec has it */
function mix(c1: Rgba, p1: number, c2: Rgba, p2: number): Rgba {
  const t = p1 + p2
  ;[p1, p2] = [p1 / t, p2 / t]
  const a = c1[3] * p1 + c2[3] * p2
  if (a === 0) return [0, 0, 0, 0]
  const [l1, l2] = [toOklab(c1), toOklab(c2)]
  const [r, g, b] = fromOklab([0, 1, 2].map((i) => (l1[i] * c1[3] * p1 + l2[i] * c2[3] * p2) / a))
  return [r, g, b, a]
}
const over = (fg: Rgba, bg: Rgba): Rgba => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1]
const lum = (c: Rgba) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
function ratio(fg: Rgba, bg: Rgba): number {
  const f = fg[3] < 1 ? over(fg, bg) : fg
  const [a, b] = [lum(f), lum(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** The arguments of a CSS function, split at its top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  return [...out, cur.trim()]
}

/** A colour expression over the tokens, resolved. */
function colour(env: Env, expr: string): Rgba {
  expr = expr.trim()
  if (expr === 'transparent') return [0, 0, 0, 0]
  if (expr === 'white') return [1, 1, 1, 1]
  if (expr === 'black') return [0, 0, 0, 1]
  if (expr.startsWith('#')) return [parseInt(expr.slice(1, 3), 16) / 255, parseInt(expr.slice(3, 5), 16) / 255, parseInt(expr.slice(5, 7), 16) / 255, 1]
  let m = /^var\((--[\w-]+)\)$/.exec(expr)
  if (m) {
    if (!(m[1] in env)) throw new Error(`${m[1]} is not defined in tokens.css`)
    return colour(env, env[m[1]])
  }
  m = /^rgba\((.*)\)$/.exec(expr)
  if (m) {
    const n = m[1].replace(/var\((--[\w-]+)\)/g, (_, v: string) => env[v]).split(',').map(Number)
    return [n[0] / 255, n[1] / 255, n[2] / 255, n[3]]
  }
  m = /^color-mix\(in oklab, (.*)\)$/.exec(expr)
  if (m) {
    const stops = splitTop(m[1]).map((s): [string, number | null] => {
      const p = /^(.*?)\s+([\d.]+)%$/.exec(s)
      return p ? [p[1], Number(p[2])] : [s, null]
    })
    let [[e1, p1], [e2, p2]] = stops
    if (p1 == null && p2 == null) p1 = p2 = 50
    else if (p1 == null) p1 = 100 - (p2 as number)
    else if (p2 == null) p2 = 100 - p1
    return mix(colour(env, e1), p1 as number, colour(env, e2), p2 as number)
  }
  throw new Error(`cannot resolve ${expr}`)
}

/** A ground painted bottom-up from its layers. */
function ground(env: Env, layers: string[]): Rgba {
  let c: Rgba = [1, 1, 1, 1]
  for (const l of layers) {
    const v = colour(env, l)
    c = v[3] < 1 ? over(v, c) : v
  }
  return c
}

const SIDEBAR = 'color-mix(in oklab, var(--bg-panel) 40%, var(--surface-card))'
const GROUNDS: Record<string, string[]> = {
  window: ['var(--bg-page)'],
  pane: ['var(--bg-panel)'],
  cell: ['var(--surface-card)'],
  inset: ['var(--bg-inset)'],
  'files sidebar': [SIDEBAR],
  'sidebar, hovered row': [SIDEBAR, 'rgba(var(--ink-rgb), 0.04)'],
  'sidebar, open row': [SIDEBAR, 'var(--surface-selected)'],
  'selected row on the cell': ['var(--surface-card)', 'var(--surface-selected)'],
  'tool card on the window': ['var(--bg-page)', 'var(--surface-tonal)'],
  'tool card hovered': ['var(--bg-page)', 'var(--surface-tonal-hover)'],
  'glass strip on the pane': ['var(--bg-panel)', 'var(--glass-bg)'],
}
const EVERY = Object.keys(GROUNDS)
const FLAT = ['window', 'pane', 'cell', 'inset']

// each text token, what it is, and every ground it is drawn on
const TEXT: [string, string, string[]][] = [
  ['--text-primary', 'text: a file name, a heading, code', EVERY],
  ['--text-secondary', 'secondary text: a reply, a record, report prose', EVERY],
  ['--text-tertiary', 'tertiary text: meta, a closed tab, a label row, a line number', EVERY],
  ['--text-placeholder', 'a placeholder, a line number of a raw line', FLAT],
  ['--status-positive', 'positive text', ['cell', 'inset', 'window']],
  ['--status-negative', 'an error', ['cell', 'inset', 'window']],
  ['--status-warning', 'stderr, not checked', ['cell', 'inset', 'window']],
]
const CODE = ['--code-text', '--code-comment', '--code-keyword', '--code-string', '--code-number', '--code-function', '--code-type', '--code-property']

describe.each(PAPERS.map((p) => p.id))('%s paper', (paper) => {
  test('every text token reads at 4.5:1 or more on the grounds it sits on', () => {
    const env = tokensFor(paper, 'iris')
    const low: string[] = []
    for (const [token, what, grounds] of TEXT) {
      for (const g of grounds) {
        const r = ratio(colour(env, `var(${token})`), ground(env, GROUNDS[g]))
        if (r < 4.5) low.push(`${token} (${what}) on ${g}: ${r.toFixed(2)}`)
      }
    }
    expect(low).toEqual([])
  })

  test('the syntax colours read at 6:1 or more, comments at 4.5:1', () => {
    const env = tokensFor(paper, 'iris')
    const low: string[] = []
    for (const token of CODE) {
      for (const g of [...FLAT, 'files sidebar']) {
        const r = ratio(colour(env, `var(${token})`), ground(env, GROUNDS[g]))
        if (r < (token === '--code-comment' ? 4.5 : 6)) low.push(`${token} on ${g}: ${r.toFixed(2)}`)
      }
    }
    expect(low).toEqual([])
  })

  test("each accent's text reads at 4.5:1 on a chip (a view proposal wears one too), and the text on its fill at 4.5:1", () => {
    const low: string[] = []
    for (const { id: accent } of ACCENTS) {
      const env = tokensFor(paper, accent)
      const text = colour(env, 'var(--text-accent)')
      const grounds: Record<string, string[]> = {
        chip: ['var(--surface-card)', 'var(--chip-bg)'],
        'chip hovered': ['var(--surface-card)', 'var(--chip-bg-hover)'],
        cell: ['var(--surface-card)'],
      }
      for (const [g, layers] of Object.entries(grounds)) {
        const r = ratio(text, ground(env, layers))
        if (r < 4.5) low.push(`${accent} --text-accent on ${g}: ${r.toFixed(2)}`)
      }
      const on = ratio(colour(env, 'var(--accent-on)'), colour(env, 'var(--accent)'))
      if (on < 4.5) low.push(`${accent} --accent-on on --accent: ${on.toFixed(2)}`)
    }
    expect(low).toEqual([])
  })
})

test('the resolver agrees with the browser on a known pair: #7a776f on the Warm card reads at 4.40:1', () => {
  const env = tokensFor('warm', 'iris')
  expect(ratio(colour(env, '#7a776f'), colour(env, 'var(--surface-card)')).toFixed(2)).toBe('4.40')
  // the sidebar's colour-mix, as Chromium computes it (getComputedStyle on .files-side)
  expect(ground(env, GROUNDS['files sidebar']).slice(0, 3).map((c) => Math.round(c * 255))).toEqual([251, 249, 244])
})

test("the theme popover's swatches are the accent fills tokens.css carries", () => {
  for (const { id, hex } of ACCENTS) expect(tokensFor('warm', id)['--accent'], id).toBe(hex)
})
