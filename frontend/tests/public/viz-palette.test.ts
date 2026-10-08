// The nominal chart colours (--viz-1 to --viz-7 in src/styles/tokens.css), which views, cards and charts take for
// their categories: on every paper none is a red, which reads as an error, or a purple, the agents' colour, each reads
// at 3:1 on the paper's grounds, and neighbours and the first three stay apart, also under protan and deutan vision.
// The label colours (--label-1 to --label-12) hold to the same, all twelve stay apart pairwise, each place is on every
// paper the hue show_label's name for it says (a stored color is a place, so a place never changes hue), the first five
// new values take (LABEL_ORDER) are five hues, and Dark's chestnut, brown and navy, which a dark paper lightens, stay
// apart from orange and sky.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { LABEL_ORDER, LABEL_WHEEL } from '../../src/files/labels.ts'
import { MPL_CYCLE, restyle } from '../../src/lib/svg.ts'
import { token } from '../../src/lib/vizTheme.ts'

const CSS = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8')
const SLOTS = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7']

/** the hex custom properties of each rule whose selector is exactly `selector`, later rules over earlier ones */
function block(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim() !== selector) continue
    for (const d of m[2].matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[d[1]] = d[2].toLowerCase()
  }
  return out
}

const BASE = block(':root')
const PAPERS: Record<string, Record<string, string>> = {
  warm: BASE,
  neutral: { ...BASE, ...block(":root[data-paper='neutral']") },
  dark: { ...BASE, ...block(":root[data-paper='dark']") },
}
const GROUNDS = ['--white', '--paper-0', '--paper-1', '--paper-2']

const linear = (hex: string): number[] =>
  [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })

const luminance = (hex: string): number => {
  const [r, g, b] = linear(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

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

// Machado, Oliveira and Fernandes (2009) at severity 1, on linear RGB
const CVD: Record<string, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
}

const seen = (hex: string, vision?: string): number[] => {
  const rgb = linear(hex)
  const m = vision ? CVD[vision] : null
  const out = m ? m.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]))) : rgb
  return oklab(out)
}

/** the distance of two colours in OKLab, times 100 */
const apart = (a: string, b: string, vision?: string): number => {
  const [x, y] = [seen(a, vision), seen(b, vision)]
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/** the CIE 1976 distance of two colours in CIELAB (D65) */
const cielab = (a: string, b: string): number => {
  const lab = (hex: string): number[] => {
    const [r, g, bl] = linear(hex)
    const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * bl, (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883]
    const [x, y, z] = xyz.map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116))
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
  }
  const [p, q] = [lab(a), lab(b)]
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
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

test("matplotlib's colour cycle is the light paper's chart colours, and an inlined figure takes each as its token", () => {
  const rc = readFileSync(new URL('../../../backend/app/matplotlibrc', import.meta.url), 'utf8')
  const cycle = [...(/axes\.prop_cycle:.*/.exec(rc)?.[0] ?? '').matchAll(/'([0-9a-fA-F]{6})'/g)].map((m) => `#${m[1].toLowerCase()}`)
  expect(cycle).toEqual(SLOTS.map((s) => BASE[s]))
  expect(MPL_CYCLE).toEqual(cycle)
  cycle.forEach((hex, i) => {
    expect(restyle(`fill: ${hex}; stroke: ${hex.toUpperCase()}`)).toBe(` fill: var(--viz-${i + 1}); stroke: var(--viz-${i + 1})`)
  })
})

describe.each(Object.keys(PAPERS))('the chart colours on the %s paper', (paper) => {
  const t = PAPERS[paper]
  const colours = SLOTS.map((s) => t[s])

  test('are seven colours, none of them a red or a purple', () => {
    expect(colours.every(Boolean)).toBe(true)
    for (const c of colours) {
      const [chroma, hue] = chromaHue(c)
      expect(chroma, c).toBeGreaterThan(0.1)
      expect(hue < 45 || hue >= 345, `${c} is a red (hue ${hue.toFixed(0)})`).toBe(false)
      expect(hue >= 270 && hue < 345, `${c} is a purple (hue ${hue.toFixed(0)})`).toBe(false)
    }
  })

  test('each reads at 3:1 or more on every ground of the paper', () => {
    for (const g of GROUNDS) {
      for (const c of colours) expect(contrast(c, t[g]), `${c} on ${g} ${t[g]}`).toBeGreaterThanOrEqual(3)
    }
  })

  test('neighbours stay apart, also under protan and deutan vision', () => {
    for (let i = 1; i < colours.length; i++) {
      const [a, b] = [colours[i - 1], colours[i]]
      expect(apart(a, b), `${a} and ${b}`).toBeGreaterThanOrEqual(15)
      for (const v of ['protan', 'deutan']) expect(apart(a, b, v), `${a} and ${b} under ${v}`).toBeGreaterThanOrEqual(8)
    }
  })

  test('the first three, which a scatter or a map of three groups shows side by side, stay apart pairwise', () => {
    const [x, y, z] = colours
    for (const [a, b] of [[x, y], [x, z], [y, z]]) {
      expect(apart(a, b), `${a} and ${b}`).toBeGreaterThanOrEqual(15)
      for (const v of ['protan', 'deutan']) expect(apart(a, b, v), `${a} and ${b} under ${v}`).toBeGreaterThanOrEqual(8)
    }
  })
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
  for (const name of [...SLOTS, ...LABELS, '--label-none']) expect(snap[name], `${name} in the tour's frame-base.css`).toBe(BASE[name])
})

test("thimble-term's copies: its picker's places around the wheel, show_label's names, and each place's hue the light paper's", () => {
  // the mod imports nothing outside its folder, so it keeps its own copies, each an array on one line
  const mod = (file: string) => readFileSync(new URL(`../../../mods/thimble-term/hooks/${file}`, import.meta.url), 'utf8')
  const list = (src: string, name: string): unknown[] => JSON.parse(new RegExp(`^export const ${name}\\b[^=]*= (\\[.*\\])(?: as const)?$`, 'm').exec(src)![1].replace(/'/g, '"'))
  const labels = mod('labels.ts')
  expect(list(labels, 'LABEL_WHEEL')).toEqual(LABEL_WHEEL)
  expect(Object.fromEntries(list(labels, 'COLOR_NAMES').map((n, i) => [n, i + 1]))).toEqual(NAMES)
  // one hue a place for the terminal's light and dark panels (its test holds each at 3:1 on both): the light paper's
  // hue, its lightness moved
  const paint = mod('paint.ts')
  const hues = [...list(paint, 'LABEL_HUES'), ...list(paint, 'PICKED_HUES')] as string[]
  expect(hues).toHaveLength(LABELS.length + PICKED.length)
  hues.forEach((c, i) => {
    const d = Math.abs(chromaHue(c)[1] - chromaHue(BASE[`--label-${i + 1}`])[1])
    expect(Math.min(d, 360 - d), `thimble-term's color ${i + 1} ${c} and --label-${i + 1} ${BASE[`--label-${i + 1}`]}`).toBeLessThanOrEqual(6)
  })
})

describe.each(Object.keys(PAPERS))('the picked colours on the %s paper', (paper) => {
  const t = PAPERS[paper]
  test('are red, purple and pink, a light and a dark of each, each at 3:1 or more on every ground', () => {
    const colours = PICKED.map((s) => t[s])
    expect(colours.every(Boolean)).toBe(true)
    const hues = colours.map((c) => chromaHue(c)[1])
    expect(hues.slice(0, 2).every((h) => h < 45 || h >= 345), `reds ${hues}`).toBe(true)
    for (const g of GROUNDS) for (const c of colours) expect(contrast(c, t[g]), `${c} on ${g} ${t[g]}`).toBeGreaterThanOrEqual(3)
  })
})

describe.each(Object.keys(PAPERS))('the label colours on the %s paper', (paper) => {
  const t = PAPERS[paper]
  const colours = LABELS.map((s) => t[s])

  test('are twelve colours, none of them a red or a purple', () => {
    expect(colours.every(Boolean)).toBe(true)
    for (const c of colours) {
      const [chroma, hue] = chromaHue(c)
      expect(chroma, c).toBeGreaterThan(0.085)
      expect(hue < 45 || hue >= 345, `${c} is a red (hue ${hue.toFixed(0)})`).toBe(false)
      expect(hue >= 270 && hue < 345, `${c} is a purple (hue ${hue.toFixed(0)})`).toBe(false)
    }
  })

  test('each reads at 3:1 or more on every ground of the paper', () => {
    for (const g of GROUNDS) {
      for (const c of colours) expect(contrast(c, t[g]), `${c} on ${g} ${t[g]}`).toBeGreaterThanOrEqual(3)
    }
  })

  test('neighbours stay apart, also under protan and deutan vision, and no two of the twelve look alike', () => {
    for (let i = 1; i < colours.length; i++) {
      const [a, b] = [colours[i - 1], colours[i]]
      expect(apart(a, b), `${a} and ${b}`).toBeGreaterThanOrEqual(15)
      for (const v of ['protan', 'deutan']) expect(apart(a, b, v), `${a} and ${b} under ${v}`).toBeGreaterThanOrEqual(8)
    }
    for (let i = 0; i < colours.length; i++) for (let j = i + 1; j < colours.length; j++) expect(apart(colours[i], colours[j]), `${colours[i]} and ${colours[j]}`).toBeGreaterThanOrEqual(7.5)
  })

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

  test('the first five new values take (LABEL_ORDER), which a field of five values shows side by side, are five hues with no second blue, 15 apart in OKLab, also under protan and deutan vision', () => {
    const five = LABEL_ORDER.slice(0, 5).map((n) => t[`--label-${n}`])
    expect(LABEL_ORDER.slice(0, 5).map((n) => Object.keys(NAMES).find((k) => NAMES[k] === n))).toEqual(['blue', 'orange', 'green', 'olive', 'teal'])
    for (let i = 0; i < 5; i++)
      for (let j = i + 1; j < 5; j++) {
        const [a, b] = [five[i], five[j]]
        const dh = Math.abs(chromaHue(a)[1] - chromaHue(b)[1])
        expect(Math.min(dh, 360 - dh), `${a} and ${b} are one hue`).toBeGreaterThanOrEqual(25)
        expect(cielab(a, b), `${a} and ${b}`).toBeGreaterThanOrEqual(29.5)
        // the floor of the dataviz validator: orange and gold were 12.7 apart on the light papers, and read as one
        expect(apart(a, b), `${a} and ${b}`).toBeGreaterThanOrEqual(15)
        for (const v of ['protan', 'deutan']) expect(apart(a, b, v), `${a} and ${b} under ${v}`).toBeGreaterThanOrEqual(8)
      }
  })

  test('chestnut and brown stay apart from orange, and navy from sky', () => {
    const [orange, sky, brown, navy, chestnut] = ['orange', 'sky blue', 'brown', 'navy', 'chestnut'].map((n) => t[place(n)])
    expect(cielab(chestnut, orange), `${chestnut} and ${orange}`).toBeGreaterThanOrEqual(30)
    // the dataviz floor too: Dark's chestnut #f1a271 was 12.8 from orange in OKLab, and beside it read as one orange
    expect(apart(chestnut, orange), `${chestnut} and ${orange}`).toBeGreaterThanOrEqual(15)
    expect(cielab(brown, orange), `${brown} and ${orange}`).toBeGreaterThanOrEqual(28)
    expect(cielab(navy, sky), `${navy} and ${sky}`).toBeGreaterThanOrEqual(23)
  })
})
