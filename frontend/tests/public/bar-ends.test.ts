// A bar's round end (src/lib/barEnds, the theme's `bar.cornerRadiusEnd` of src/lib/vizTheme), drawn by Vega-Lite and
// Vega under Node as a card's chart is: the spec compiled in the theme, then barEnds as vega-embed's patch. Vega-Lite
// 6.4.3 drew no bar that runs from x to x2 once bars had corners (a histogram's bins, thimble.chart's bars over time,
// stacked or not), and rounded a bar below zero at zero. Each bar is read from Vega's scene: the box it covers and the
// radius of each corner, on the stack group that clips a stacked bar or on the bar itself.
import { parse, View } from 'vega'
import { compile } from 'vega-lite'
import { describe, expect, test } from 'vitest'
import { barEnds } from '../../src/lib/barEnds.ts'
import { vegaConfig } from '../../src/lib/vizTheme.ts'

type Spec = Record<string, unknown>
type Bar = { width: number; height: number; corners: [number, number, number, number]; segments: number }
const R = 2
const field = (name: string, type: string, more: Spec = {}) => ({ field: name, type, title: name, ...more })

/** Each bar the chart draws, in the order of its rows: a stack group (its segments inside it) or a bar of its own. */
async function bars(spec: Spec, patch: (vg: Spec) => Spec = barEnds): Promise<Bar[]> {
  const vg = patch(compile({ ...spec, width: 300, height: 120 } as never, { config: vegaConfig() as never }).spec as never)
  const view = new View(parse(vg as never), { renderer: 'none' })
  await view.runAsync()
  const out: Bar[] = []
  const corner = (it: any, k: string) => Number(it[k] ?? it.cornerRadius ?? 0)
  const of = (it: any, segments: number): Bar => ({
    width: it.width,
    height: it.height,
    corners: [corner(it, 'cornerRadiusTopLeft'), corner(it, 'cornerRadiusTopRight'), corner(it, 'cornerRadiusBottomLeft'), corner(it, 'cornerRadiusBottomRight')],
    segments,
  })
  const rects = (scene: any): number => (scene.items ?? []).reduce((n: number, it: any) => n + (scene.marktype === 'rect' ? 1 : 0) + (it.items ?? []).reduce((m: number, c: any) => m + rects(c), 0), 0)
  const walk = (scene: any) => {
    for (const it of scene.items ?? []) {
      // a stack group: clipped, the corners its whole stack takes
      if (scene.marktype === 'group' && it.clip && scene.name === undefined) {
        out.push(of(it, rects({ items: [{ items: it.items }] })))
        continue
      }
      if (scene.marktype === 'rect' && scene.role === 'mark') out.push(of(it, 1))
      for (const child of it.items ?? []) walk(child)
    }
  }
  walk((view.scenegraph() as unknown as { root: unknown }).root)
  return out
}

// the specs as thimble.chart writes them (backend kernel_thimble), on made-up rows
const BINS = [12, 30, 41, 22, 9, 3].map((count, i) => ({ minutes: i * 20, 'minutes end': i * 20 + 20, count }))
const histogram = { mark: 'bar', encoding: { x: field('minutes', 'quantitative', { bin: { binned: true, step: 20 } }), x2: { field: 'minutes end' }, y: field('count', 'quantitative') } }
const BINNED = ['opus', 'sonnet'].flatMap((model, g) => BINS.map((r) => ({ ...r, count: g ? Math.ceil(r.count / 2) : r.count, model })))
const stackedHistogram = { mark: 'bar', encoding: { ...histogram.encoding, color: field('model', 'nominal') } }
const DAYS = Array.from({ length: 6 }, (_, i) => ({ day: `2026-06-${16 + i}T00:00:00`, 'day end': `2026-06-${17 + i}T00:00:00`, opened: [3, 16, 8, 17, 7, 18][i] }))
const overTime = { mark: { type: 'bar', orient: 'vertical' }, encoding: { x: field('day', 'temporal'), x2: { field: 'day end' }, y: field('opened', 'quantitative') } }
const DAYS_BY = DAYS.flatMap((r) => ['merged', 'closed'].map((outcome, j) => ({ ...r, opened: r.opened - j * 2, outcome })))
const stackedOverTime = { mark: { type: 'bar', orient: 'vertical' }, encoding: { ...overTime.encoding, color: field('outcome', 'nominal') } }
const CHANGE = [{ model: 'opus', change: 0.12 }, { model: 'sonnet', change: -0.04 }]
const horizontal = { mark: 'bar', encoding: { y: field('model', 'nominal'), x: field('change', 'quantitative') } }
const vertical = { mark: 'bar', encoding: { x: field('model', 'nominal'), y: field('change', 'quantitative') } }
// as an agent's Altair writes them: an aggregate, which Vega-Lite draws with no stack group
const summed = { mark: 'bar', encoding: { x: field('model', 'nominal'), y: field('change', 'quantitative', { aggregate: 'sum' }) } }
const summedAcross = { mark: 'bar', encoding: { y: field('model', 'nominal'), x: field('change', 'quantitative', { aggregate: 'sum' }) } }
const MIXED = [{ model: 'opus', task: 'a', change: 3 }, { model: 'opus', task: 'b', change: -2 }, { model: 'sonnet', task: 'a', change: 2 }, { model: 'sonnet', task: 'b', change: 1 }]
const mixed = { mark: 'bar', encoding: { x: field('model', 'nominal'), y: field('change', 'quantitative'), color: field('task', 'nominal') } }

const TOP: Bar['corners'] = [R, R, 0, 0]
const BOTTOM: Bar['corners'] = [0, 0, R, R]
const RIGHT: Bar['corners'] = [0, R, 0, R]
const LEFT: Bar['corners'] = [R, 0, R, 0]

describe('a bar drawn from x to x2', () => {
  for (const [name, spec, rows, n] of [
    ['a histogram', histogram, BINS, 6],
    ['a histogram stacked by group', stackedHistogram, BINNED, 6],
    ['bars over time', overTime, DAYS, 6],
    ['bars over time stacked by group', stackedOverTime, DAYS_BY, 6],
  ] as const)
    test(`${name}: every bar has its width and its height, and its top corners round`, async () => {
      const got = await bars({ data: { values: rows }, ...spec })
      expect(got.length).toBe(n)
      for (const b of got) {
        expect(b.width, JSON.stringify(b)).toBeGreaterThan(10)
        expect(b.height, JSON.stringify(b)).toBeGreaterThan(0)
        expect(b.corners).toEqual(TOP)
      }
      // a stack is round at its top only: its segments are square inside it
      if (spec === stackedHistogram || spec === stackedOverTime) expect(got.every((b) => b.segments === 2)).toBe(true)
    })
})

describe("a bar's round end is the end its value is at", () => {
  test('a vertical bar: the top above zero, the bottom below; across: the right, or the left', async () => {
    for (const spec of [vertical, summed]) expect((await bars({ data: { values: CHANGE }, ...spec })).map((b) => b.corners)).toEqual([TOP, BOTTOM])
    for (const spec of [horizontal, summedAcross]) expect((await bars({ data: { values: CHANGE }, ...spec })).map((b) => b.corners)).toEqual([RIGHT, LEFT])
  })

  test('a stack round at both ends when it holds values either side of zero', async () => {
    const got = await bars({ data: { values: MIXED }, ...mixed })
    expect(got.map((b) => b.corners)).toEqual([[R, R, R, R], TOP])
  })

  test("a bar with a radius of its own keeps it at every corner, a box plot's box stays square, a heatmap's cells too", async () => {
    expect((await bars({ data: { values: CHANGE }, ...summed, mark: { type: 'bar', cornerRadius: 4 } })).map((b) => b.corners)).toEqual([[4, 4, 4, 4], [4, 4, 4, 4]])
    const box = { data: { values: [{ model: 'opus', q1: 3, q3: 7 }] }, mark: { type: 'bar', style: 'thimble-box' }, encoding: { y: field('model', 'nominal'), x: field('q1', 'quantitative'), x2: { field: 'q3' } } }
    expect((await bars(box)).map((b) => b.corners)).toEqual([[0, 0, 0, 0]])
    const heat = { data: { values: MIXED }, mark: 'rect', encoding: { x: field('model', 'nominal'), y: field('task', 'nominal'), color: field('change', 'quantitative') } }
    expect((await bars(heat)).map((b) => b.corners)).toEqual(Array(4).fill([0, 0, 0, 0]))
  })
})

test('barEnds reads nothing outside its own body, so its source draws the same in a custom card frame (lib/frame chartScript)', async () => {
  const copy = new Function(`return ${barEnds.toString()}`)() as typeof barEnds
  for (const [spec, rows] of [[stackedHistogram, BINNED], [summed, CHANGE], [mixed, MIXED]] as const) {
    const vg = compile({ data: { values: rows }, ...spec } as never, { config: vegaConfig() as never }).spec as never
    expect(copy(vg)).toEqual(barEnds(vg))
  }
  expect(barEnds.toString()).not.toMatch(/<\/|<!--/)
})
