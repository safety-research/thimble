// @vitest-environment jsdom
// What thimble draws above a view (src/files/ViewChrome.tsx): the residue line says what the view leaves out by kind,
// opens the list of it under the head, and says how many files it read when there is none; the derived data names its
// counts and lists the fields of each kind of record under its name, the computed ones first.
import { act, useState } from 'react'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { ResidueList, ViewNotesLine, type ViewNotes } from '../../src/files/ViewChrome.tsx'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  // the derived data's popover places itself as it resizes; jsdom has no ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(unmountAll)

const NOTES: ViewNotes = {
  shown: {
    files: 6,
    not_shown: {
      count: 4,
      unexplained: 3,
      files: [
        { path: 'runs/r2/events.jsonl', size: 900, read: 0, why: '', claimed: false },
        { path: 'runs/r1/big.jsonl', size: 900, read: 300, why: '' },
        { path: 'notes.md', size: 40, read: 0, why: 'an index of the notes' },
      ],
    },
    missing: [
      { path: 'logs/*.log', why: 'no file matches it' },
      { path: 'runs/r3/manifest.json', why: 'the other folders have it' },
    ],
    unplaced: { count: 2, examples: [{ ref: 'runs/r1/big.jsonl#L4', why: 'no time' }] },
    derived: [
      { field: 'time', from: 'ts', how: 'parsed to UTC' },
      { field: 'outcome', from: 'exit and result', how: 'ok, error or denied', kind: 'inferred' },
    ],
    errors: [],
  },
  problems: { count: 3, examples: [{ ref: 'runs/r1/big.jsonl#L9', why: 'not JSON' }] },
}

function Head({ notes, picked }: { notes: ViewNotes; picked: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <ViewNotesLine ws="ws" name="Runs" notes={notes} shownLabels={[]} residueOpen={open} onResidue={() => setOpen((o) => !o)} />
      {open && <ResidueList notes={notes} onPick={(ref) => picked.push(ref)} />}
    </div>
  )
}

test('the residue line counts what the view leaves out and opens the list of it', async () => {
  const picked: string[] = []
  const el = await mount(<Head notes={NOTES} picked={picked} />)
  const line = el.querySelector('.view-pane-residue') as HTMLButtonElement
  expect(line.textContent).toBe('3 files not read · 1 hidden · 2 missing · 2 records not placed · 3 unreadable lines')
  expect(line.querySelector('span'), 'the unreadable lines in the same ink as the rest').toBeNull()
  expect(el.querySelector('.view-pane-residue-list')).toBeNull()
  await act(async () => line.click())
  const list = el.querySelector('.view-pane-residue-list') as HTMLElement
  expect([...list.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Not read', 'Hidden', 'Missing', 'Not placed', 'Unreadable'])
  expect(list.textContent).toContain('the other folders have it')
  expect(list.textContent).toContain('not claimed')
  expect(list.textContent).toContain('and 1 more')
  expect(list.textContent).toContain('an index of the notes')
  expect(list.textContent).toContain('no file matches it')
  await act(async () => (list.querySelector('.view-pane-list-item') as HTMLButtonElement).click())
  expect(picked).toEqual(['runs/r2/events.jsonl'])
  const derived = [...el.querySelectorAll('.view-pane-files')].find((b) => b.textContent?.startsWith('Derived')) as HTMLButtonElement
  expect(derived.textContent).toBe('Derived data: 2 fields, 1 computed')
  await act(async () => derived.click())
  const rows = [...document.querySelectorAll('.view-pane-list-row .mono')].map((x) => x.textContent)
  expect(rows.slice(-2)).toEqual(['outcome', 'time'])
  expect(document.querySelector('.view-pane-list-head'), 'fields that name no kind of record have no heading').toBeNull()
})

test('the derived data lists a field of each kind of record that holds it, under the kind', async () => {
  const derived = [
    { record: 'pull request', field: 'state', from: 'its merge and close', how: 'open, merged or closed', kind: 'inferred' as const },
    { record: 'pull request', field: 'closes', from: 'fixes', how: 'the first number in it' },
    { record: 'issue', field: 'state', from: 'its close and the pull requests that fix it', how: 'fixed once one merged', kind: 'inferred' as const },
    { record: 'issue', field: 'area', from: 'labels', how: 'the first label' },
  ]
  const notes: ViewNotes = { shown: { files: 2, not_shown: { count: 0, unexplained: 0, files: [] }, missing: [], derived, errors: [] }, problems: { count: 0, examples: [] } }
  const el = await mount(<Head notes={notes} picked={[]} />)
  const button = [...el.querySelectorAll('.view-pane-files')].find((b) => b.textContent?.startsWith('Derived')) as HTMLButtonElement
  expect(button.textContent).toBe('Derived data: 4 fields, 2 computed')
  await act(async () => button.click())
  const groups = [...document.querySelectorAll('.view-pane-list-group')].slice(-2)
  expect(groups.map((g) => g.querySelector('.view-pane-list-head')?.textContent)).toEqual(['Per pull request', 'Per issue'])
  expect(groups.map((g) => [...g.querySelectorAll('.view-pane-list-row .mono')].map((x) => x.textContent))).toEqual([
    ['state', 'closes'],
    ['state', 'area'],
  ])
  expect(groups[1].textContent).toContain('fixed once one merged')
})

test('a view that leaves nothing out says so, and has no list to open', async () => {
  const notes: ViewNotes = { shown: { files: 2, not_shown: { count: 0, unexplained: 0, files: [] }, missing: [], derived: [], errors: [] }, problems: { count: 0, examples: [] } }
  const el = await mount(<Head notes={notes} picked={[]} />)
  expect(el.querySelector('.view-pane-residue')).toBeNull()
  expect(el.querySelector('.view-pane-residue-none')?.textContent).toBe('All 2 files read')
  const list = await mount(<ResidueList notes={notes} onPick={() => undefined} />)
  expect(list.innerHTML).toBe('')
})
