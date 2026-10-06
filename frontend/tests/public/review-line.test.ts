// The review's mark on a view (src/files/ViewPane.tsx reviewLine): a review whose start waits for a free subagent
// (backend view_review `queued`, live check L19) says so, where it failed before.
import { expect, test } from 'vitest'
import { reviewLine } from '../../src/files/ViewPane.tsx'

test('a queued review says it waits for a free subagent; the other states keep their lines', () => {
  expect(reviewLine({ state: 'queued', note: 'Waits for a free subagent: Claude Code runs only so many at once.' })).toBe(
    'Waits for a free subagent: Claude Code runs only so many at once.',
  )
  expect(reviewLine({ state: 'queued' })).toBe('Waits for a free subagent')
  expect(reviewLine({ state: 'running', round: 1 })).toBe("Reviewing the view's pictures, round 1 of 2")
  expect(reviewLine({ state: 'failed' })).toBe('The review did not finish')
})
