// @vitest-environment jsdom
// A quoted passage followed into a file of one long line (a JSON document on one line, a JSON lines record) opens in
// the Raw view with the quoted characters highlighted (src/files/views/raw.tsx): at the block's own offsets when the
// block is the line, else where the line holds the quote, as written or as JSON escapes it. The records are invented.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Reader } from '../../src/files/Reader.tsx'
import { rawSpan, withHighlight } from '../../src/files/views/raw.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { SourceRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const labels = { on: [], all: [], presence: new Map() } as unknown as FilesLabels
const QUOTE = 'their claim is unverifiable'
const LINE = JSON.stringify({ agent: 'w3', messages: Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', text: i === 17 ? `Classic race → ${QUOTE}.` : `step ${i} passed` })) })
const rec = (text: string, block: string): SourceRecord => ({ line: 1, record: { text }, blocks: [{ kind: 'text', text: block }], meta: {} }) as SourceRecord

describe('the quote in a raw line', () => {
  test('at the block offsets when the block is the line, else found as written or as JSON escapes it', () => {
    const at = LINE.indexOf(QUOTE)
    const target = { line: 1, block: 0, start: at, end: at + QUOTE.length }
    expect(rawSpan(rec(LINE, LINE), LINE, target, false)).toEqual([at, at + QUOTE.length])
    // a JSON lines record: the block is the message's text, the line its JSON with the arrow escaped
    const message = `Classic race → ${QUOTE}.`
    const escaped = JSON.stringify({ text: message }).replace('→', '\\u2192')
    const from = message.indexOf('race')
    const span = rawSpan(rec(escaped, message), escaped, { line: 1, block: 0, start: from, end: message.length - 1 }, true)
    expect(span && escaped.slice(...span)).toBe(`race \\u2192 ${QUOTE}`)
    expect(rawSpan(rec(LINE, LINE), LINE, { line: 2, block: 0, start: 1, end: 5 }, false)).toBeNull()
    expect(rawSpan(rec(LINE, LINE), LINE, { line: 1, block: 0 }, false)).toBeNull()
  })

  test('the label segments are cut where the highlight starts and ends', () => {
    const segs = withHighlight([{ text: 'abcdefgh', start: 0 }], [2, 5])
    expect(segs.map((g) => [g.text, !!g.hl])).toEqual([['ab', false], ['cde', true], ['fgh', false]])
    expect(withHighlight([{ text: 'abc', start: 0 }], null)).toEqual([{ text: 'abc', start: 0 }])
  })
})

describe('Reader at a quoted passage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // jsdom lays nothing out and has no scrollIntoView
    Element.prototype.scrollIntoView = () => undefined
    vi.stubGlobal('fetch', async (url: string) => {
      const page = { path: 'run04/w3.json', kind: 'text', total_lines: 1, start: 1, records: [rec(LINE, LINE)] }
      return new Response(JSON.stringify(String(url).includes('/source') ? page : {}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('the Raw view highlights the quoted characters of the one line', async () => {
    const at = LINE.indexOf(QUOTE)
    const el = await mount(<Reader workspace="rivals" path="run04/w3.json" kind="text" targetRef={`run04/w3.json#L1.b0:c${at}-${at + QUOTE.length}`} lead={null} labels={labels} only="raw" />)
    for (let i = 0; i < 4; i++) await settle()
    expect([...el.querySelectorAll('.reader-rawview .hl')].map((h) => h.textContent).join('')).toBe(QUOTE)
  })
})
