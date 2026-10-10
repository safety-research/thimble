// The marks of thimble.chart (backend kernel_thimble) as Vega draws them under Node in the chart style (src/lib/vizTheme),
// read from Vega's scene: dots that would overlap on a line moved across it by the steps the chart's transform gives
// them (DODGE_OFFSET), an interval's rule with its dot; a range's two solid ends in two series colors, or, when its
// groups take the colors, the before end the lighter; an area's hover points drawn with no dot.
import { parse, View } from 'vega'
import { compile } from 'vega-lite'
import { expect, test } from 'vitest'
import { token, vegaConfig } from '../../src/lib/vizTheme.ts'

type Spec = Record<string, unknown>
type Item = { x: number; y: number; x2?: number; y2?: number; fill?: string; opacity?: number; size?: number; datum: Record<string, unknown> }
const field = (name: string, type: string, more: Spec = {}) => ({ field: name, type, title: name, ...more })

/** The items of each mark of the chart, by Vega's mark type, in the order the marks are drawn; the legends' symbols as
 * the type `legend`. */
async function scene(spec: Spec): Promise<{ type: string; items: Item[] }[]> {
  const vg = compile({ ...spec, width: 300, height: 120 } as never, { config: vegaConfig() as never }).spec
  const view = new View(parse(vg as never), { renderer: 'none' })
  await view.runAsync()
  const out: { type: string; items: Item[] }[] = []
  const walk = (s: any) => {
    if (s.role === 'mark' && s.marktype !== 'group') out.push({ type: s.marktype, items: s.items })
    if (s.role === 'legend-symbol') out.push({ type: 'legend', items: s.items })
    for (const it of s.items ?? []) for (const c of it.items ?? []) walk(c)
  }
  walk((view.scenegraph() as unknown as { root: unknown }).root)
  return out
}

// as thimble.chart writes a dots chart whose second and third dots would overlap the first on its row's line
const DODGE = [
  { window: [{ op: 'row_number', as: '__thimble_row' }] },
  { lookup: '__thimble_row', from: { data: { values: [{ r: 2, d: -1 }, { r: 3, d: 1 }] }, key: 'r', fields: ['d'] }, as: ['__thimble_dodge'], default: 0 },
]
const OFFSET = { expr: 'datum["__thimble_dodge"] * 3.5' }

test('dots that would overlap on a line move across it by their steps, the rest stay on it, and an interval moves with its dot', async () => {
  const rows = [
    { score: 0.5, model: 'm1', lo: 0.4, hi: 0.6 },
    { score: 0.5, model: 'm1', lo: 0.3, hi: 0.7 },
    { score: 0.51, model: 'm1', lo: 0.45, hi: 0.55 },
    { score: 0.9, model: 'm1', lo: 0.8, hi: 1 },
    { score: 0.5, model: 'm2', lo: 0.4, hi: 0.6 },
  ]
  const enc = { x: field('score', 'quantitative'), y: field('model', 'nominal', { sort: ['m1', 'm2'] }) }
  const marks = await scene({
    data: { values: rows },
    transform: DODGE,
    layer: [
      { mark: { type: 'point', yOffset: OFFSET }, encoding: enc },
      { mark: { type: 'rule', yOffset: OFFSET }, encoding: { x: field('lo', 'quantitative'), x2: { field: 'hi' }, y: enc.y } },
    ],
  })
  const dots = marks.find((m) => m.type === 'symbol')!.items
  const line = dots[0]!.y
  expect(dots.map((d) => d.y - line)).toEqual([0, -3.5, 3.5, 0, dots[4]!.y - line])
  expect(dots[4]!.y - line).toBeGreaterThan(10)
  // each x stays where its value is
  expect(dots[1]!.x).toBe(dots[0]!.x)
  const rules = marks.find((m) => m.type === 'rule')!.items
  expect(rules.map((r) => r.y)).toEqual(dots.map((d) => d.y))
})

test("a range's ends are solid dots in two series colors, or the before end the lighter when its groups take the colors", async () => {
  const rows = [{ model: 'm1', base: 0.4, tuned: 0.5, family: 'open' }, { model: 'm2', base: 0.6, tuned: 0.55, family: 'closed' }]
  // as thimble.chart writes a range: its end named by its column, in color, or with groups in strength
  const end = (c: string, ends: Spec) => ({
    transform: [{ calculate: JSON.stringify(c), as: '__thimble_end' }],
    mark: { type: 'point', style: 'thimble-end' },
    encoding: { x: field(c, 'quantitative'), y: field('model', 'nominal'), ...ends },
  })
  const plain = { field: '__thimble_end', type: 'nominal', scale: { domain: ['base', 'tuned'] }, title: null }
  const solo = await scene({ data: { values: rows }, layer: [end('base', { color: plain }), end('tuned', { color: plain })] })
  const [before, after] = solo.filter((m) => m.type === 'symbol').map((m) => m.items[0]!)
  expect([before!.fill, after!.fill]).toEqual([token('--viz-1'), token('--viz-2')])
  expect([before!.opacity, after!.opacity]).toEqual([1, 1])
  expect(before!.size).toBe(56)
  const strength = { ...plain, type: 'ordinal' }
  const color = { color: field('family', 'nominal') }
  const grouped = await scene({ data: { values: rows }, layer: [end('base', { ...color, opacity: strength }), end('tuned', { ...color, opacity: strength })] })
  const [b, a] = grouped.filter((m) => m.type === 'symbol').map((m) => m.items[0]!)
  expect([b!.opacity, a!.opacity]).toEqual([0.4, 1])
  expect(b!.fill).toBe(a!.fill)
  // the ends' legend draws its symbols in the labels' ink, which a dark paper lightens, never Vega-Lite's black
  const keys = grouped.filter((m) => m.type === 'legend').flatMap((m) => m.items)
  const steps = keys.filter((k) => k.fill !== token('--viz-1') && k.fill !== token('--viz-2'))
  expect(steps.map((k) => [k.fill, k.opacity])).toEqual([[token('--viz-label'), 0.4], [token('--viz-label'), 1]])
})

test("an area's hover points draw no dot, and are wider than a dot so a hover finds them", async () => {
  const rows = [1, 2, 3].map((x) => ({ x, y: x * 2 }))
  const marks = await scene({ data: { values: rows }, mark: { type: 'area', point: { style: 'thimble-hover' } }, encoding: { x: field('x', 'quantitative'), y: field('y', 'quantitative'), tooltip: [field('y', 'quantitative')] } })
  const points = marks.find((m) => m.type === 'symbol')!.items as (Item & { fillOpacity?: number; tooltip?: unknown })[]
  expect(points).toHaveLength(3)
  expect(points.every((p) => p.fillOpacity === 0 && !(p as { stroke?: string }).stroke)).toBe(true)
  expect(points.every((p) => (p.size as number) > 4 * 30)).toBe(true)
  expect(points[0]!.tooltip).toBeTruthy()
})

test("a range's line runs from one end's edge to the other's, whichever way it runs", async () => {
  const rows = [{ model: 'up', base: 0.4, tuned: 0.8 }, { model: 'down', base: 0.8, tuned: 0.4 }, { model: 'same', base: 0.5, tuned: 0.5 }]
  // as thimble.chart writes a range's line (backend kernel_thimble _range_spec, RANGE_GAP)
  const way = '(datum["tuned"] > datum["base"] ? 1 : datum["tuned"] < datum["base"] ? -1 : 0)'
  const marks = await scene({ data: { values: rows }, layer: [
    { mark: { type: 'rule', style: 'thimble-span', xOffset: { expr: `${way} * 4` }, x2Offset: { expr: `${way} * -4` } }, encoding: { x: field('base', 'quantitative'), x2: { field: 'tuned' }, y: field('model', 'nominal') } },
    { mark: { type: 'point', style: 'thimble-end' }, encoding: { x: field('base', 'quantitative'), y: field('model', 'nominal') } },
  ] })
  const rules = marks.find((m) => m.type === 'rule')!.items
  const ends = marks.find((m) => m.type === 'symbol')!.items
  const [up, down, same] = rules
  expect(up!.x - ends[0]!.x).toBe(4)
  expect(down!.x - ends[1]!.x).toBe(-4)
  expect(Math.abs(up!.x2! - up!.x) + 8).toBeCloseTo(Math.abs(down!.x2! - down!.x) + 8)
  expect([same!.x, same!.x2]).toEqual([ends[2]!.x, ends[2]!.x])
})

test("a violin's curves each reach the same width at their widest, however tall their densities", async () => {
  // as thimble.chart writes a violin's body (backend kernel_thimble _violin_spec): two curves, one ten times as tall
  const rows = [0, 1, 2].flatMap((x) => [{ v: x, density: [0.1, 0.5, 0.1][x]!, g: 'wide' }, { v: x, density: [1, 5, 1][x]!, g: 'narrow' }])
  const reach = 'datum["density"] / max(datum["__thimble_most"], 1e-300) * 0.45'
  const marks = await scene({ data: { values: rows }, transform: [
    { calculate: '1 - indexof(["wide", "narrow"], datum["g"])', as: '__thimble_base' },
    { joinaggregate: [{ op: 'max', field: 'density', as: '__thimble_most' }], groupby: ['g'] },
    { calculate: `datum["__thimble_base"] + ${reach}`, as: '__thimble_top' },
    { calculate: `datum["__thimble_base"] - ${reach}`, as: '__thimble_low' },
  ], mark: { type: 'area', style: 'thimble-box' }, encoding: { x: field('v', 'quantitative'), y: { field: '__thimble_top', type: 'quantitative', scale: { domain: [-0.5, 1.5], nice: false, zero: false } }, y2: { field: '__thimble_low' }, detail: { field: 'g', type: 'nominal' } } })
  // a mark per curve, an item per point of it
  const widest = marks.filter((m) => m.type === 'area').map((m) => Math.max(...m.items.map((p) => Math.abs(p.y2! - p.y))))
  expect(widest).toHaveLength(2)
  expect(widest[0]).toBeCloseTo(widest[1]!)
  expect(widest[0]).toBeCloseTo(0.9 * 120 / 2)
})
