// Which representation of a bundle a card draws (src/components/Outputs.tsx pickMime): an error first, and a picture or
// a chart before its text. A card type's graphic is the card's chart, drawn by the type's frame, and a citation of one
// of its listing's lines opens the record that ends the line (src/canvas/TypeCard.tsx). What a card draws that a
// document can show as a figure (figureKind).
import { describe, expect, test } from 'vitest'
import { ERROR_MIME, pickMime } from '../../src/components/Outputs.tsx'
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
