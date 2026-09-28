// Citations as the analyst sees them. A value citation names a table cell, found the way the backend's cite.find_td
// finds it (src/lib/tableCell.ts); a line citation of a card's printed output marks the cited line and value; and a
// citation is drawn as a chip (src/components/RefChip.tsx) that keeps a cited value as its text, draws a bare citation
// in the chat's replies, inside a card or in a report as its target's glyph with the full name for the hover and
// assistive tech, and always carries its ref, so it stays a link to the same place.
import { createElement as h, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ChatMarkdown, RefText } from '../../src/chat/markdown.tsx'
import { GlyphCites, RefChip } from '../../src/components/RefChip.tsx'
import { registerCells } from '../../src/lib/cellName.ts'
import { cellWindow, citedLines, locateCell, valueSpan, type Grid } from '../../src/lib/tableCell.ts'
import { Prose } from '../../src/report/Prose.tsx'

// a table as readTable reads a drawn one: the corner, the columns, each row's label and values
const OUTCOMES: Grid = {
  corner: 'outcome',
  cols: ['prs', 'share'],
  rows: [
    { label: 'merged', values: ['212', '0.61'] },
    { label: 'closed', values: ['96', '0.28'] },
    { label: 'open', values: ['37', '0.11'] },
    { label: 'TOTAL', values: ['345', '1.00'] },
  ],
}

describe('the cell a value citation names', () => {
  test('found by its column and its row label, encoded or not', () => {
    expect(locateCell(OUTCOMES, 'prs', 'closed')).toEqual({ r: 1, c: 0 })
    expect(locateCell(OUTCOMES, 'share', 'TOTAL')).toEqual({ r: 3, c: 1 })
    const spaced: Grid = { corner: '', cols: ['review rounds'], rows: [{ label: 'waits, over 2 days apart', values: ['18'] }] }
    expect(locateCell(spaced, 'review%20rounds', 'waits%2C%20over%202%20days%20apart')).toEqual({ r: 0, c: 0 })
    expect(locateCell(OUTCOMES, 'prs', 'missing')).toBeNull()
    expect(locateCell(OUTCOMES, 'nope', 'merged')).toBeNull()
  })
})

// a card's printed output as the backend sends a line citation of it: up to two lines of context each side
const PRINTED = ['            file  lines', '    events.jsonl    880', '     board.jsonl    143', '  agents/a.jsonl     61', '  agents/b.jsonl     58']

const html = (el: ReactElement) => renderToStaticMarkup(el)
const inCard = (el: ReactElement) => html(h(GlyphCites.Provider, { value: true }, el))
const chipName = (markup: string) => /<span class="chip-text">([^<]+)<\/span>/.exec(markup)?.[1]
const TEXT = 'Most reviews came within a day [[logs/run-7.jsonl#L88]], [[31|logs/run-7.jsonl#L90]] of them.'
