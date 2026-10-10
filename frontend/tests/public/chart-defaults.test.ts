// What a card does to a chart before it draws it (src/lib/chartDefaults), for the charts thimble.chart makes with
// panels and ridgelines: panels one under another at a height a card can show, the y title said once, and a y axis
// that names each of its ticks given the room its names need.
import { expect, test } from 'vitest'
import { chartDefaults, PANEL_HEIGHT, ROW_STEP } from '../../src/lib/chartDefaults.ts'

type Spec = Record<string, any>
const VL = 'https://vega.github.io/schema/vega-lite/v6.json'
const rows = [
  { x: 1, y: 2, g: 'a' },
  { x: 2, y: 3, g: 'b' },
]

test('panels one under another take PANEL_HEIGHT each, unless the chart or its config sizes them or rows do', () => {
  const unit = chartDefaults({ $schema: VL, data: { values: rows }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, row: { field: 'g', type: 'nominal' } } }) as Spec
  expect(unit.height).toBe(PANEL_HEIGHT)
  const layered = { $schema: VL, data: { values: rows }, facet: { row: { field: 'g', type: 'nominal', title: null } }, spec: { layer: [{ mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } }, { mark: 'line', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative', title: 'y' } } }] } }
  const faceted = chartDefaults(layered) as Spec
  expect(faceted.spec.height).toBe(PANEL_HEIGHT)
  // the y title once, as the rows' title, as for a single mark's panels
  expect(faceted.facet.row.title).toBe('y')
  expect(faceted.spec.layer.map((l: Spec) => l.encoding.y.title)).toEqual([null, null])
  expect((chartDefaults({ ...layered, spec: { ...layered.spec, height: 90 } }) as Spec).spec.height).toBe(90)
  expect((chartDefaults({ ...layered, config: { view: { continuousHeight: 300 } } }) as Spec).spec.height).toBeUndefined()
  // a discrete y axis is sized by its rows
  const bars = chartDefaults({ $schema: VL, data: { values: rows }, mark: 'bar', encoding: { y: { field: 'g', type: 'nominal' }, x: { field: 'x', type: 'quantitative' }, row: { field: 'g', type: 'nominal' } } }) as Spec
  expect(bars.height).toBeUndefined()
})

test('a y axis that names each of its ticks (a ridgeline) gets ROW_STEP a name when its height gives them less', () => {
  const ridge = (n: number, more: Spec = {}): Spec => ({
    $schema: VL,
    data: { values: rows },
    mark: 'area',
    encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'top', type: 'quantitative', axis: { values: [...Array(n).keys()], labelExpr: 'datum.value' } }, y2: { field: 'base' } },
    ...more,
  })
  expect((chartDefaults(ridge(9)) as Spec).height).toBeUndefined()
  expect((chartDefaults(ridge(30)) as Spec).height).toBe(31 * ROW_STEP)
  expect((chartDefaults(ridge(30, { height: 900 })) as Spec).height).toBe(900)
  // with a mark across it the ridgeline is a layer, sized as a whole
  const marked = { $schema: VL, data: { values: rows }, layer: [{ ...ridge(30), $schema: undefined, data: undefined }, { data: { values: [{ x: 1 }] }, mark: 'rule', encoding: { x: { field: 'x', type: 'quantitative' } } }] }
  expect((chartDefaults(marked) as Spec).height).toBe(31 * ROW_STEP)
})

test("a layered chart's date axis is labeled and titled from all its layers, so a shaded span may come first", () => {
  const days = Array.from({ length: 21 }, (_, i) => ({ day: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00`, merged: i }))
  const span = { data: { values: [{ a: '2026-08-08T00:00:00', b: '2026-08-12T00:00:00' }] }, mark: { type: 'rect', color: 'var(--viz-ink-4)' }, encoding: { x: { field: 'a', type: 'temporal' }, x2: { field: 'b' } } }
  const bars = { data: { values: days, name: 'thimble-chart-0' }, mark: 'line', encoding: { x: { field: 'day', type: 'temporal', title: 'day' }, y: { field: 'merged', type: 'quantitative', title: 'merged' } } }
  const out = chartDefaults({ $schema: VL, layer: [span, bars] }) as Spec
  const [behind, line] = out.layer
  // the span's one day would label the axis by the hour, and its field would join the title ("day, a")
  expect(behind.encoding.x.axis.format).toBe('%b %-d')
  expect(line.encoding.x.axis.format).toBe('%b %-d')
  expect(behind.encoding.x.title).toBe('day')
  // the day labels tick at least a day apart, so no day is named twice
  expect(line.encoding.x.axis.tickMinStep).toBe(86_400_000)
  // a title the first layer takes from its field stays Vega-Lite's own there, as before
  const own = chartDefaults({ $schema: VL, layer: [{ ...span, encoding: { x: { field: 'a', type: 'temporal' } } }, { ...bars, encoding: { x: { field: 'day', type: 'temporal' } } }] }) as Spec
  expect(own.layer[0].encoding.x.title).toBeUndefined()
  expect(own.layer[1].encoding.x.title).toBe('a')
})

test("a date axis spans its x2's values too, as a range's dumbbells do", () => {
  const ends = [
    { agent: 'a1', first: '2026-08-02T09:00:00', last: '2026-08-09T00:00:00' },
    { agent: 'a2', first: '2026-08-01T10:00:00', last: '2026-08-03T18:00:00' },
  ]
  const unit = chartDefaults({ $schema: VL, data: { values: ends }, mark: 'rule', encoding: { x: { field: 'first', type: 'temporal' }, x2: { field: 'last' }, y: { field: 'agent', type: 'nominal' } } }) as Spec
  // the befores alone span under 3 days, which would name each label's hour
  expect(unit.encoding.x.axis.format).toBe('%b %-d')
})
