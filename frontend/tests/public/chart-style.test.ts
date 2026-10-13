// The chart style as each renderer takes it (src/lib/vizTheme): the Vega-Lite theme draws one series in the first series
// color, never ink, groups in the series, amounts in the accent's ramps and notes in ink, at the chart sizes; a timeline
// colors its lanes' dots by the series; and the frames of custom cards and card types get the style as CSS variables, and
// a view's page every token of the theme that the view kit's styles, its docs and the worked examples name.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { laneColors } from '../../src/canvas/DataViz.tsx'
import { CHART_TOKENS, FRAME_TOKENS, VIEW_TOKENS } from '../../src/lib/frame.ts'
import { token, vegaConfig, VIZ_DIV, VIZ_SEQ, VIZ_SERIES, withTokens } from '../../src/lib/vizTheme.ts'

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

  test("draws the marks thimble.chart names by their job: a faint band behind a line, a box plot's lighter boxes, its medians in ink, areas overlapping lightly", () => {
    const s = c.style as Record<string, Record<string, unknown>>
    // each keeps its series or label color: the theme gives only how strongly it shows
    for (const name of ['thimble-faint', 'thimble-box', 'thimble-overlap']) {
      expect(s[name].color, name).toBeUndefined()
      expect(s[name].opacity as number, name).toBeLessThan(1)
    }
    expect(s['thimble-faint'].opacity as number).toBeLessThan(s['thimble-box'].opacity as number)
    expect(s['thimble-median']).toMatchObject({ color: token('--viz-ink-1'), opacity: 1 })
    // a scatter's fitted line in ink unless its group colors it; a range's line muted between two solid ends of their
    // colors, larger than a dot (Matt, 2026-10-10: the custom dumbbell "a bit better with a solid fill")
    expect(s['thimble-fit'].color).toBe(token('--viz-ink-1'))
    expect(s['thimble-span'].color).toBe(token('--viz-other'))
    expect(s['thimble-end']).toMatchObject({ opacity: 1 })
    expect(s['thimble-end'].color).toBeUndefined()
    expect(s['thimble-end'].filled).toBeUndefined()
    expect(s['thimble-end'].size as number).toBeGreaterThan(30)
    // an area's hover points wider than a dot; the spec makes them unseen, as a style's fillOpacity would also empty the
    // legend's swatches (chart-marks)
    expect(s['thimble-hover'].fillOpacity).toBeUndefined()
    expect(s['thimble-hover'].size as number).toBeGreaterThan(4 * 30)
  })

  test("rounds a bar's end by --viz-bar-radius, and leaves a box plot's box square", () => {
    expect(c.bar).toEqual({ cornerRadiusEnd: 2 })
    expect((c.style as Record<string, Record<string, unknown>>)['thimble-box'].cornerRadiusEnd).toBe(0)
  })
})

test("a mark a card's code colors with thimble.theme takes the theme's color now, so it follows the accent and the paper", () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    layer: [
      { mark: 'bar', encoding: { x: { field: 'day', type: 'temporal' } } },
      { mark: { type: 'text', color: 'var(--viz-highlight)' }, encoding: { color: { condition: { test: 'true', value: 'var(--viz-other)' }, value: 'var( --viz-ink-4 )' } } },
      { mark: { type: 'rule', color: 'var(--accent)' }, encoding: { text: { value: 'var(--viz-nothing)' } } },
    ],
  }
  const paper: Record<string, string> = { '--viz-highlight': '#e26101', '--viz-other': '#85827a', '--viz-ink-4': '#4d4b47' }
  const out = withTokens(spec, (name) => paper[name] ?? '') as typeof spec
  expect(out.layer[1]).toEqual({ mark: { type: 'text', color: '#e26101' }, encoding: { color: { condition: { test: 'true', value: '#85827a' }, value: '#4d4b47' } } })
  // only the chart's tokens: the interface's own and a name the theme lacks stay as written
  expect(out.layer[2]).toBe(spec.layer[2])
  expect(out.layer[0]).toBe(spec.layer[0])
  expect(withTokens({ a: [1, 'x'] })).toEqual({ a: [1, 'x'] })
  // read from the document by default, with the Warm paper's values where the page sets none
  expect(withTokens('var(--viz-ink-1)')).toBe(token('--viz-ink-1'))
})

test("a timeline's lanes take the series in the order they first appear, and the muted other past seven", () => {
  expect([...laneColors(['', '']).entries()]).toEqual([['', 'var(--viz-1)']])
  const lanes = laneColors(['b', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'a'])
  expect([...lanes.keys()]).toEqual(['b', 'a', 'c', 'd', 'e', 'f', 'g', 'h'])
  expect([...lanes.values()]).toEqual([...VIZ_SERIES.map((s) => `var(${s})`), 'var(--viz-other)'])
})

test("a custom card's frame and a card type's or view's page get the chart style as CSS variables", () => {
  for (const name of [...VIZ_SERIES, ...VIZ_SEQ, ...VIZ_DIV, '--viz-other', '--viz-highlight', '--viz-font', '--viz-font-label', '--viz-size', '--viz-bar-radius', '--label-1', '--label-none']) expect(CHART_TOKENS).toContain(name)
  for (const name of CHART_TOKENS) {
    expect(FRAME_TOKENS, name).toContain(name)
    expect(VIEW_TOKENS, name).toContain(name)
  }
  expect(new Set(VIEW_TOKENS).size).toBe(VIEW_TOKENS.length)
})

test("a view's page, in the app and in the checks' shots, gets every token of the theme that the kit's styles and scripts, its docs and the worked examples name, the links' color among them", () => {
  const root = path.resolve(__dirname, '../../..')
  const inDir = (dir: string, re: RegExp) => readdirSync(path.join(root, dir)).filter((n) => re.test(n)).map((n) => path.join(root, dir, n))
  const theme = new Set([...readFileSync(path.join(root, 'frontend/src/styles/tokens.css'), 'utf8').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]))
  const files = [
    ...inDir('backend/app', /^viewer_.*\.(css|js)$/),
    ...inDir('docs', /\.md$/),
    ...readdirSync(path.join(root, 'plugin/viewers'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, 'plugin/viewers', d.name, 'view.html')),
  ]
  const named = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])))
  expect(named.size).toBeGreaterThan(40)
  expect([...named].filter((name) => theme.has(name) && !VIEW_TOKENS.includes(name))).toEqual([])
  // a view draws its own links in the app's link color, as the kit's text does
  expect(VIEW_TOKENS).toContain('--text-link')
  expect(named).toContain('--text-link')
  // the checks' headless shots give a view's page the same tokens (scripts/view_shot.mjs)
  const shot = readFileSync(path.join(root, 'scripts/view_shot.mjs'), 'utf8').split('const VIEW_TOKENS = [')[1].split(']')[0]
  expect([...shot.matchAll(/'(--[\w-]+)'/g)].map((m) => m[1]).sort()).toEqual([...VIEW_TOKENS].sort())
})
