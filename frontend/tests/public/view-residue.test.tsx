// @vitest-environment jsdom
// What thimble draws above a view (src/files/ViewChrome.tsx): the residue line says what the view leaves out by kind,
// opens the list of it under the head, and says "All read" when there is none; the derived data names its counts.
import { act, useState } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ResidueList, ViewNotesLine, type ViewNotes } from '../../src/files/ViewChrome.tsx'
import { mount, unmountAll } from './mount.tsx'

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
    missing: ['logs/*.log'],
    derived: [
      { field: 'time', from: 'ts', how: 'parsed to UTC' },
      { field: 'outcome', from: 'exit and result', how: 'ok, error or denied' },
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
  expect(line.textContent).toBe('3 files not read · 1 hidden · 1 missing · 3 lines not parsed')
  expect(line.querySelector('.view-pane-residue-failed')?.textContent).toBe('3 lines not parsed')
  expect(el.querySelector('.view-pane-residue-list')).toBeNull()
  await act(async () => line.click())
  const list = el.querySelector('.view-pane-residue-list') as HTMLElement
  expect([...list.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Not read', 'Hidden', 'Missing', 'Not parsed'])
  expect(list.textContent).toContain('not claimed')
  expect(list.textContent).toContain('and 1 more')
  expect(list.textContent).toContain('an index of the notes')
  expect(list.textContent).toContain('matches no file')
  await act(async () => (list.querySelector('.view-pane-list-item') as HTMLButtonElement).click())
  expect(picked).toEqual(['runs/r2/events.jsonl'])
  expect([...el.querySelectorAll('.view-pane-files')].map((b) => b.textContent)).toContain('Derived data: 2 fields')
})

test('a view that leaves nothing out says so, and has no list to open', async () => {
  const notes: ViewNotes = { shown: { files: 2, not_shown: { count: 0, unexplained: 0, files: [] }, missing: [], derived: [], errors: [] }, problems: { count: 0, examples: [] } }
  const el = await mount(<Head notes={notes} picked={[]} />)
  expect(el.querySelector('.view-pane-residue')).toBeNull()
  expect(el.querySelector('.view-pane-residue-none')?.textContent).toBe('All read')
  const list = await mount(<ResidueList notes={notes} onPick={() => undefined} />)
  expect(list.innerHTML).toBe('')
})
