// The copies of the palette (src/styles/tokens.css, lib/vizTheme) that other parts keep: matplotlib's defaults and the
// kernel's colours (backend), the chart fallbacks, the tour's example view and the terminal UI's generated palette
// (plugin/hooks/term) are the tokens' own; and each label colour's place is on every paper the hue show_label's name
// for it says, since a stored color is a place.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { LABEL_WHEEL } from '../../src/files/labels.ts'
import { MPL_CYCLE, MPL_LABELS, restyle } from '../../src/lib/svg.ts'
import { token, VIZ_DIV, VIZ_SEQ, VIZ_SERIES } from '../../src/lib/vizTheme.ts'

const CSS = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8')
const SLOTS = VIZ_SERIES

/** the declarations of each rule whose selector, its whitespace collapsed, is `selector`, later rules over earlier
 * ones: a hex value (`hex`) or the property a var() reads (`ref`) */
function rule(selector: string, kind: 'hex' | 'ref'): Record<string, string> {
  const out: Record<string, string> = {}
  const value = kind === 'hex' ? /(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g : /(--[\w-]+):\s*var\((--[\w-]+)\)\s*;/g
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim() !== selector) continue
    for (const d of m[2].matchAll(value)) out[d[1]] = kind === 'hex' ? d[2].toLowerCase() : d[2]
  }
  return out
}
const block = (selector: string) => rule(selector, 'hex')

const BASE = block(':root')
const PAPERS: Record<string, Record<string, string>> = {
  warm: BASE,
  neutral: { ...BASE, ...block(":root[data-paper='neutral']") },
  dark: { ...BASE, ...block(":root[data-paper='dark']") },
}
/** what the default accent's rule reads (its selector is :root too) and what another accent's reads over it */
const refs = (accent: string): Record<string, string> => ({ ...rule(':root', 'ref'), ...rule(":root, :root[data-accent='iris']", 'ref'), ...(accent === 'iris' ? {} : rule(`:root[data-accent='${accent}']`, 'ref')) })
/** a token's hex on a paper with an accent, its var() references followed */
function resolve(name: string, paper: string, accent: string): string {
  const r = refs(accent)
  let n = name
  for (let i = 0; i < 6 && r[n] && !PAPERS[paper][n]; i++) n = r[n]
  return PAPERS[paper][n]
}

const linear = (hex: string): number[] =>
  [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })

function oklab([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** OKLCH chroma and hue in degrees */
const chromaHue = (hex: string): [number, number] => {
  const [, a, b] = oklab(linear(hex))
  return [Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360]
}

/** OKLCH lightness */
const lightness = (hex: string): number => oklab(linear(hex))[0]

/** show_label's color names by palette place (backend concepts.COLOUR_NAMES), the names of the places a stored color takes */
const NAMES: Record<string, number> = JSON.parse(/^COLOUR_NAMES = (\{[^}]*\})/m.exec(readFileSync(new URL('../../../backend/app/concepts.py', import.meta.url), 'utf8'))![1])
const place = (name: string): string => `--label-${NAMES[name]}`

/** Each name's family: the OKLCH hues (degrees) only that family takes on any paper. Within a family, `apart` says what
 * tells its members apart on every paper (Dark lightens some of them, so lightness alone does not). */
const FAMILY: Record<string, [number, number]> = {
  orange: [40, 85], chestnut: [40, 85], brown: [40, 85],
  olive: [85, 120],
  green: [130, 168], 'grass green': [130, 168],
  teal: [170, 200],
  cyan: [205, 227],
  'sky blue': [228, 247], cerulean: [228, 247],
  blue: [248, 275], navy: [248, 275],
  // the places only the analyst picks (13 to 18)
  red: [10, 40], 'dark red': [10, 40],
  purple: [280, 310], 'dark purple': [280, 310],
  pink: [335, 360], 'dark pink': [335, 360],
}

/** a size of the semantic tokens in px, its var() followed */
function px(name: string): number {
  const decls = Object.fromEntries([...CSS.matchAll(/(--[\w-]+):\s*([^;{}]+);/g)].map((m) => [m[1], m[2].trim()]))
  let v = decls[name]
  for (let i = 0; i < 4 && /^var\(/.test(v); i++) v = decls[/^var\((--[\w-]+)\)/.exec(v)![1]]
  return parseFloat(v)
}

test("matplotlib's defaults are the chart style: the default accent's series on the Warm paper, each of which an inlined figure takes as its series token, and the chart sizes in points", () => {
  const rc = readFileSync(new URL('../../../backend/app/matplotlibrc', import.meta.url), 'utf8')
  const cycle = [...(/axes\.prop_cycle:.*/.exec(rc)?.[0] ?? '').matchAll(/'([0-9a-fA-F]{6})'/g)].map((m) => `#${m[1].toLowerCase()}`)
  expect(cycle).toEqual(SLOTS.map((s) => resolve(s, 'warm', 'iris')))
  expect(MPL_CYCLE).toEqual(cycle)
  cycle.forEach((hex, i) => {
    expect(restyle(`fill: ${hex}; stroke: ${hex.toUpperCase()}`)).toBe(` fill: var(--viz-${i + 1}); stroke: var(--viz-${i + 1})`)
  })
  // a point is 4/3 px at a card's width (the matplotlibrc's note)
  const pt = (key: string) => Number(new RegExp(`^${key.replace('.', '\\.')}:\\s*([\\d.]+)`, 'm').exec(rc)![1])
  for (const key of ['font.size', 'axes.labelsize', 'xtick.labelsize', 'ytick.labelsize', 'legend.fontsize']) expect((pt(key) * 4) / 3, key).toBeCloseTo(px('--viz-size'), 5)
  expect((pt('axes.titlesize') * 4) / 3).toBeCloseTo(px('--viz-size-title'), 5)
  expect((pt('lines.linewidth') * 4) / 3).toBeCloseTo(px('--viz-line'), 5)
})

test("a figure colored by a label (thimble.colours) takes the label's tokens, and the neutral inks theirs, so it follows the paper as the Labels pane does", () => {
  const py = readFileSync(new URL('../../../backend/app/kernel_thimble.py', import.meta.url), 'utf8')
  const list = (name: string) => [...(new RegExp(`${name} = \\[[^\\]]*\\]`).exec(py)?.[0] ?? '').matchAll(/"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase())
  expect(MPL_LABELS).toEqual(list('LABEL_COLOURS'))
  MPL_LABELS.forEach((hex, i) => expect(restyle(`fill: ${hex}`), hex).toBe(` fill: var(--label-${i || 'none'})`))
  expect(list('NEUTRAL_COLOURS').map((hex) => restyle(`stroke: ${hex}`))).toEqual([' stroke: var(--viz-ink-1)', ' stroke: var(--viz-ink-2)', ' stroke: var(--viz-grid)'])
})

test("the chart fallbacks, which a chart built with no document reads, are the Warm paper's with the default accent", () => {
  for (const name of [...SLOTS, ...VIZ_SEQ, ...VIZ_DIV, '--viz-other', '--viz-highlight', '--viz-annotation', '--viz-ink-1', '--viz-ink-2', '--viz-ink-3', '--viz-ink-4'])
    expect(token(name), name).toBe(resolve(name, 'warm', 'iris'))
  expect(parseFloat(token('--viz-size'))).toBe(px('--viz-size'))
  expect(parseFloat(token('--viz-size-title'))).toBe(px('--viz-size-title'))
  expect(parseFloat(token('--viz-line'))).toBe(px('--viz-line'))
  expect(parseFloat(token('--viz-bar-radius'))).toBe(px('--viz-bar-radius'))
})

const LABELS = Array.from({ length: 12 }, (_, i) => `--label-${i + 1}`)
// the colours only the analyst picks: red, a dark red, violet, a dark purple, pink, a dark pink
const PICKED = Array.from({ length: 6 }, (_, i) => `--label-${i + 13}`)

test("the label colours' copies are the light paper's: the charts' fallbacks and the kernel's", () => {
  expect(LABELS.map((l) => token(l))).toEqual(LABELS.map((l) => BASE[l]))
  const py = readFileSync(new URL('../../../backend/app/kernel_thimble.py', import.meta.url), 'utf8')
  const kernel = [...(/LABEL_COLOURS = \[[^\]]*\]/.exec(py)?.[0] ?? '').matchAll(/"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase())
  expect(kernel).toEqual([BASE['--label-none'], ...LABELS.map((l) => BASE[l]), ...PICKED.map((l) => BASE[l])])
  // the product tour's example view carries a snapshot of the light paper's tokens
  const tour = readFileSync(new URL('../../public/tour/timeline/assets/frame-base.css', import.meta.url), 'utf8')
  const snap = Object.fromEntries([...tour.matchAll(/(--(?:label|viz)-[\w-]+):(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]))
  for (const name of [...SLOTS, ...LABELS, '--label-none']) expect(snap[name], `${name} in the tour's frame-base.css`).toBe(resolve(name, 'warm', 'iris'))
})

test("the terminal UI's copies: its picker's places around the wheel, show_label's names, and its palette the tokens' own", () => {
  // the terminal UI imports nothing outside its folder, so it keeps its own copies, each an array on one line
  const mod = (file: string) => readFileSync(new URL(`../../../plugin/hooks/term/${file}`, import.meta.url), 'utf8')
  const list = (src: string, name: string): unknown[] => JSON.parse(new RegExp(`^export const ${name}\\b[^=]*= (\\[.*\\])(?: as const)?$`, 'm').exec(src)![1].replace(/'/g, '"'))
  const labels = mod('labels.ts')
  expect(list(labels, 'LABEL_WHEEL')).toEqual(LABEL_WHEEL)
  expect(Object.fromEntries(list(labels, 'COLOR_NAMES').map((n, i) => [n, i + 1]))).toEqual(NAMES)
  // 0.9.0: the palette is generated from these tokens (scripts/dev/sync_palette.py writes palette.gen.ts): the default
  // accent's series and the label places, on the light paper (Warm) and on Dark. A stale file fails here: run the script
  const gen = mod('palette.gen.ts')
  for (const [paper, suffix] of [['warm', 'LIGHT'], ['dark', 'DARK']] as const) {
    expect(list(gen, `SERIES_${suffix}`), `SERIES_${suffix}`).toEqual(SLOTS.map((s) => resolve(s, paper, 'iris')))
    expect(list(gen, `LABEL_${suffix}`), `LABEL_${suffix}`).toEqual(LABELS.map((l) => PAPERS[paper][l]))
    expect(list(gen, `PICKED_${suffix}`), `PICKED_${suffix}`).toEqual(PICKED.map((l) => PAPERS[paper][l]))
  }
})

describe.each(Object.keys(PAPERS))('the label colours on the %s paper', (paper) => {
  const t = PAPERS[paper]

  test('each place is the hue its name says: show_label names the place a stored color takes, so a place keeps its hue', () => {
    expect(Object.keys(NAMES).sort()).toEqual(Object.keys(FAMILY).sort())
    expect(Object.values(NAMES).sort((a, b) => a - b)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    for (const [name, [lo, hi]] of Object.entries(FAMILY)) {
      const c = t[place(name)]
      const hue = chromaHue(c)[1]
      expect(hue >= lo && hue < hi, `${place(name)} ${c} is not ${name} (hue ${hue.toFixed(0)})`).toBe(true)
    }
    const [chroma, hue, light] = [(n: string) => chromaHue(t[place(n)])[0], (n: string) => chromaHue(t[place(n)])[1], (n: string) => lightness(t[place(n)])]
    expect(chroma('orange'), 'orange is the vivid one of its family').toBeGreaterThan(Math.max(chroma('brown'), chroma('chestnut')))
    expect(hue('brown'), 'brown is yellower than chestnut').toBeGreaterThan(hue('chestnut'))
    expect(chroma('grass green'), 'grass is more vivid than green').toBeGreaterThan(chroma('green'))
    expect(light('sky blue'), 'sky is lighter than cerulean').toBeGreaterThan(light('cerulean'))
    expect(chroma('sky blue'), 'sky is more vivid than cerulean').toBeGreaterThan(chroma('cerulean'))
    expect(chroma('blue'), 'blue is more vivid than navy').toBeGreaterThan(chroma('navy'))
    for (const n of ['red', 'purple', 'pink']) expect(chroma(n), `${n} is more vivid than dark ${n}`).toBeGreaterThan(chroma(`dark ${n}`))
  })
})
