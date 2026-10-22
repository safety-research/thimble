// @vitest-environment jsdom
// Letters at an empty message box (cards/keys.ts), as the terminal routes them: v draws a card of the last answer once
// the word window closed, and a letter typed within it makes v the start of a word, which is typed.
import { afterEach, expect, test, vi } from 'vitest'
import { keyAtEmpty, setVTarget, WORD_MS } from '../../src/cards/keys.ts'

afterEach(() => {
  setVTarget(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('v starts a card of the last answer after the word window, and "ve" types as a word', async () => {
  vi.useFakeTimers()
  const asked: string[] = []
  vi.stubGlobal('fetch', async (url: string) => (asked.push(String(url)), new Response('{"id":"d1","chat":"main","turn":"t"}', { headers: { 'content-type': 'application/json' } })))
  const typed: string[] = []
  setVTarget({ ws: 'w', chat: 'main' })
  expect(keyAtEmpty('v', (t) => typed.push(t))).toBe(true)
  expect(keyAtEmpty('e', (t) => typed.push(t))).toBe(true)
  expect(typed).toEqual(['ve'])
  vi.advanceTimersByTime(WORD_MS + 10)
  expect(asked).toEqual([])
  expect(keyAtEmpty('v', (t) => typed.push(t))).toBe(true)
  vi.advanceTimersByTime(WORD_MS + 10)
  await vi.runAllTimersAsync()
  expect(asked.some((u) => u.endsWith('/ws/w/v'))).toBe(true)
  // no answer to draw (the chat runs): v types as any letter
  setVTarget(null)
  expect(keyAtEmpty('v', (t) => typed.push(t))).toBe(false)
  // a key no card on screen lists types
  expect(keyAtEmpty('x', (t) => typed.push(t))).toBe(false)
})
