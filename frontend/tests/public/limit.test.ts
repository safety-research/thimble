// The gate of slow calls (src/lib/limit.ts): a view's data calls have no time limit, and the browser holds six
// connections to the server, so at most a few of them are on their way at once and the rest wait their turn. The
// calls here are promises the test settles.
import { expect, test } from 'vitest'
import { limiter } from '../../src/lib/limit.ts'

/** A call the test ends with `end(value)` or `fail(error)`. */
function held() {
  let end: (v: string) => void = () => {}
  let fail: (e: Error) => void = () => {}
  const started = { n: 0 }
  const start = () => {
    started.n++
    return new Promise<string>((res, rej) => {
      end = res
      fail = rej
    })
  }
  return { start, started, end: (v: string) => end(v), fail: (e: Error) => fail(e) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('at most `max` calls run at once, and the next starts as one ends, in the order they came', async () => {
  const gate = limiter(2)
  const calls = [held(), held(), held(), held()]
  const answers = calls.map((c) => gate(c.start))
  await tick()
  expect(calls.map((c) => c.started.n)).toEqual([1, 1, 0, 0])
  calls[1].end('b')
  expect(await answers[1]).toBe('b')
  await tick()
  expect(calls.map((c) => c.started.n)).toEqual([1, 1, 1, 0])
  calls[0].fail(new Error('500 boom'))
  await expect(answers[0]).rejects.toThrow('500 boom')
  await tick()
  expect(calls[3].started.n).toBe(1)
  calls[2].end('c')
  calls[3].end('d')
  expect(await Promise.all([answers[2], answers[3]])).toEqual(['c', 'd'])
})

test('a call cancelled while it waits never starts, and its place goes to the next', async () => {
  const gate = limiter(1)
  const first = held()
  const dropped = held()
  const last = held()
  const ctrl = new AbortController()
  const a = gate(first.start)
  const b = gate(dropped.start, ctrl.signal)
  const c = gate(last.start)
  ctrl.abort()
  await expect(b).rejects.toThrow()
  first.end('a')
  expect(await a).toBe('a')
  await tick()
  expect(dropped.started.n).toBe(0)
  expect(last.started.n).toBe(1)
  last.end('c')
  expect(await c).toBe('c')
  const gone = new AbortController()
  gone.abort()
  const never = held()
  await expect(gate(never.start, gone.signal)).rejects.toThrow()
  expect(never.started.n).toBe(0)
})
