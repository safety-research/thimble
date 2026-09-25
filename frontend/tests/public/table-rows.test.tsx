// @vitest-environment jsdom
// The Table view (src/files/views/table.tsx) draws only the rows near its view, with an empty row standing for the
// rest, and sizes each column by the widest text among all the records loaded, which its header cell holds. jsdom
// has no layout, so the view has no size and the first rows are drawn. The records are invented.
import { afterEach, describe, expect, test } from 'vitest'
import { columnChars, shownChars, Table } from '../../src/files/views/table.tsx'
import type { SourcePage } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

const PATH = 'wiki/edits.jsonl'
const records = Array.from({ length: 500 }, (_, i) => ({
  line: i + 1,
  record: { user: i === 420 ? 'LongestUserNameInTheFile' : `u${i}`, edits: i, note: i === 7 ? 'a  b\n\nc' : 'short note that runs past forty characters here' },
  blocks: [],
  meta: {},
}))
const page = { path: PATH, kind: 'events', total_lines: 500, start: 1, records } as unknown as SourcePage

afterEach(unmountAll)

describe('rows drawn in the Table view', () => {
  test('a cell counts its white space runs once and stops at its cut', () => {
    expect(shownChars('a  b\n\nc', 20)).toBe(5)
    expect(shownChars('  padded  ', 20)).toBe(6)
    expect(shownChars('x'.repeat(500), 44)).toBe(44)
    expect(shownChars(' '.repeat(300) + 'end', 20)).toBe(3)
  })

  test('the columns take the widest text of any record, mono cells apart', () => {
    const w = columnChars(records, ['user', 'edits', 'note'], new Set(['note']))
    expect(w[0]).toEqual([0, 20])
    expect(w[1]).toEqual([3, 0])
    expect(w[2]).toEqual([0, 44])
  })

  test('only the first rows are drawn, then one empty row; the header holds the widths', async () => {
    const el = await mount(<Table workspace="w" path={PATH} kind="events" page={page} loadMore={() => {}} />)
    const rows = [...el.querySelectorAll<HTMLElement>('tbody tr')]
    const drawn = rows.filter((r) => r.classList.contains('reader-table-row'))
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThan(100)
    expect(drawn[0].dataset.line).toBe('1')
    expect(rows[rows.length - 1].classList.contains('reader-table-pad')).toBe(true)
    const sizes = [...el.querySelectorAll<HTMLElement>('thead th .reader-table-size')].map((s) => s.style.width)
    expect(sizes).toContain('20ch')
    expect(el.querySelector<HTMLElement>('thead .reader-table-digits')?.style.width).toBe('3ch')
  })
})
