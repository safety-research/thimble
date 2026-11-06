// Which representation of a bundle a card draws (src/components/Outputs.tsx pickMime): an error first, and a picture or
// a chart before its text. What a card draws that a document can show as a figure (figureKind).
import { compile } from 'vega-lite'
import { describe, expect, test } from 'vitest'
import { ERROR_MIME, figureKind, pickMime, primaryArtifact } from '../../src/components/Outputs.tsx'
import { FRAME_MIME } from '../../src/lib/dataFrame.ts'
import { fitAfterCompile, responsive } from '../../src/lib/vegaDraw.ts'
import type { Cell, MimeBundle } from '../../src/lib/types.ts'
import { cardShape } from '../../src/report/cards.ts'
import { figureCandidates } from '../../src/report/model.ts'

const bundle = (b: object) => b as MimeBundle

describe('which representation a bundle shows', () => {
  test('an error first, then a drawing, a frame, a picture or a chart before html, markdown, json and plain text', () => {
    expect(pickMime(bundle({ [ERROR_MIME]: { ename: 'E' }, 'text/plain': 'x' }))).toBe(ERROR_MIME)
    expect(pickMime(bundle({ 'application/vnd.thimble.diagram+json': {}, 'text/plain': 'x' }))).toBe('application/vnd.thimble.diagram+json')
    expect(pickMime(bundle({ [FRAME_MIME]: {}, 'text/html': '<table></table>', 'text/plain': 'x' }))).toBe(FRAME_MIME)
    for (const mime of ['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(pickMime(bundle({ [mime]: 'AAAA', 'text/plain': '<Figure>' })), mime).toBe(mime)
    expect(pickMime(bundle({ 'application/vnd.vegalite.v5+json': {}, 'text/html': '<div></div>' }))).toBe('application/vnd.vegalite.v5+json')
    expect(pickMime(bundle({ 'text/html': '<b>x</b>', 'text/markdown': '**x**', 'text/plain': 'x' }))).toBe('text/html')
    expect(pickMime(bundle({ 'text/markdown': '**x**', 'text/plain': 'x' }))).toBe('text/markdown')
    expect(pickMime(bundle({ 'application/x-unknown': 1 }))).toBeNull()
  })
})

describe('what a card draws as a figure', () => {
  // Every card that draws a figure is one
  // a document can show (backend material.figure_kind), and the picker and the sidebar's glyph read the same test.
  const card = (c: Partial<Cell>) => ({ id: 'c', notebook: 'n', title: 'q', created_by: 'a', ts: '', kind: 'code', ...c }) as Cell
  const timeline = card({ kind: 'timeline', code: 'thimble.timeline(evs)', outputs: [bundle({ 'application/vnd.thimble.timeline+json': { events: [] }, 'text/plain': 'x' })] })
  const diagram = card({ kind: 'diagram', payload: { dataset: { nodes: ['a'], edges: [] } } })
  const custom = card({ kind: 'custom', payload: { html: '<svg></svg>' } })
  const plot = card({ kind: 'plot', outputs: [bundle({ 'image/png': 'AAAA' })] })
  const table = card({ kind: 'table', outputs: [bundle({ [FRAME_MIME]: {}, 'text/plain': 'x' })] })
  const note = card({ kind: 'note', payload: { text: 'words' } })
  const printed = card({ kind: 'code', outputs: [bundle({ 'text/plain': '27', _stream: 'stdout' })] })
  test('a timeline or a diagram, from code or a dataset, a custom page, a chart and a table; not a note or a print', () => {
    expect([timeline, diagram, custom, plot, table, note, printed].map(figureKind)).toEqual(['timeline', 'diagram', 'custom', 'chart', 'table', null, null])
    expect(figureKind(card({ kind: 'custom', payload: { html: ' ' } }))).toBeNull()
  })
  test('the picker offers each, and the sidebar draws each as a figure', () => {
    expect(figureCandidates([timeline, note, diagram, printed, custom], figureKind)).toEqual([timeline, diagram, custom])
    expect(['timeline', 'diagram', 'custom', 'chart', 'table', null].map(cardShape)).toEqual(['bars', 'bars', 'bars', 'bars', 'table', 'text'])
  })
})

describe('a composite chart fitted to its room', () => {
  test('moves a mark placed at the view\'s designed right edge with the view', () => {
    const view = (title: string) => ({
      title, width: 640, height: 100,
      layer: [
        { mark: 'point', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'n', type: 'quantitative' } } },
        { mark: { type: 'text', align: 'right' }, encoding: { text: { value: 'limit' }, x: { value: 640 }, y: { value: 10 } } },
      ],
    })
    const spec = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', vconcat: [view('a'), view('b')] }
    const fitted = responsive(spec, 391) as { vconcat: { width: number; layer: { encoding: { x: { value?: number } } }[] }[] }
    for (const v of fitted.vconcat) {
      expect(v.width).toBeLessThan(640)
      expect(v.layer[1].encoding.x.value).toBe(v.width)
    }
  })
})

describe("a chart fitted to its box", () => {
  // as every chart that is no composite is fitted (responsive's container width and fit-x): a bar chart of named
  // categories, whose rows Vega-Lite sizes by a step, a line chart, and a bar chart over a layer of notes
  const VL = 'https://vega.github.io/schema/vega-lite/v6.json'
  const names = responsive({ $schema: VL, data: { values: [{ agent: 'a1', n: 3 }, { agent: 'a2', n: 5 }] }, mark: 'bar', encoding: { y: { field: 'agent', type: 'nominal' }, x: { field: 'n', type: 'quantitative' } } })
  const line = responsive({ $schema: VL, data: { values: [{ t: 1, n: 3 }, { t: 2, n: 5 }] }, mark: 'line', encoding: { x: { field: 't', type: 'quantitative' }, y: { field: 'n', type: 'quantitative' } } })
  const noted = responsive({ $schema: VL, layer: [{ data: { values: [{ agent: 'a1', n: 3 }] }, mark: 'bar', encoding: { y: { field: 'agent', type: 'nominal' }, x: { field: 'n', type: 'quantitative' } } }, { data: { values: [{ agent: 'a1', note: 'top' }] }, mark: 'text', encoding: { y: { field: 'agent', type: 'nominal' }, text: { field: 'note' } } }] })
  const logger = (into: unknown[]) => {
    const log = { level: () => log, error: (...args: unknown[]) => (into.push(...args), log), info: () => log, debug: () => log, warn: (...args: unknown[]) => (into.push(...args), log) }
    return log as never
  }

  test('is compiled with nothing for Vega-Lite to warn about, and draws as the spec as written compiles', () => {
    for (const spec of [names, line, noted]) {
      const before: unknown[] = []
      const asWritten = compile(spec as never, { logger: logger(before) }).spec
      const warned: unknown[] = []
      const { spec: given, patch } = fitAfterCompile(spec)
      const vg = patch(compile(given as never, { logger: logger(warned) }).spec as never) as { autosize?: unknown }
      expect(warned).toEqual([])
      expect(vg).toEqual(asWritten)
      expect(vg.autosize).toEqual({ type: 'fit-x', contains: 'padding' })
      // the spec as written warns, for rows sized by a step, though the fit it drops is not the chart's
      expect(before).toEqual(spec === line ? [] : ['Dropping "fit-y" because spec has discrete height.'])
    }
  })

  test('a chart that sets its own fit, or a composite, is given as it is', () => {
    const own = { ...(names as object), autosize: 'fit' }
    const composite = responsive({ $schema: VL, vconcat: [{ mark: 'bar' }, { mark: 'bar' }] }, 400)
    for (const spec of [own, composite]) {
      const { spec: given, patch } = fitAfterCompile(spec)
      expect(given).toBe(spec)
      const vg = { width: 400 }
      expect(patch(vg)).toBe(vg)
    }
  })
})
