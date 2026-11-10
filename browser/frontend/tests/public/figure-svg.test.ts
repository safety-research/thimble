// @vitest-environment jsdom
// A matplotlib figure's text in the Blog figure style (src/lib/svg.ts inlineSvg `minText`, restyle): at least a size in
// px at the figure's own width, which its viewBox in pt scales, and nothing changed without it. All data is made up.
import { expect, test } from 'vitest'
import { inlineSvg, restyle } from '../../src/lib/svg.ts'

// a matplotlib figure as the kernel writes one (backend matplotlibrc): 7.2 in by 4 in, its viewBox in pt, text in pt
const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="518.4pt" height="288pt" viewBox="0 0 518.4 288">
 <g id="figure_1">
  <g id="text_1"><text style="font-size: 8.25px; font-family: 'Hanken Grotesk', sans-serif; fill: #64625b" x="10" y="20">tick</text></g>
  <g id="text_2"><text style="font-size: 9.75px; font-family: 'Hanken Grotesk', sans-serif; fill: #64625b" x="10" y="40">title</text></g>
 </g>
</svg>`
const sizes = (markup: string) => [...markup.matchAll(/font-size: ([\d.]+)px/g)].map((m) => Number(m[1]))

test("in Blog a matplotlib figure's text is at least the least size at the figure's own width", () => {
  const fig = inlineSvg(FIGURE, 'f1-', { minText: 12 })!
  expect(fig.width).toBeCloseTo(691.2)
  // 12 px at the figure's 691.2 px is 9 of its 518.4 pt units; the 13 px title (9.75 pt) stays
  expect(sizes(fig.markup)).toEqual([9, 9.75])
  // in the gray of a Vega chart's tick labels (lib/vizTheme axis labelColor), Blog's #8a8a86
  expect(fig.markup.match(/fill: var\(--viz-label\)/g)).toHaveLength(2)
  // thimble's figure as ever
  expect(inlineSvg(FIGURE, 'f1-')!.markup).toBe(inlineSvg(FIGURE, 'f1-', {})!.markup)
  expect(sizes(inlineSvg(FIGURE, 'f1-')!.markup)).toEqual([8.25, 9.75])
})

test('another drawing keeps its text as it is', () => {
  const other = FIGURE.replace('id="figure_1"', 'id="graph0"')
  expect(sizes(inlineSvg(other, 'f2-', { minText: 12 })!.markup)).toEqual([8.25, 9.75])
})

test("a matplotlib figure's text under a least size is raised to it, in either way matplotlib writes a size", () => {
  expect(restyle("font-size: 8.25px; font-family: 'DejaVu Sans'", false, 9)).toBe(' font-size: 9px; font-family: var(--viz-font)')
  expect(restyle("font: 8.25px 'Hanken Grotesk'", false, 9)).toBe(' font: 9px var(--viz-font)')
  expect(restyle('font: italic 600 8px/1.2 serif', false, 9)).toBe(' font: italic 600 9px/1.2 serif')
  // larger text, and any text without a least size, as it is
  expect(restyle('font-size: 13px', false, 9)).toBe('font-size: 13px')
  expect(restyle('font-size: 8.25px')).toBe('font-size: 8.25px')
})
