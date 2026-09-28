// What a card draws from what its code emitted (src/components/Outputs.tsx, src/lib/dataFrame.ts,
// src/canvas/FrameTable.tsx, src/lib/chartDefaults.ts, src/lib/media.ts). Each bundle shows one representation, the
// picture before its text; a card shows its chart, else its table, else its error, else its shell output; the frame a
// table card ends in is drawn as thimble's table with its numbers in the backend's formats; the chart defaults never
// change the spec they were given; a chart of a label's classes draws them in the label's colours; and the formats the
// backend writes are the ones drawn here.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { DRAWING_MIMES, ERROR_MIME, inkSmallNominal, onPaper, pickMime, primaryArtifact } from '../../src/components/Outputs.tsx'
import { tableModel } from '../../src/canvas/FrameTable.tsx'
import { chartDefaults } from '../../src/lib/chartDefaults.ts'
import { asFrame, cellText, FRAME_MIME, formatter, type Frame } from '../../src/lib/dataFrame.ts'
import { mediaOf, mediaUrl, seconds } from '../../src/lib/media.ts'
import type { MimeBundle } from '../../src/lib/types.ts'

const BACKEND = path.resolve(__dirname, '../../../backend/app')
const py = (file: string) => readFileSync(path.join(BACKEND, file), 'utf8')
const bundle = (b: object) => b as MimeBundle

/** A frame as backend/app/frames.py stores one. */
const frame = (columns: string[], types: Record<string, string>, rows: unknown[][], extra: Record<string, any> = {}) => ({
  columns,
  types,
  index: null,
  label: null,
  rows,
  total: rows.length,
  ...extra,
  view: { columns: columns.filter((c) => c !== extra.label), formats: {}, more: 0, ...(extra.view ?? {}) },
})

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
