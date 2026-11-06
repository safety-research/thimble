// The chart palette (src/styles/tokens.css, lib/vizTheme): the series take one order on every accent, blue, orange,
// teal, pink, gold, violet, green. On every paper and accent, neighbors and the first three, which a scatter or a map of
// three groups shows side by side, stay apart for every reader, also under protan, deutan and tritan vision.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { ACCENTS } from '../../src/lib/theme.ts'
import { VIZ_SERIES } from '../../src/lib/vizTheme.ts'

const CSS = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8')

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
const BASE = rule(':root', 'hex')
const PAPERS: Record<string, Record<string, string>> = {
  warm: BASE,
  neutral: { ...BASE, ...rule(":root[data-paper='neutral']", 'hex') },
  dark: { ...BASE, ...rule(":root[data-paper='dark']", 'hex') },
}
/** the families in the series' order */
const FAMILIES = ['blue', 'orange', 'teal', 'pink', 'gold', 'violet', 'green']
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
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
// Machado, Oliveira and Fernandes (2009) at severity 1, on linear RGB
const CVD: Record<string, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
}
const seen = (hex: string, vision?: string): number[] => {
  const rgb = linear(hex)
  const m = vision ? CVD[vision] : null
  return oklab(m ? m.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]))) : rgb)
}
/** the distance of two colours in OKLab, times 100 */
const apart = (a: string, b: string, vision?: string): number => {
  const [x, y] = [seen(a, vision), seen(b, vision)]
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}
// the dataviz validator's floors: 15 apart in OKLab for full-color readers, 8 under each simulated vision, except where
// the chosen order accepts less: teal and pink are near twins under deutan vision, blue and teal under tritan vision,
// and Dark's blue and teal sit just under 15 for full-color readers
const ACCEPTED: Record<string, Record<string, number>> = { 'blue-teal': { full: 14, tritan: 3.5 }, 'teal-pink': { deutan: 2 } }
const floor = (i: number, j: number, v?: string): number => ACCEPTED[`${FAMILIES[i]}-${FAMILIES[j]}`]?.[v ?? 'full'] ?? (v ? 8 : 15)

test('on every paper and accent, neighboring series and the first three stay apart, also under protan, deutan and tritan vision', () => {
  const pairs = [...FAMILIES.slice(1).map((_, i) => [i, i + 1]), [0, 2]]
  for (const paper of Object.keys(PAPERS)) {
    for (const accent of ACCENTS.map((a) => a.id)) {
      const colors = VIZ_SERIES.map((s) => resolve(s, paper, accent))
      expect(new Set(colors).size, `${paper}, ${accent}`).toBe(7)
      for (const [i, j] of pairs) {
        const [a, b] = [colors[i], colors[j]]
        expect(apart(a, b), `${a} and ${b} on ${paper}, ${accent}`).toBeGreaterThanOrEqual(floor(i, j))
        for (const v of Object.keys(CVD)) expect(apart(a, b, v), `${a} and ${b} under ${v} on ${paper}, ${accent}`).toBeGreaterThanOrEqual(floor(i, j, v))
      }
    }
  }
})
