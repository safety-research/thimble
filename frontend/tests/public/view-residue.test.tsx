// @vitest-environment jsdom
// What thimble draws above a view (src/files/ViewChrome.tsx): one line under the name says what the view leaves out by
// kind, each part opening the list of it under the head, and says it read all its files when it leaves nothing out; the
// derived data names its counts and lists the fields of each kind of record under its name, the computed ones first. A
// file viewer's line speaks only of the file it shows, and of nothing when that file reads cleanly.
import { act, useState } from 'react'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { ResidueList, ViewHeadLine, type ViewNotes } from '../../src/files/ViewChrome.tsx'
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

function Head({ notes, picked, file = false, files }: { notes: ViewNotes; picked: string[]; file?: boolean; files?: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <ViewHeadLine ws="ws" name="Runs" notes={notes} shownLabels={[]} residueOpen={open} onResidue={() => setOpen((o) => !o)} file={file} files={files ? { list: files, n: files.length, current: null, onPick: () => undefined } : undefined} />
      {open && <ResidueList notes={notes} onPick={(ref) => picked.push(ref)} />}
    </div>
  )
}

test('the line counts what the view leaves out and each part opens the list of it', async () => {
  const picked: string[] = []
  const el = await mount(<Head notes={NOTES} picked={picked} files={['runs/r1/big.jsonl', 'notes.md']} />)
  expect(el.querySelector('.view-pane-sub')?.textContent).toBe('2 files·3 not read·1 hidden·2 missing·2 records not placed·3 unreadable lines·Derived data: 2 fields')
  const parts = [...el.querySelectorAll<HTMLButtonElement>('.view-pane-residue')]
  expect(parts.map((b) => b.textContent)).toEqual(['3 not read', '1 hidden', '2 missing', '2 records not placed', '3 unreadable lines'])
  expect(parts[4].querySelector('span'), 'the unreadable lines in the same ink as the rest').toBeNull()
  expect(el.querySelector('.view-pane-residue-list')).toBeNull()
  const line = parts[4]
  await act(async () => line.click())
  expect(parts.every((b) => b.getAttribute('aria-expanded') === 'true'), 'every part says the list is open').toBe(true)
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
  expect(derived.textContent).toBe('Derived data: 2 fields')
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
  expect(button.textContent).toBe('Derived data: 4 fields')
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
  const el = await mount(<Head notes={notes} picked={[]} files={['a.jsonl', 'b.jsonl']} />)
  expect(el.querySelector('.view-pane-residue')).toBeNull()
  expect(el.querySelector('.view-pane-sub')?.textContent).toBe('All 2 files read')
  const list = await mount(<ResidueList notes={notes} onPick={() => undefined} />)
  expect(list.innerHTML).toBe('')
})

test("a file viewer's line speaks of its one file, and of nothing when the file reads cleanly", async () => {
  const torn: ViewNotes = { shown: { files: 1, not_shown: { count: 0, unexplained: 0, files: [] }, missing: [], derived: [], errors: [] }, problems: { count: 2, examples: [{ ref: 'runs/7.jsonl#L21', why: 'not JSON' }] } }
  const el = await mount(<Head notes={torn} picked={[]} file />)
  expect(el.querySelector('.view-pane-sub')?.textContent).toBe('2 unreadable lines')
  const unknown = await mount(<Head notes={{ ...torn, problems: { count: null, examples: torn.problems!.examples } }} picked={[]} file />)
  expect(unknown.querySelector('.view-pane-sub')?.textContent, 'no count while it is not known').toBe('Unreadable lines')
  const partly: ViewNotes = { ...torn, shown: { ...torn.shown!, not_shown: { count: 1, unexplained: 1, files: [{ path: 'runs/7.jsonl', size: 900, read: 300, why: '' }] } }, problems: { count: 0, examples: [] } }
  expect((await mount(<Head notes={partly} picked={[]} file />)).querySelector('.view-pane-sub')?.textContent).toBe('Partly read')
  const clean: ViewNotes = { ...torn, problems: { count: 0, examples: [] } }
  expect((await mount(<Head notes={clean} picked={[]} file />)).innerHTML).toBe('<div></div>')
})
