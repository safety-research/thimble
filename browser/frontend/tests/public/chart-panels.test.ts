// A chart in panels as a card draws it (src/lib/chartDefaults, src/lib/vegaDraw), read from Vega's scene under Node:
// bars side by side by group (xOffset) in panels that each have their own categories (x resolved independent, as Altair
// writes `.facet(column=...).resolve_scale(x="independent")`) are drawn at their width, not a quarter of a pixel; and a
// chart that draws nothing says why (nothingDrawn), so its empty panels are never taken for the chart.
import { parse, View } from 'vega'
import { compile } from 'vega-lite'
import { expect, test } from 'vitest'
import { chartDefaults } from '../../src/lib/chartDefaults.ts'
import { nothingDrawn } from '../../src/lib/vegaDraw.ts'
import { vegaConfig } from '../../src/lib/vizTheme.ts'

type Spec = Record<string, any>
const VL = 'https://vega.github.io/schema/vega-lite/v6.4.1.json'

const rows: Spec[] = []
for (const [model, setups] of [['Fable', ['s1', 's1 +issues', 's2', 's2 +issues']], ['Opus', ['s2', 's2 +issues']], ['Sonnet', ['s3', 's3 +issues']]] as const)
  for (const setup of setups) for (const [team, merged] of [['managed', 200], ['leaderless', 250]] as const) rows.push({ model, setup, team, merged })

/** The chart as Altair writes grouped bars split into a panel per model, each panel with its own setups. */
const panels = (data: Spec[] = rows, more: Spec = {}): Spec => ({
  $schema: VL,
  data: { name: 'd' },
  datasets: { d: data },
  facet: { column: { field: 'model', type: 'nominal', title: null } },
  spec: {
    mark: { type: 'bar' },
    width: 150,
    encoding: {
      x: { field: 'setup', type: 'nominal', title: null },
      xOffset: { field: 'team', type: 'nominal' },
      y: { field: 'merged', type: 'quantitative', title: 'Merged PRs' },
      color: { field: 'team', type: 'nominal', title: null },
    },
    ...more,
  },
  resolve: { scale: { x: 'independent' } },
})

/** The chart's scene once Vega has drawn it, and its bars. */
async function draw(spec: Spec): Promise<{ root: unknown; bars: { width: number; height: number }[] }> {
  const view = new View(parse(compile(spec as never, { config: vegaConfig() as never }).spec as never), { renderer: 'none' })
  await view.runAsync()
  const root = (view.scenegraph() as unknown as { root: unknown }).root
  const bars: { width: number; height: number }[] = []
  const walk = (m: any) => {
    if (m.role === 'mark' && m.marktype === 'rect') bars.push(...m.items)
    for (const it of m.items ?? []) for (const c of it.items ?? []) walk(c)
  }
  walk(root)
  return { root, bars }
}

test('bars side by side in panels with their own categories are drawn at their width, each panel its own offsets', async () => {
  // as Vega-Lite draws it: one offset scale for the chart, which reads a band that exists only in each panel
  const plain = await draw(panels())
  expect(plain.bars).toHaveLength(rows.length)
  expect(plain.bars.every((b) => b.width < 1)).toBe(true)
  expect(nothingDrawn(plain.root)).toBe('size')
  // as a card draws it
  const shown = chartDefaults(panels(), { card: true }) as Spec
  expect(shown.resolve.scale).toEqual({ x: 'independent', xOffset: 'independent' })
  const card = await draw(shown)
  expect(card.bars).toHaveLength(rows.length)
  expect(card.bars.every((b) => b.width > 10 && b.height > 10)).toBe(true)
  expect(nothingDrawn(card.root)).toBeNull()
  // the same under a layer of labels, and with the panels as the unit's own column channel
  const layered = chartDefaults({ ...panels(), spec: { layer: [{ mark: 'bar', encoding: panels().spec.encoding }, { mark: 'text', encoding: { ...panels().spec.encoding, text: { field: 'merged', type: 'quantitative' } } }], width: 150 } }, { card: true }) as Spec
  expect(layered.resolve.scale.xOffset).toBe('independent')
  expect((await draw(layered)).bars.every((b) => b.width > 10)).toBe(true)
  const { facet: _f, spec: inner, ...top } = panels()
  const channel = chartDefaults({ ...top, ...inner, encoding: { ...inner.encoding, column: { field: 'model', type: 'nominal' } } }, { card: true }) as Spec
  expect(channel.resolve.scale.xOffset).toBe('independent')
  // an offset the chart resolves itself, and panels that share their x, are left as they are
  expect((chartDefaults({ ...panels(), resolve: { scale: { x: 'independent', xOffset: 'shared' } } }) as Spec).resolve.scale.xOffset).toBe('shared')
  expect((chartDefaults({ ...panels(), resolve: undefined }) as Spec).resolve).toBeUndefined()
})

test('a chart says why it draws nothing: no rows, or bars under a pixel; a chart that draws a mark says nothing', async () => {
  expect(nothingDrawn((await draw(chartDefaults(panels([])) as Spec)).root)).toBe('rows')
  const filtered = chartDefaults(panels(rows, { transform: [{ filter: 'datum.model == "Haiku"' }] })) as Spec
  expect(nothingDrawn((await draw(filtered)).root)).toBe('rows')
  const dots = await draw({ $schema: VL, data: { values: rows }, mark: 'point', encoding: { x: { field: 'merged', type: 'quantitative' }, y: { field: 'model', type: 'nominal' } } })
  expect(nothingDrawn(dots.root)).toBeNull()
  // panels with no rows have no marks, only their axes; no scene is no judgement
  expect(nothingDrawn({ role: 'frame', marktype: 'group', items: [{ items: [{ role: 'axis', marktype: 'group', items: [] }] }] })).toBe('rows')
  expect(nothingDrawn(undefined)).toBeNull()
})
