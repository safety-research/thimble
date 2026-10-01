// The nominal chart colours (--viz-1 to --viz-7 in src/styles/tokens.css), which views, cards and charts take for
// their categories: on every paper none is a red, which reads as an error, or a purple, the agents' colour, each reads
// at 3:1 on the paper's grounds, and neighbours and the first three stay apart, also under protan and deutan vision.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { MPL_CYCLE, restyle } from '../../src/lib/svg.ts'

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

/** OKLCH chroma and hue in degrees */
const chromaHue = (hex: string): [number, number] => {
  const [, a, b] = oklab(linear(hex))
  return [Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360]
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
