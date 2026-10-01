// Which representation of a bundle a card draws (src/components/Outputs.tsx pickMime): an error first, and a picture or
// a chart before its text. A card type's graphic is the card's chart, drawn by the type's frame, and a citation of one
// of its listing's lines opens the record that ends the line (src/canvas/TypeCard.tsx).
import { describe, expect, test } from 'vitest'
import { citedRecord } from '../../src/canvas/TypeCard.tsx'
import { CARD_MIME, ERROR_MIME, pickMime, primaryArtifact, responsive } from '../../src/components/Outputs.tsx'
import { FRAME_MIME } from '../../src/lib/dataFrame.ts'
import type { MimeBundle } from '../../src/lib/types.ts'

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
