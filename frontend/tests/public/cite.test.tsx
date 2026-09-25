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

  test("a row named apart from what its label shows is found by the name, and by what it shows", () => {
    const frame: Grid = { corner: 'day', cols: ['reviews', 'merges'], rows: [{ label: '5,500', key: '5500', values: ['41', '3,120'] }, { label: '6,000', key: '6000', values: ['40', '2'] }] }
    expect(locateCell(frame, 'merges', '5500')).toEqual({ r: 0, c: 1 })
    expect(locateCell(frame, 'reviews', '6,000')).toEqual({ r: 1, c: 0 })
  })

  test('in a table numbered 0, 1, 2, a row is named by its key column; a column of numbers or repeats names none', () => {
    const agents: Grid = {
      corner: '',
      cols: ['agent', 'reviews', 'state'],
      rows: [
        { label: '0', values: ['agent-01', '14', 'done'] },
        { label: '1', values: ['agent-02', '9', 'done'] },
        { label: '2', values: ['agent-03', '11', 'idle'] },
      ],
    }
    expect(locateCell(agents, 'reviews', 'agent-02')).toEqual({ r: 1, c: 1 })
    expect(locateCell(agents, 'reviews', '2')).toEqual({ r: 2, c: 1 })
    const numbers: Grid = { corner: '', cols: ['n', 'm'], rows: [{ label: '0', values: ['5', 'x'] }, { label: '1', values: ['6', 'x'] }] }
    expect(locateCell(numbers, 'm', '5')).toBeNull()
  })

  test("the hover's window: two rows each side and four columns, the cell in the middle where the table allows", () => {
    const wide: Grid = { corner: '', cols: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], rows: Array.from({ length: 12 }, (_, i) => ({ label: String(i), values: Array(7).fill('1') })) }
    expect(cellWindow(wide, { r: 6, c: 3 })).toEqual({ rows: [4, 5, 6, 7, 8], cols: [2, 3, 4, 5] })
    expect(cellWindow(wide, { r: 0, c: 0 })).toEqual({ rows: [0, 1, 2, 3, 4], cols: [0, 1, 2, 3] })
    expect(cellWindow(wide, { r: 11, c: 6 })).toEqual({ rows: [7, 8, 9, 10, 11], cols: [3, 4, 5, 6] })
    expect(cellWindow(OUTCOMES, { r: 1, c: 0 })).toEqual({ rows: [0, 1, 2, 3], cols: [0, 1] })
  })
})

// a card's printed output as the backend sends a line citation of it: up to two lines of context each side
const PRINTED = ['            file  lines', '    events.jsonl    880', '     board.jsonl    143', '  agents/a.jsonl     61', '  agents/b.jsonl     58']

describe('a line citation of printed output', () => {
  test('the cited line is found where the backend put it in the excerpt, and none when it is gone', () => {
    expect(citedLines(PRINTED.slice(0, 4).join('\n'), PRINTED[1], 2)).toEqual({ lines: PRINTED.slice(0, 4), from: 1, to: 1 })
    expect(citedLines(PRINTED.join('\n'), PRINTED[2], 3)).toEqual({ lines: PRINTED, from: 2, to: 2 })
    expect(citedLines(PRINTED.join('\n'), PRINTED.slice(1, 3).join('\n'), 2)).toEqual({ lines: PRINTED, from: 1, to: 2 })
    expect(citedLines(['a', 'b', 'x', 'c', 'x'].join('\n'), 'x', 40)).toEqual({ lines: ['a', 'b', 'x', 'c', 'x'], from: 2, to: 2 })
    expect(citedLines(PRINTED.join('\n'), '   not printed', 2)).toBeNull()
    expect(citedLines(PRINTED.join('\n'), '  ', 2)).toBeNull()
  })

  test('the value is marked in its line, a number with or without its commas, never as part of a longer number', () => {
    expect(valueSpan(PRINTED[1], '880')).toEqual([20, 23])
    expect(valueSpan('merged  12266  prs', '12,266')).toEqual([8, 13])
    expect(valueSpan('total 1,086 reviews', '1086')).toEqual([6, 11])
    expect(valueSpan(PRINTED[1], '88')).toBeNull()
    expect(valueSpan(PRINTED[1], 'board')).toBeNull()
    expect(valueSpan('the tidepool repo', 'tidepool')).toEqual([4, 12])
  })
})

const html = (el: ReactElement) => renderToStaticMarkup(el)
const inCard = (el: ReactElement) => html(h(GlyphCites.Provider, { value: true }, el))
const chipName = (markup: string) => /<span class="chip-text">([^<]+)<\/span>/.exec(markup)?.[1]
const TEXT = 'Most reviews came within a day [[logs/run-7.jsonl#L88]], [[31|logs/run-7.jsonl#L90]] of them.'

describe('chips', () => {
  test("a card's chip that lists what a step made shows its name; its citation is the glyph alone, named for assistive tech", () => {
    registerCells([{ id: 'abcd1234', title: 'How many pull requests merged?' }])
    const made = html(<RefChip workspace="w" ref="card:abcd1234" />)
    const cited = html(<RefChip workspace="w" ref="card:abcd1234" cite />)
    const name = chipName(made)
    expect(name).toBeTruthy()
    expect(made).not.toContain('refchip-icon')
    expect(cited).toContain('refchip-icon')
    expect(cited).toContain(`aria-label="${name}"`)
    expect(cited).not.toContain('chip-text')
    // a citation that keeps its name (a check's evidence in the report's margin) wears its target's glyph, a file's for
    // a record, never the quote glyph
    const named = html(<RefChip workspace="w" ref="logs/run-7.jsonl#L88" cite />)
    expect(chipName(named)).toBe('logs › run-7.jsonl L88')
    expect(named).toContain('icon-file')
    expect(named).not.toContain('icon-cite')
    expect(html(<RefChip workspace="w" ref="card:abcd1234#outcome/merged" value="31" cite />)).toMatch(/>31</)
  })

  test("in the chat's replies, as in a card, a bare citation is its target's glyph with its name, the file's extension kept, in the hover; a cited number stays its text", () => {
    const full = chipName(html(<RefChip workspace="w" ref="logs/run-7.jsonl#L88" />))
    expect(full).toBe('logs › run-7.jsonl L88')
    for (const shown of [html(<ChatMarkdown text={TEXT} />), inCard(<ChatMarkdown text={TEXT} />)]) {
      expect(shown).toMatch(/refchip-citation refchip-icon/)
      expect(shown).not.toContain('chip-text')
      expect(shown).toContain('icon-file')
      expect(shown).not.toContain('icon-cite')
      expect(shown).toContain(`aria-label="${full}"`)
      expect(shown).toContain('data-ref="logs/run-7.jsonl#L88"')
      expect(shown).toMatch(/refchip-value[^>]*>31</)
    }
    // the model's aside (a `say` chip) is prose too
    const aside = html(<RefText text={TEXT} workspace="w" cite />)
    expect(aside).toMatch(/refchip-citation refchip-icon/)
    expect(aside).toContain(`aria-label="${full}"`)
    // the analyst's own text keeps the chip's name
    expect(chipName(html(<RefText text={TEXT} workspace="w" />))).toBe(full)
  })

  test("a report's text draws a bare citation as the glyph, as a card does, and keeps a cited number as its text", () => {
    const full = chipName(html(<RefChip workspace="w" ref="logs/run-7.jsonl#L88" />))
    const prose = html(<Prose ws="w" slug="report" sentences={[{ id: 's1', text: TEXT, refs: [], tags: [] }]} />)
    expect(prose).toMatch(/refchip-citation refchip-icon/)
    expect(prose).not.toContain('chip-text')
    expect(prose).toContain(`aria-label="${full}"`)
    expect(prose).toContain('data-ref="logs/run-7.jsonl#L88"')
    expect(prose).toMatch(/refchip-value[^>]*>31</)
  })
})
