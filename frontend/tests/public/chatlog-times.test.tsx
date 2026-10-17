// @vitest-environment jsdom
// A markdown chat log in the Transcript mode (bug hunt B20): a line that holds only a time (`**00:01:26**`) dates the
// turn after it, in its head, and shows in no turn; the lines show no markdown syntax (src/files/views/transcript.tsx).
import { afterEach, expect, test } from 'vitest'
import transcript from '../../src/files/views/transcript.tsx'
import type { SourcePage, SourceRecord } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const line = (n: number, text: string, turn?: { speaker: string; at: number; time?: string }): SourceRecord => ({
  line: n,
  record: { text },
  blocks: [{ kind: 'text', text }],
  meta: turn ? { turn } : {},
})

// as P2/transcript.md of the pilot begins, with the server's `meta.turn` on each speaker's line (bold style)
const records = [
  line(1, '# P2 session transcript'),
  line(2, ''),
  line(3, '_Auto-captions from the session recording; "(?)" marks an uncertain attribution._'),
  line(4, ''),
  line(5, '**00:00:01**'),
  line(6, ''),
  line(7, '**Matthew Jörke:** Um, so I have a **little**', { speaker: 'Matthew Jörke', at: 19 }),
  line(8, ''),
  line(9, '**Matthew Jörke:** All right, see you.', { speaker: 'Matthew Jörke', at: 19 }),
  line(10, ''),
  line(11, '**00:01:26**'),
  line(12, ''),
  line(13, '**P2 (?):** All right. Hello.', { speaker: 'P2', at: 12, time: '?' }),
]

test('a time on its own line heads the turn after it, and no line shows markdown syntax', async () => {
  const page: SourcePage = { path: 'P2/transcript.md', kind: 'text', total_lines: 13, start: 1, records }
  const View = transcript.component
  const el = await mount(<View workspace="w" path="P2/transcript.md" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'text', score: 0.95, style: 'bold', speakers: ['matthew jörke', 'p2'] }} />)
  const cards = [...el.querySelectorAll('.reader-card')]
  expect(cards.map((c) => c.getAttribute('data-line'))).toEqual(['1', '7', '9', '13'])
  expect(cards.map((c) => c.querySelector('.reader-record-head')?.textContent ?? '')).toEqual(['', 'Matthew Jörke · 00:00:01', 'Matthew Jörke', 'P2 · ? · 00:01:26'])
  const words = cards.map((c) => [...c.querySelectorAll('.reader-block')].map((b) => b.textContent).join('|'))
  expect(words[0]).toBe('P2 session transcript||Auto-captions from the session recording; "(?)" marks an uncertain attribution.')
  expect(words[1]).toBe('Um, so I have a little')
  // the time that starts the next block is not a line of the turn before it
  expect(words[2]).toBe('All right, see you.')
  expect(words.join('|')).not.toMatch(/\*\*|^#|00:00:01/)
})
