// The canvas's minimap folds into the zoom bar where the board is too narrow to show it beside a card, so it does not
// cover the card's text (src/canvas/Controls.tsx minimapOpen); the viewer's own choice wins either way.
import { expect, test } from 'vitest'
import { minimapOpen } from '../../src/canvas/Controls.tsx'

test('the minimap shows on a wide board, folds on a narrow one, and keeps the viewer choice', () => {
  expect(minimapOpen(null, true)).toBe(true)
  expect(minimapOpen(null, false)).toBe(false)
  expect(minimapOpen('open', false)).toBe(true)
  expect(minimapOpen('folded', true)).toBe(false)
})
