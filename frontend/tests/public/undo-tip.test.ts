// Undo's tooltip in the top bar (src/shell/undo.ts undoTip): what it would revert, else why a session that still runs
// holds it, else the bare name.
import { expect, test } from 'vitest'
import { undoTip } from '../../src/shell/undo.ts'

test('the tooltip names the step, or the running session that holds the undo', () => {
  expect(undoTip({ undo: 'edit card refunds-per-plan', redo: null })).toBe('Undo: edit card refunds-per-plan')
  expect(undoTip({ undo: null, redo: null, held: 'the writer of the report has changed the report since and is still running; undo it once that ends' })).toBe(
    'The writer of the report has changed the report since and is still running; undo it once that ends',
  )
  expect(undoTip({ undo: null, redo: null })).toBe('Undo')
})
