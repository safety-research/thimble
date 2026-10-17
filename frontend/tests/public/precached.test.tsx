// @vitest-environment jsdom
// A workspace `thimble demo` installed from a pre-cache (src/chat/Precached.tsx): the orientation's thread opens with a
// card that says it ran in advance, when, on what model, what it left (the counts the mark keeps) and whether its
// session came with it, and nothing about a session to attach; once a session is attached the card says so. The page
// stays readable without a session until the first one attaches (isGone), as a worked example's workspace does; until
// then it is a demo page (tests/public/demo-page.test.tsx), whose composer stays.
import { afterEach, expect, test, vi } from 'vitest'
import type { ChatMeta } from '../../src/lib/types.ts'
import { isGone } from '../../src/shell/SessionGone.tsx'
import { unmountAll } from './mount.tsx'

const T = '2026-10-06T00:00:00+00:00'
const MAIN = { id: 'main', kind: 'main', role: 'main', title: '', created_at: T, parent: null } as unknown as ChatMeta

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('a pre-cached workspace is read without a session until one attached and ended', () => {
  expect(isGone(MAIN, true, true)).toBe(false)
  expect(isGone({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, true, true)).toBe(true)
  expect(isGone(MAIN, true, false)).toBe(true)
  // the stream down: a restart shows no card, but a session that ended before the server stopped itself does (L10)
  expect(isGone(MAIN, false, false)).toBe(false)
  expect(isGone({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, false, false)).toBe(true)
  expect(isGone({ ...MAIN, attached: { session: 's' } } as unknown as ChatMeta, true, true)).toBe(false)
})
