// Main's chip at the end of a view's build that failed (src/chat/Rows.tsx ticketChipText): a change to the view says the
// view is as it was; the build of the page a view lacked, thimble's own step, names that page and never a change.
import { describe, expect, test } from 'vitest'
import { ticketChipText } from '../../src/chat/Rows.tsx'
import { foldRecords } from '../../src/chat/model.ts'
import type { ChatRecord } from '../../src/lib/types.ts'

describe('a failed view build in main', () => {
  test("the page a view lacked names that page, never a change the analyst asked for (bug hunt round 11, L17)", () => {
    const rec = { type: 'chip', kind: 'ticket', ts: '2026-10-18T07:02:26Z', status: 'failed', ref: 'view:run-board', chat: 'c1', page: 'html-page',
      text: "the view Run Board's page for the browser workbench failed to build, so the view keeps its page for the terminal panel: problem: view.html is empty" } as unknown as ChatRecord
    const [row] = foldRecords([rec])
    expect(row).toMatchObject({ kind: 'chip', page: 'html-page' })
    const text = ticketChipText(row as Parameters<typeof ticketChipText>[0])
    expect(text).toBe("The view's page for the browser workbench failed to build, so the view keeps its other page")
    expect(text).not.toMatch(/change/)
    expect(ticketChipText({ status: 'stopped', text: '', ref: 'view:run-board', page: 'term-page' })).toBe(
      "The build of the view's page for the terminal panel stopped when your Claude Code session ended")
  })

  test('a change to the view still says the view is as it was', () => {
    expect(ticketChipText({ status: 'failed', text: '', ref: 'view:run-board' })).toBe('The change to the view failed, so it is as it was')
    expect(ticketChipText({ status: 'failed', text: '', ref: 'ticket:t1' })).toBe('Dev ticket failed')
  })
})
