// The report sidebar's sections (report/cards.ts): a writer's figures, in the root group stamped with its session and
// any group under it, list under Figures, never under Your work.
import { describe, expect, test } from 'vitest'
import type { Cell, Group } from '../../src/lib/types.ts'
import { cardSections } from '../../src/report/cards.ts'

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const cell = (id: string, notebook: string) => ({ id, notebook, title: `card ${id}`, takeaway: '' }) as unknown as Cell

describe("the report sidebar's sections", () => {
  test("a writer's figures list under Figures, the analyst's under Your work, the deck's under Orientation", () => {
    const groups = [
      group('yours'),
      group('deck', { role: 'exploration' }),
      group('figs', { session: 'writer:report' }),
      group('sub', { parent: 'figs' }),
    ]
    const cells = [cell('a', 'yours'), cell('b', 'deck'), cell('c', 'figs'), cell('d', 'sub')]
    const byKey = Object.fromEntries(cardSections(cells, groups).map((s) => [s.key, s.cards.map((c) => c.id)]))
    expect(byKey).toEqual({ starred: [], orientation: ['b'], figures: ['c', 'd'], yours: ['a'] })
    expect(cardSections(cells, groups).map((s) => s.name)).toEqual(['Starred', 'Orientation', 'Figures', 'Your work'])
  })
})
