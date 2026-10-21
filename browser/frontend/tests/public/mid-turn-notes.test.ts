// The words Claude writes before a later call of its turn are one of the turn's steps; the reply is the text after the
// turn's last call, or the last text before that call when nothing follows it (chat/tidy midTurnTexts).
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

test('an answer followed by a card, with nothing after, stays the reply', () => {
  const rows = [
    { kind: 'user', index: 0, text: 'How many runs merged?' },
    { kind: 'text', index: 1, text: 'Three of the five runs merged.' },
    { kind: 'tool', index: 2 },
    { kind: 'text', index: 3, text: '\n\n' },
  ]
  expect([...midTurnTexts(rows)]).toEqual([])
})

test('a note, a call and then the answer: the note is a step, the answer the reply', () => {
  const rows = [
    { kind: 'user', index: 0 },
    { kind: 'text', index: 1, text: 'Let me count the runs first.' },
    { kind: 'tool', index: 2 },
    { kind: 'text', index: 3, text: 'Three of the five runs merged.' },
  ]
  expect([...midTurnTexts(rows)]).toEqual([1])
})

test('a note, the answer and then a card: the answer is the reply, the note a step', () => {
  const rows = [
    { kind: 'user', index: 0 },
    { kind: 'text', index: 1, text: 'Let me count the runs first.' },
    { kind: 'tools', index: 2 },
    { kind: 'text', index: 3, text: 'Three of the five runs merged.' },
    { kind: 'tool', index: 4 },
    { kind: 'tool', index: 5 },
    { kind: 'user', index: 6 },
    { kind: 'text', index: 7, text: 'Yes.' },
  ]
  expect([...midTurnTexts(rows)]).toEqual([1])
})

test('while the turn still runs, a text a call follows is a step, since the reply may still come', () => {
  const rows = [
    { kind: 'user', index: 0 },
    { kind: 'text', index: 1, text: 'Let me count the runs first.' },
    { kind: 'tool', index: 2 },
  ]
  expect([...midTurnTexts(rows, true)]).toEqual([1])
  expect([...midTurnTexts(rows)]).toEqual([])
})
