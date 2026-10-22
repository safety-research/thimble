// The browser's uncaught errors as thimble reports them (src/lib/telemetry.ts wireErrors): an error is reported, and the
// ResizeObserver loop notice, which is no error, is not.
import { describe, expect, test } from 'vitest'
import { benignError, wireErrors } from '../../src/lib/telemetry.ts'

describe("the browser's uncaught errors", () => {
  test('the ResizeObserver loop notice is not reported, an error is', () => {
    const handlers = new Map<string, (e: unknown) => void>()
    const win = { addEventListener: (type: string, fn: (e: unknown) => void) => void handlers.set(type, fn) } as unknown as Pick<Window, 'addEventListener'>
    const reported: string[] = []
    wireErrors(win, (t) => reported.push(t))
    handlers.get('error')!({ message: 'ResizeObserver loop completed with undelivered notifications.', error: null })
    handlers.get('error')!({ message: 'ResizeObserver loop limit exceeded', error: null })
    expect(reported).toEqual([])
    handlers.get('error')!({ message: 'x is undefined', error: new TypeError('x is undefined') })
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatch(/^x is undefined/)
    expect(benignError('TypeError: ResizeObserver loop completed')).toBe(false)
  })
})
