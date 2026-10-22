// Main's line for a change to a built view that did not land (src/chat/Rows.tsx ticketChipText): a change that failed
// its checks, and one the analyst's quit stopped, each say the view is as it was; a dev ticket's own end keeps its words
// (live check L11: a change that main's quit stopped read as failed). A view build's start in main says it is one.
import { expect, test } from 'vitest'
import { devStarted, ticketChipText } from '../../src/chat/Rows.tsx'

test("a change to a view that main's quit stopped says it stopped, not that it failed", () => {
  expect(ticketChipText({ status: 'stopped', text: '', ref: 'view:posts' })).toBe(
    'The change to the view stopped when your Claude Code session ended, so it is as it was',
  )
  expect(ticketChipText({ status: 'failed', text: '', ref: 'view:posts' })).toBe('The change to the view failed, so it is as it was')
  expect(ticketChipText({ status: 'stopped', text: '', ref: 'ticket:t1' })).toBe('Dev ticket stopped')
})

test('a view build that main started reads as a view build in main, not as a dev ticket', () => {
  expect(devStarted({ title: 'view: Page Revisions' })).toBe('View build started in')
  expect(devStarted({ title: 'Fix the login page' })).toBe('Dev ticket started')
  expect(devStarted({ title: undefined })).toBe('Dev ticket started')
})
