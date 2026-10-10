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
