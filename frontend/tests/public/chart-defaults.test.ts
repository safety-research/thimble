// What a card does to a chart before it draws it (src/lib/chartDefaults), for the charts thimble.chart makes with
// panels and ridgelines: panels one under another at a height a card can show, the y title said once, and a y axis
// that names each of its ticks given the room its names need; a dots chart's groups side by side on a row's line in
// rows a card can show; and layers that give their shared axis one format.
import { expect, test } from 'vitest'
import { chartDefaults, FOLD_FIELD, FOLD_GROUPS, GROUP_STEP, PANEL_HEIGHT, ROW_STEP } from '../../src/lib/chartDefaults.ts'

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

test("a dots chart's groups side by side on a row's line take GROUP_STEP a group, the rows parted by one group's room", () => {
  const dots = [
    { t: 1, agent: 'a1', action: 'claim' },
    { t: 1, agent: 'a1', action: 'review' },
    { t: 2, agent: 'a2', action: 'merge' },
  ]
  // as thimble.chart("dots", frame) writes it with a group column (backend kernel_thimble _xy_spec)
  const enc = (groups: string[]) => ({
    x: { field: 't', type: 'quantitative' },
    y: { field: 'agent', type: 'nominal', sort: ['a1', 'a2'] },
    color: { field: 'action', type: 'nominal', sort: groups },
    yOffset: { field: 'action', type: 'nominal', sort: groups },
  })
  const three = chartDefaults({ $schema: VL, data: { values: dots }, mark: 'point', encoding: enc(['claim', 'review', 'merge']) }) as Spec
  // Vega-Lite's 20 px a group would make each row 60 px tall
  expect(three.height).toEqual({ step: GROUP_STEP })
  expect(three.encoding.y.scale.paddingInner).toBeCloseTo(1 / 4)
  // two groups take the room a row's label needs between them
  const two = chartDefaults({ $schema: VL, data: { values: dots }, mark: 'point', encoding: enc(['claim', 'review']) }) as Spec
  expect(two.height).toEqual({ step: Math.ceil(ROW_STEP / 2) })
  expect(two.encoding.y.scale.paddingInner).toBeCloseTo(1 / 3)
  // with an interval and a mark the dots are a layer inside a layer: the view takes the height, the dots' axis the padding
  const ends = dots.map((d) => ({ ...d, lo: 0, hi: 3 }))
  const layered = chartDefaults({
    $schema: VL,
    data: { values: ends },
    layer: [
      { layer: [{ mark: 'point', encoding: enc(['claim', 'review', 'merge']) }, { mark: 'rule', encoding: { x: { field: 'lo', type: 'quantitative' }, x2: { field: 'hi' }, y: enc([]).y, yOffset: enc(['claim', 'review', 'merge']).yOffset } }] },
      { data: { values: [{ t: 2, mark: 'chance' }] }, mark: 'rule', encoding: { x: { field: 't', type: 'quantitative' } } },
    ],
  }) as Spec
  expect(layered.height).toEqual({ step: GROUP_STEP })
  expect(layered.layer[0].layer[0].encoding.y.scale.paddingInner).toBeCloseTo(1 / 4)
  expect(layered.layer[0].height).toBeUndefined()
  // a height or a padding the chart names stands while its rows have that room, and a chart whose groups share their
  // row's line is left as it is
  const sized = chartDefaults({ $schema: VL, data: { values: dots }, mark: 'point', height: 200, encoding: { ...enc(['claim']), y: { ...enc([]).y, scale: { paddingInner: 0.5 } } } }) as Spec
  expect([sized.height, sized.encoding.y.scale.paddingInner]).toEqual([200, 0.5])
  const short = chartDefaults({ $schema: VL, data: { values: dots }, mark: 'point', height: 40, encoding: enc(['claim', 'review', 'merge']) }) as Spec
  expect(short.height).toEqual({ step: GROUP_STEP })
  const { yOffset: _yOffset, ...shared } = enc(['claim', 'review', 'merge'])
  expect((chartDefaults({ $schema: VL, data: { values: dots }, mark: 'point', encoding: shared }) as Spec).height).toBeUndefined()
})

test("a dots chart's groups past FOLD_GROUPS share the grey other's line, as they share its colour; one group needs no gap", () => {
  const actions = Array.from({ length: 12 }, (_, i) => `cmd-${i}`)
  const dots = actions.flatMap((action, i) => [
    { t: i, agent: 'a1', action, lo: 0, hi: 12 },
    { t: i, agent: 'a2', action, lo: 0, hi: 12 },
  ])
  const enc = {
    x: { field: 't', type: 'quantitative' },
    y: { field: 'agent', type: 'nominal', sort: ['a1', 'a2'] },
    color: { field: 'action', type: 'nominal', sort: actions },
    yOffset: { field: 'action', type: 'nominal', sort: actions },
  }
  const unit = chartDefaults({ $schema: VL, data: { values: dots }, mark: 'point', encoding: enc }) as Spec
  const groups = unit.encoding.color.scale.domain
  expect(groups).toHaveLength(FOLD_GROUPS + 1)
  expect(unit.encoding.yOffset).toEqual({ field: FOLD_FIELD, type: 'nominal', sort: groups })
  // a row of 8 lines, not 12, with one line's gap under it
  expect(unit.height).toEqual({ step: GROUP_STEP })
  expect(unit.encoding.y.scale.paddingInner).toBeCloseTo(1 / (FOLD_GROUPS + 2))
  // with an interval, each interval stays on its dot's line: its layer folds the groups too
  const rule = { mark: 'rule', encoding: { x: { field: 'lo', type: 'quantitative' }, x2: { field: 'hi' }, y: enc.y, yOffset: enc.yOffset } }
  const layered = chartDefaults({ $schema: VL, data: { values: dots }, layer: [{ mark: 'point', encoding: enc }, rule] }) as Spec
  const [point, line] = layered.layer
  expect(line.encoding.yOffset).toEqual(point.encoding.yOffset)
  expect(line.transform).toEqual(point.transform.filter((t: Spec) => t.as === FOLD_FIELD))
  expect(layered.height).toEqual({ step: GROUP_STEP })
  // one group: a row as tall as a row of names, with no gap a second group would need
  const one = chartDefaults({ $schema: VL, data: { values: dots.slice(0, 2) }, mark: 'point', encoding: { ...enc, color: { ...enc.color, sort: ['cmd-0'] }, yOffset: { ...enc.yOffset, sort: ['cmd-0'] } } }) as Spec
  expect([one.height, one.encoding.y.scale.paddingInner]).toEqual([{ step: ROW_STEP }, 0])
})

test('layers that share an axis give it one format: a layer that names its own labels it for all, a binned one stands over whole numbers', () => {
  const bins = [
    { minutes: 0, end: 20, count: 4 },
    { minutes: 20, end: 40, count: 9 },
  ]
  const mark = [{ minutes: 39, mark: 'median 39 min' }]
  const rule = { data: { values: mark }, mark: 'rule', encoding: { x: { field: 'minutes', type: 'quantitative' } } }
  const text = { data: { values: mark }, mark: 'text', encoding: { x: { field: 'minutes', type: 'quantitative' }, y: { value: 0 }, text: { field: 'mark', type: 'nominal' } } }
  // thimble.chart("histogram", values, marks={...}): its bins name their axis's format
  const histogram = { data: { values: bins }, mark: 'bar', encoding: { x: { field: 'minutes', type: 'quantitative', bin: { binned: true, step: 20 }, axis: { format: ',~r' } }, x2: { field: 'end' }, y: { field: 'count', type: 'quantitative' } } }
  const out = chartDefaults({ $schema: VL, layer: [histogram, rule, text] }) as Spec
  expect(out.layer.map((l: Spec) => l.encoding.x.axis?.format)).toEqual([',~r', undefined, undefined])
  // a histogram Altair bins: the bins' format, and none of a whole number's on the rule at a whole value
  const binned = { data: { values: [{ v: 1 }, { v: 4 }] }, mark: 'bar', encoding: { x: { field: 'v', type: 'quantitative', bin: true }, y: { aggregate: 'count', type: 'quantitative' } } }
  const altair = chartDefaults({ $schema: VL, layer: [binned, rule] }) as Spec
  expect(altair.layer.map((l: Spec) => l.encoding.x.axis?.format)).toEqual(['~g', undefined])
  // the count axis keeps whole numbers
  expect(altair.layer[0].encoding.y.axis.format).toBe(',d')
  // a date axis whose format one layer names: no other layer formats it from its values
  const days = { data: { values: [{ day: '2026-08-01' }, { day: '2026-08-09' }] }, mark: 'tick', encoding: { x: { field: 'day', type: 'temporal' } } }
  const named = { ...days, encoding: { x: { field: 'day', type: 'temporal', axis: { format: '%d %b' } } } }
  expect((chartDefaults({ $schema: VL, layer: [days, named] }) as Spec).layer.map((l: Spec) => l.encoding.x.axis?.format)).toEqual([undefined, '%d %b'])
  // a second y axis (Altair's resolve_scale(y="independent")) is its layer's own: its whole numbers keep their format
  const weeks = [
    { week: 1, share: 0.5, PRs: 3 },
    { week: 2, share: 0.75, PRs: 8 },
  ]
  const shares = { mark: 'line', encoding: { x: { field: 'week', type: 'ordinal' }, y: { field: 'share', type: 'quantitative', axis: { format: '%' } } } }
  const counts = { mark: 'bar', encoding: { x: { field: 'week', type: 'ordinal' }, y: { field: 'PRs', type: 'quantitative' } } }
  const formats = (resolve: Spec | undefined) => (chartDefaults({ $schema: VL, data: { values: weeks }, layer: [shares, counts], ...(resolve ? { resolve } : {}) }) as Spec).layer.map((l: Spec) => l.encoding.y.axis?.format)
  expect(formats({ scale: { y: 'independent' } })).toEqual(['%', ',d'])
  expect(formats({ axis: { y: 'independent' } })).toEqual(['%', ',d'])
  expect(formats(undefined)).toEqual(['%', undefined])
})
