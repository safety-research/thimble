// @vitest-environment jsdom
// A document's drafts in History (src/report/historyModel.ts historyRows, src/report/History.tsx PastDraft): the
// analyst's own version from before the first write is Draft 1, by You; a past draft shown read-only has Restore, which
// makes it the newest draft again, and the draft a Restore made says which draft it restored.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { docsApi } from '../../src/lib/api'
import type { DocHistory, DocVersion } from '../../src/lib/types'
import { PastDraft } from '../../src/report/History.tsx'
import { historyRows } from '../../src/report/historyModel.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const version = (over: Partial<DocVersion>): DocVersion => ({
  n: 1,
  ts: '2026-10-15T10:00:00Z',
  source: 'terminal',
  instructions: null,
  summary: [],
  summary_from: null,
  run: null,
  current: false,
  available: true,
  words: 120,
  writer: null,
  revisions: [],
  ...over,
})

const history: DocHistory = {
  slug: 'report',
  generation: 3,
  versions: [
    version({ n: 3, source: 'analyst', current: true, restored: { n: 1, rev: null } }),
    version({ n: 2, writer: 'w1', summary: ['1 section added: “Who”.'], summary_from: 'diff' }),
    version({ n: 1, source: 'analyst' }),
  ],
}

describe('History rows', () => {
  test("the analyst's version before the first write is Draft 1 by You, and a restored draft names the draft it restored", () => {
    const rows = historyRows(history)
    expect(rows.map((r) => [r.label, r.by])).toEqual([
      ['Draft 3', 'You'],
      ['Draft 2', 'Writer'],
      ['Draft 1', 'You'],
    ])
    expect(rows[0].changes).toEqual(['Restored Draft 1'])
    expect(rows[2].changes).toEqual(['First draft'])
  })
})

describe('Restore on a past draft', () => {
  const doc = { id: 'report', type: 'report', title: 'My notes', generation: 1, sections: [{ id: 's1', heading: 'Notes', paragraphs: [], figures: [] }], comments: [] }

  test('Restore makes the draft shown the newest draft and hands back the document', async () => {
    vi.spyOn(docsApi, 'version').mockResolvedValue(doc as never)
    const restored = { ...doc, generation: 4 }
    const restore = vi.spyOn(docsApi, 'restore').mockResolvedValue(restored as never)
    const onRestored = vi.fn()
    const rows = historyRows(history)
    const el = await mount(<PastDraft ws="w-hist" slug="report" target={{ n: 1, rev: null }} rows={rows} onClose={() => {}} onRestored={onRestored} />)
    await settle()
    expect(el.querySelector('.wu-past-name')?.textContent).toBe('Draft 1 of 3')
    const button = el.querySelector<HTMLButtonElement>('button.wu-past-restore')!
    expect(button.textContent).toBe('Restore')
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    await settle()
    expect(restore).toHaveBeenCalledWith('w-hist', 'report', 1, null)
    expect(onRestored).toHaveBeenCalledWith(restored)
  })
})
