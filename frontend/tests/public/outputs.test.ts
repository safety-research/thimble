// Which representation of a bundle a card draws (src/components/Outputs.tsx pickMime): an error first, and a picture or
// a chart before its text. A card type's graphic is the card's chart, drawn by the type's frame, and a citation of one
// of its listing's lines opens the record that ends the line (src/canvas/TypeCard.tsx). What a card draws that a
// document can show as a figure (figureKind).
import * as vega from 'vega'
import { compile } from 'vega-lite'
import { describe, expect, test, vi } from 'vitest'
import { citedRecord } from '../../src/canvas/TypeCard.tsx'
import { CARD_MIME, ERROR_MIME, figureKind, pickMime, primaryArtifact, responsive } from '../../src/components/Outputs.tsx'
import { FRAME_MIME } from '../../src/lib/dataFrame.ts'
import { chartLogger, FIT_Y_DROPPED } from '../../src/lib/vegaDraw.ts'
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

describe("a card type's graphic", () => {
  const made = bundle({ [CARD_MIME]: { type: 'swarm', data: {} }, 'text/plain': 'swarm: 3 records\n#1 02:14 kestrel T1 wiki/a: saved wiki/a.jsonl#L88' })
  test('is the chart a card shows, and elsewhere its listing', () => {
    expect(primaryArtifact([bundle({ 'text/plain': 'x', _stream: 'stdout' }), made])).toEqual({ bundle: made, kind: 'chart' })
    expect(pickMime(made)).toBe('text/plain')
  })
  test('a hovered citation names a record: its own ref, or the one ending a cited line of the listing', () => {
    const listing = String(made['text/plain'])
    expect(citedRecord('card:c7@out1#L2', 'c7', 1, listing)).toBe('wiki/a.jsonl#L88')
    expect(citedRecord('card:c7@out1#L1', 'c7', 1, listing)).toBeNull()
    expect(citedRecord('card:c8@out1#L2', 'c7', 1, listing)).toBeNull()
    expect(citedRecord('chat/help.jsonl#L4', 'c7', 1, listing)).toBe('chat/help.jsonl#L4')
  })
})

describe('what a card draws as a figure', () => {
  // Matt: "why can a timeline card not be used in a document? that seems silly". Every card that draws a figure is one
  // a document can show (backend material.figure_kind), and the picker and the sidebar's glyph read the same test.
  const card = (c: Partial<Cell>) => ({ id: 'c', notebook: 'n', title: 'q', created_by: 'a', ts: '', kind: 'code', ...c }) as Cell
  const timeline = card({ kind: 'timeline', code: 'thimble.timeline(evs)', outputs: [bundle({ 'application/vnd.thimble.timeline+json': { events: [] }, 'text/plain': 'x' })] })
  const diagram = card({ kind: 'diagram', payload: { dataset: { nodes: ['a'], edges: [] } } })
  const custom = card({ kind: 'custom', payload: { html: '<svg></svg>' } })
  const typed = card({ kind: 'plot', outputs: [bundle({ [CARD_MIME]: { type: 'swarm', data: {} }, 'text/plain': 'swarm' })] })
  const plot = card({ kind: 'plot', outputs: [bundle({ 'image/png': 'AAAA' })] })
  const table = card({ kind: 'table', outputs: [bundle({ [FRAME_MIME]: {}, 'text/plain': 'x' })] })
  const note = card({ kind: 'note', payload: { text: 'words' } })
  const printed = card({ kind: 'code', outputs: [bundle({ 'text/plain': '27', _stream: 'stdout' })] })
  test('a timeline or a diagram, from code or a dataset, a card type, a custom page, a chart and a table; not a note or a print', () => {
    expect([timeline, diagram, custom, typed, plot, table, note, printed].map(figureKind)).toEqual(['timeline', 'diagram', 'custom', 'chart', 'chart', 'table', null, null])
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

describe("a chart's log", () => {
  // a bar chart of named categories, fitted to its box as every chart that is no composite is (responsive's fit-x)
  const names = responsive({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values: [{ agent: 'a1', n: 3 }, { agent: 'a2', n: 5 }] }, mark: 'bar', encoding: { y: { field: 'agent', type: 'nominal' }, x: { field: 'n', type: 'quantitative' } } })

  test("Vega-Lite's one warning for a fitted chart with names down its y axis drops nothing: the chart keeps fit-x", () => {
    const warned: unknown[] = []
    const log = { level: () => log, error: () => log, info: () => log, debug: () => log, warn: (...args: unknown[]) => (warned.push(...args), log) }
    const vg = compile(names as never, { logger: log as never }).spec as { autosize?: unknown }
    expect(warned).toEqual([FIT_Y_DROPPED])
    expect(vg.autosize).toEqual({ type: 'fit-x', contains: 'padding' })
  })

  test('the logger a chart is drawn with leaves that warning out and writes every other one as Vega does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const log = chartLogger(vega) as vega.LoggerInterface
      log.warn(FIT_Y_DROPPED)
      expect(warn).not.toHaveBeenCalled()
      log.warn('Conflicting axis property "format" (",~r" and ",d"). Using ",~r".')
      expect(warn).toHaveBeenCalledWith('WARN', 'Conflicting axis property "format" (",~r" and ",d"). Using ",~r".')
      // vega-embed sets its level through it, as with vega's own
      expect(log.level(0)).toBe(log)
      log.warn('anything')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
