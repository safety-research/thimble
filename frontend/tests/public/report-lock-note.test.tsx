// @vitest-environment jsdom
// The Report tab's note on a locked block a model changed (src/report/LockNote.tsx): it shows the current
// generation's lock reverts only, says how many blocks came back, names their text in its tooltip, and a click scrolls
// to the first block the page shows. The document and its blocks are invented.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { currentReverts, LockNote, lockNoteLabel, lockNoteText, revertAnchor } from '../../src/report/LockNote.tsx'
import type { LockRevert, Writeup } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

const revert = (ref: string, text: string, generation: number): LockRevert => ({ ref, text, generation, tool: 'write_document', by: 'writer:report' })
const doc = (generation: number, reverts: LockRevert[]): Writeup => ({ title: 'The garden survey', sections: [], generation, lock_reverts: reverts })

afterEach(unmountAll)

describe('the lock note', () => {
  test('keeps the current generation only and words one block and several', () => {
    const d = doc(3, [revert('report:report#p1', 'Frost reached only the east bed.', 2), revert('report:report#p2', 'The west bed had no tulips.', 3)])
    expect(currentReverts(d).map((r) => r.ref)).toEqual(['report:report#p2'])
    expect(currentReverts(doc(1, []))).toEqual([])
    expect(currentReverts(null)).toEqual([])
    expect(lockNoteLabel(currentReverts(d))).toBe('Restored a locked block')
    expect(lockNoteText(currentReverts(d), 3)).toBe('A model changed it in draft 3; it is back as you locked it: “The west bed had no tulips.”')
    const two = [revert('report:report#title', 'The garden survey', 4), revert('report:report#s9', 'Which beds flowered', 4)]
    expect(lockNoteLabel(two)).toBe('Restored 2 locked blocks')
    expect(lockNoteText(two, 4)).toBe('A model changed them in draft 4; they are back as you locked them: “The garden survey” · “Which beds flowered”')
    const long = revert('report:report#p3', `${'The east bed flowered late because frost reached it twice in April and again '.repeat(2)}…`, 5)
    const quoted = lockNoteText([long], 5).split('“')[1]
    expect(quoted.length).toBe(81) // 80 characters of the block's text, the last an ellipsis, then the closing quote
    expect(quoted.endsWith('…”')).toBe(true)
    expect(revertAnchor('report:report#title')).toBe('report:report')
    expect(revertAnchor('report:report#p1')).toBe('report:report#p1')
  })

  test('shows nothing without a revert of this generation, and a click scrolls to the block', async () => {
    const page = document.createElement('div')
    page.innerHTML = '<p data-anchor="report:report#p2">The west bed had no tulips.</p>'
    document.body.appendChild(page)
    const scrolled = vi.fn()
    ;(page.firstElementChild as HTMLElement).scrollIntoView = scrolled
    const root = { current: page }
    const none = await mount(<LockNote doc={doc(2, [revert('report:report#p2', 'x', 1)])} root={root} />)
    expect(none.querySelector('.wu-reverts')).toBeNull()
    const el = await mount(<LockNote doc={doc(2, [revert('report:report#p9', 'Gone from the page.', 2), revert('report:report#p2', 'The west bed had no tulips.', 2)])} root={root} />)
    const note = el.querySelector<HTMLButtonElement>('.wu-reverts')!
    expect(note.textContent).toBe('Restored 2 locked blocks')
    expect(note.dataset.reverts).toBe('2')
    await act(async () => note.click())
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(page.firstElementChild!.classList.contains('anchor-flash')).toBe(true)
  })
})
