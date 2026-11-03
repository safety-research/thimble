// @vitest-environment jsdom
// The Report's sidebar (src/report/Sidebar.tsx): the card search, then Starred, Figures and Your work, and no Comments
// pane; the report's checks and comments open from the top bar's Comments (shell/LabelsSidebar.tsx).
import { afterEach, expect, test } from 'vitest'
import { Sidebar } from '../../src/report/Sidebar.tsx'
import type { Cell, Group } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(unmountAll)

const T = '2026-05-16T09:00:00.000+00:00'
const cell = (id: string, title: string, starred = false) =>
  ({ id, notebook: 'g1', kind: 'plot', title, takeaway: '', created_by: 'main', created_ts: T, ts: T, status: 'ok', code: '', outputs: [], starred }) as unknown as Cell
const GROUPS = [{ id: 'g1', title: 'Edits', role: 'exploration', parent: null }] as unknown as Group[]

test('the sidebar lists the cards in Starred, Figures and Your work, with no Comments pane', async () => {
  const cells = [cell('c1', 'When did the edits happen?', true), cell('c2', 'Which files changed most?')]
  const el = await mount(<Sidebar ws="w1" cells={cells} groups={GROUPS} used={new Set(['c1'])} onInsert={() => undefined} onHide={() => undefined} over={false} />)
  expect([...el.querySelectorAll('.wu-sec')].map((s) => s.getAttribute('data-section'))).toEqual(['starred', 'figures', 'yours'])
  expect([...el.querySelectorAll('.wu-sec-name')].map((n) => n.textContent)).toEqual(['Starred', 'Figures', 'Your work'])
  expect(el.querySelector('.wu-checks')).toBeNull()
  expect(el.querySelector('[aria-label="Comments"]')).toBeNull()
  expect(el.querySelector('[aria-label="New check"]')).toBeNull()
})
