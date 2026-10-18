// @vitest-environment jsdom
// A citation written as a link whose words are in double brackets (bug hunt E2): main wrote `[[↗]](card:<id>)`, which
// the chat drew as an empty file chip of "↗", then `(` the card's chip `)`. It is the card's chip alone, as the backend
// (cite.mixed_links) and the terminal read it (src/lib/refs.ts mixedLinks, src/chat/markdown.tsx).
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import { mixedLinks } from '../../src/lib/refs.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('bug hunt E2: `[[↗]](card:<id>)` in a reply is the card chip alone, never a chip of a file named ↗', async () => {
  const text = 'Most runs finished [[↗]](card:tally-ends). There are [[221]](card:session-rows#n/all) rows across the runs.'
  const rows = foldRecords([{ type: 'text', delta: text }, { type: 'done', ts: '2026-10-17T10:12:44Z', session_id: 's' }] as unknown as ChatRecord[])
  const el = await mount(
    <ThreadsContext.Provider value={{ labels: new Map() }}>
      <Rows rows={rows} ws="w" streaming={false} />
    </ThreadsContext.Provider>,
  )
  await settle()
  const chips = [...el.querySelectorAll<HTMLElement>('.chat-text [data-ref]')]
  expect(chips.map((c) => c.getAttribute('data-ref'))).toEqual(['card:tally-ends', 'card:session-rows#n/all'])
  expect(chips[1].textContent).toBe('221')
  const words = el.querySelector('.chat-text')!.textContent ?? ''
  expect(words).not.toContain('(')
  expect(words).not.toContain('card:tally-ends')
  // words that are a ref themselves, and a web link, keep their form
  expect(mixedLinks('[[card:tally-ends]](above) [[↗]](https://example.org/a)')).toBe('[[card:tally-ends]](above) [[↗]](https://example.org/a)')
})
