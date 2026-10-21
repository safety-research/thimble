// The words Claude writes before a later call of its turn are one of the turn's steps; the reply is the text after the
// turn's last call (chat/tidy midTurnTexts).
import { expect, test } from 'vitest'
import { midTurnTexts } from '../../src/chat/tidy.ts'

test('the words written before a later call of the turn are its steps, the text after the last call its reply', () => {
  const rows = [
    { kind: 'user', index: 0 },
    { kind: 'text', index: 1 },
    { kind: 'tools', index: 2 },
    { kind: 'text', index: 3 },
    { kind: 'calls', index: 4 },
    { kind: 'text', index: 5 },
    { kind: 'user', index: 6 },
    { kind: 'text', index: 7 },
  ]
  expect([...midTurnTexts(rows)]).toEqual([1, 3])
})
