// The report's card sidebar (src/report/cards.ts): a writer's figure lists under Figures. A writer's card stands loose on
// the canvas, stamped with the writer's session, and so does one in a writer's own group from an earlier workspace;
// every other card lists under Your work.
import { expect, test } from 'vitest'
import { cardSections } from '../../src/report/cards.ts'
import type { Cell, Group } from '../../src/lib/types.ts'

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const card = (id: string, notebook: string, extra: Partial<Cell> = {}): Cell => ({ id, notebook, kind: 'note', title: `${id}?`, takeaway: '', created_by: 'terminal', ts: '', ...extra }) as Cell

test("a writer's card is a figure wherever it stands, and main's loose card is the analyst's work", () => {
  const groups = [group('l', { kind: 'loose' }), group('w', { session: 'writer:report' }), group('s')]
  const cells = [
    card('mine', 'l'),
    card('fig', 'l', { session: 'writer:report', created_by: 'chat:w1' }),
    card('old', 'w', { created_by: 'chat:w1' }),
    card('seq', 's'),
  ]
  const by = Object.fromEntries(cardSections(cells, groups).map((s) => [s.key, s.cards.map((c) => c.id)]))
  expect(by).toEqual({ starred: [], figures: ['fig', 'old'], yours: ['mine', 'seq'] })
})
