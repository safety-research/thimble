// @vitest-environment jsdom
// A citation in an example card's takeaway that names a record the card quotes by its line alone opens the record in
// the File browser at the words the card quotes there, as the record's address does, so Files marks them and scrolls
// them into view (bug hunt L10: the link opened the record's line, lit as a row, with the quoted words unmarked and, in
// Table mode, their column off-screen). A citation of a record the card does not quote goes where it names.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { bus } from '../../src/lib/bus.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const ctx = { ws: 'w', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }

beforeEach(() => {
  // the records are not read: nothing answers
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test("a takeaway's citation of a quoted record opens it at the quoted words; another record opens as named", async () => {
  const cell = {
    id: 'kettle-notes',
    notebook: 'nb',
    kind: 'example',
    title: 'Which kettles whistled?',
    created_by: 'chat:main',
    ts: '',
    takeaway: 'Kettle 4 [[whistled twice|kettles.jsonl#L12]], and kettle 9 [[stayed quiet|kettles.jsonl#L40]].',
    payload: { refs: ['kettles.jsonl#L12.b0:c30-58', 'kettles.jsonl#L31.b0:c4-20'] },
  } as unknown as Cell
  const opened: { ref: string; browser?: boolean }[] = []
  const off = bus.on('openRef', (e) => void opened.push({ ref: e.ref, browser: e.browser }))
  const el = await mount(
    <CanvasContext.Provider value={ctx as never}>
      <CardFace cell={cell} width={440} label={{ concept: null, error: null } as never} />
    </CanvasContext.Provider>,
  )
  await settle()
  const chip = (ref: string) => el.querySelector<HTMLElement>(`.bcell-take [data-ref="${ref}"]`)!
  await act(async () => chip('kettles.jsonl#L12').click())
  await settle()
  expect(opened).toEqual([{ ref: 'kettles.jsonl#L12.b0:c30-58', browser: true }])
  await act(async () => chip('kettles.jsonl#L40').click())
  await settle()
  expect(opened.map((o) => o.ref)).toEqual(['kettles.jsonl#L12.b0:c30-58', 'kettles.jsonl#L40'])
  off()
})
