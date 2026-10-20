// @vitest-environment jsdom
// A workspace `thimble demo` installed from a pre-cache (src/chat/Precached.tsx): the orientation's thread opens with a
// card that says it ran in advance, when, on what model, what it left (the counts the mark keeps) and whether its
// session came with it, and nothing about a session to attach; once a session is attached the card says so. The page
// stays readable without a session until the first one attaches (isGone), as a worked example's workspace does; until
// then it is a demo page (tests/public/demo-page.test.tsx), whose composer stays.
import { afterEach, expect, test, vi } from 'vitest'
import { ATTACHED_NOTE, PRECACHED_TITLE, PrecachedCard, heldText, precachedMark, precachedText, takesFollowUps } from '../../src/chat/Precached.tsx'
import type { ChatMeta, PrecachedMark } from '../../src/lib/types.ts'
import { isExample, isGone } from '../../src/shell/SessionGone.tsx'
import { mount, unmountAll } from './mount.tsx'

const T = '2026-10-06T00:00:00+00:00'
const MARK: PrecachedMark = { dataset: 'collusion-wiki', created: '2026-10-06T01:00:00+00:00', ran: '2026-10-05T22:30:00+00:00', folder: '/srv/thimble-demo/collusion-wiki', orientation: 'o1', model: 'claude-opus-5-5[1m]' }
const MAIN = { id: 'main', kind: 'main', role: 'main', title: '', created_at: T, parent: null } as unknown as ChatMeta
const ORIENT = { id: 'o1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: T, parent: 'main', status: 'done', precached: MARK } as unknown as ChatMeta

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('the mark is read from the orientation that carries one', () => {
  expect(precachedMark([MAIN, ORIENT])?.folder).toBe('/srv/thimble-demo/collusion-wiki')
  expect(precachedMark([MAIN, { ...ORIENT, precached: null }])).toBeNull()
  expect(precachedText(MARK)).toContain('ran on 2026-10-05 with claude-opus-5-5,')
  expect(precachedText(MARK)).toContain('takes no follow-ups')
  expect(takesFollowUps(MARK)).toBe(false)
  // from a full export the orientation's session came with it
  expect(precachedText({ ...MARK, format: 'full', kept: true })).toContain('a message here continues it')
  expect(takesFollowUps({ ...MARK, kept: true })).toBe(true)
})

test('the card names what the pre-cache holds from the counts its mark keeps, else the shipped outputs', () => {
  expect(heldText({ ...MARK, counts: { cards: 8, labels: 5, views: 1, documents: 1 } })).toBe('Its 8 cards, 5 labels, 1 view and 1 document are here.')
  // a pre-cache made in 0.8.0 may hold no view and no report
  expect(heldText({ ...MARK, counts: { cards: 9, labels: 1, views: 0, documents: 0 } })).toBe('Its 9 cards and 1 label are here.')
  expect(heldText({ ...MARK, counts: { cards: 1 } })).toBe('Its 1 card is here.')
  expect(heldText({ ...MARK, counts: { cards: 0 } })).toBe('It left no cards, labels, views or documents.')
  expect(heldText(MARK)).toBe('Its cards, labels, views and report are here.')
  expect(precachedText({ ...MARK, counts: { cards: 2 } })).toContain('before thimble was installed here. Its 2 cards are here. Its Claude Code session')
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

test("a worked example's workspace is read without a session too, until one attached and ended", () => {
  const rows = [
    { name: 'example-timeline', kind: 'example', folder: 'example-timeline', path: '/h/examples/example-timeline' },
    { name: 'example-notes', kind: 'folder', folder: 'example-notes', path: '/h/example-notes' },
  ] as const
  expect(isExample(rows, 'example-timeline')).toBe(true)
  // a folder whose name only starts like an example's is no example
  expect(isExample(rows, 'example-notes')).toBe(false)
  expect(isExample(rows, 'elsewhere')).toBe(false)
  expect(isGone(MAIN, true, isExample(rows, 'example-timeline'))).toBe(false)
  expect(isGone({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, true, true)).toBe(true)
})

test('without a session the card says the orientation ran in advance, and offers no command and no button', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => undefined } })
  for (const mark of [MARK, { ...MARK, format: 'full', kept: true }]) {
    const el = await mount(<PrecachedCard mark={mark} attached={false} />)
    expect(el.querySelector('.card-title')?.textContent).toBe(PRECACHED_TITLE)
    expect(el.textContent).toContain('ran on 2026-10-05 with claude-opus-5-5')
    expect(el.textContent).not.toContain('frozen')
    expect(el.textContent).not.toContain('&& thimble')
    expect(el.querySelectorAll('button').length).toBe(0)
    unmountAll()
  }
})

test('once a session is attached the card says so and offers no command', async () => {
  const el = await mount(<PrecachedCard mark={MARK} attached />)
  expect(el.querySelector('.card-title')?.textContent).toBe(PRECACHED_TITLE)
  expect(el.querySelector('.precached-note')?.textContent).toBe(ATTACHED_NOTE)
  expect(el.textContent).toContain('A Claude Code session is attached')
  expect(el.querySelectorAll('button').length).toBe(0)
})
