// The chart style as each renderer takes it (src/lib/vizTheme): the Vega-Lite theme draws one series in the first series
// color, never ink, groups in the series, amounts in the accent's ramps and notes in ink, at the chart sizes; a timeline
// colors its lanes' dots by the series; and the frames of custom cards and card types get the style as CSS variables.
import { describe, expect, test } from 'vitest'
import { laneColors } from '../../src/canvas/DataViz.tsx'
import { CHART_TOKENS, FRAME_TOKENS, VIEW_TOKENS } from '../../src/lib/frame.ts'
import { token, vegaConfig, VIZ_DIV, VIZ_SEQ, VIZ_SERIES } from '../../src/lib/vizTheme.ts'

describe('the Vega-Lite theme', () => {
  const c = vegaConfig() as Record<string, Record<string, unknown>>
  const inks = ['--viz-ink-1', '--viz-ink-2', '--viz-ink-3', '--viz-ink-4'].map(token)

  test('draws one series in the first series color, not ink', () => {
    expect(c.mark.color).toBe(token('--viz-1'))
    expect(inks).not.toContain(c.mark.color)
    for (const m of ['bar', 'line', 'point', 'area']) for (const k of ['color', 'fill', 'stroke']) expect(c[m]?.[k], `${m}.${k}`).toBeUndefined()
  })

  test('draws groups in the series, and amounts in the ramps, so a two-group chart is in color too', () => {
    expect(c.range.category).toEqual(VIZ_SERIES.map(token))
    expect(c.range.ordinal).toEqual({ scheme: VIZ_SEQ.slice(1).map(token) })
    expect(c.range.ramp).toEqual({ scheme: VIZ_SEQ.map(token) })
    expect(c.range.heatmap).toEqual({ scheme: VIZ_SEQ.map(token) })
    expect(c.range.diverging).toEqual({ scheme: VIZ_DIV.map(token) })
  })

  test('draws rules and text marks in the annotation ink, and its text at the chart sizes in the chart faces', () => {
    expect(c.rule.color).toBe(token('--viz-annotation'))
    expect(c.text).toEqual({ color: token('--viz-annotation'), font: token('--viz-font'), fontSize: 11 })
    expect(c.axis).toMatchObject({ labelFont: token('--viz-font-label'), labelFontSize: 11, titleFont: token('--viz-font'), titleFontSize: 11 })
    expect(c.legend).toMatchObject({ labelFont: token('--viz-font-label'), labelFontSize: 11, titleFontSize: 11 })
    expect(c.title).toMatchObject({ fontSize: 13 })
  })
})

test("a timeline's lanes take the series in the order they first appear, and the muted other past seven", () => {
  expect([...laneColors(['', '']).entries()]).toEqual([['', 'var(--viz-1)']])
  const lanes = laneColors(['b', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'a'])
  expect([...lanes.keys()]).toEqual(['b', 'a', 'c', 'd', 'e', 'f', 'g', 'h'])
  expect([...lanes.values()]).toEqual([...VIZ_SERIES.map((s) => `var(${s})`), 'var(--viz-other)'])
})

test("a custom card's frame and a card type's or view's page get the chart style as CSS variables", () => {
  for (const name of [...VIZ_SERIES, ...VIZ_SEQ, ...VIZ_DIV, '--viz-other', '--viz-highlight', '--viz-font', '--viz-font-label', '--viz-size', '--label-1', '--label-none']) expect(CHART_TOKENS).toContain(name)
  for (const name of CHART_TOKENS) {
    expect(FRAME_TOKENS, name).toContain(name)
    expect(VIEW_TOKENS, name).toContain(name)
  }
  expect(new Set(VIEW_TOKENS).size).toBe(VIEW_TOKENS.length)
})
