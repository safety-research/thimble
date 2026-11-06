// @vitest-environment jsdom
// A chat log in Files (src/files/views/transcript.tsx, registry.ts, src/files/views/common.tsx): the server's sniff
// sure of a chat log opens it in the Transcript mode, which draws a card per turn with its speaker, each line in its own
// record, and a label on a line inside a turn lights the turn's gutter; the words a citation quotes are highlighted
// where the markdown of a reply draws them.
import { afterEach, expect, test, vi } from 'vitest'
import { ReaderLabelsContext, type ReaderLabels } from '../../src/files/marks.tsx'
import { pickView, scoreViews } from '../../src/files/views/registry.ts'
import transcript from '../../src/files/views/transcript.tsx'
import type { Concept, SourcePage, SourceRecord, TranscriptHint } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const View = transcript.component

test('a chat log opens as a transcript: a card per turn with its speaker, and a label on one of its lines lights its turn', async () => {
  const line = (n: number, text: string, turn?: { speaker: string; at: number }): SourceRecord => ({ line: n, record: { text }, blocks: [{ kind: 'text', text }], meta: turn ? { turn } : {} })
  const records = [
    line(1, '# Session notes'),
    line(2, 'User: why does the build fail?', { speaker: 'User', at: 6 }),
    line(3, 'Assistant: the groupby test drops a key.', { speaker: 'Assistant', at: 11 }),
    line(4, 'It started with the patch.'),
    line(5, ''),
    line(6, '## Human', { speaker: 'Human', at: 8 }),
    line(7, ''),
    line(8, 'thanks'),
  ]
  const sure: TranscriptHint = { format: 'text', score: 0.95, style: 'colon' }
  expect(pickView(scoreViews('logs/chat.md', 'text', records.map((r) => r.record), sure)).type).toBe('transcript')
  // the label marks line 4, inside the Assistant's turn
  const flagged = { id: 'k1', name: 'Blames the patch', unit: 'record', labels: ['yes', 'no'], classes: [] } as unknown as Concept
  const labels: ReaderLabels = {
    path: 'logs/chat.md',
    on: [flagged],
    lanes: [flagged],
    focus: 'k1',
    rows: new Map([['logs/chat.md#L4', new Map([['k1', { ref: 'logs/chat.md#L4', label: 'yes', confidence: null, source: null }]])]]),
    want: () => undefined,
  }
  const page: SourcePage = { path: 'logs/chat.md', kind: 'text', total_lines: 8, start: 1, records }
  const el = await mount(
    <ReaderLabelsContext.Provider value={labels}>
      <View workspace="w" path="logs/chat.md" kind="text" page={page} loadMore={() => undefined} transcript={sure} />
    </ReaderLabelsContext.Provider>,
  )
  const cards = [...el.querySelectorAll('.reader-card')]
  expect(cards.map((c) => c.getAttribute('data-line'))).toEqual(['1', '2', '3', '6'])
  expect(cards.map((c) => c.querySelector('.reader-record-head')?.textContent ?? '')).toEqual(['', 'User', 'Assistant', 'Human'])
  expect(cards[2].textContent).toContain('the groupby test drops a key.It started with the patch.')
  expect([...cards[2].querySelectorAll('.reader-block')].map((b) => b.getAttribute('data-line'))).toEqual(['3', '4'])
  const lit = (n: string) => !!el.querySelector(`.reader-card[data-line="${n}"] > .reader-gutter .reader-gutter-cell.is-lit`)
  expect(['2', '3', '6'].map(lit)).toEqual([false, true, false])
})

test("the words a citation quotes in a reply are highlighted where the reply's markdown draws them", async () => {
  const WORDS = '## What was built\n\nA single-user **habit tracker** that forgives a *past* miss.'
  const page: SourcePage = {
    path: 's.jsonl',
    kind: 'agent',
    total_lines: 1,
    start: 1,
    records: [{ line: 1, record: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: WORDS }] } }, blocks: [{ kind: 'text', text: WORDS }], meta: {} }],
  }
  const at = WORDS.indexOf('habit tracker')
  // jsdom has no scrollIntoView, which brings a citation's record into view
  Element.prototype.scrollIntoView = () => undefined
  try {
    const el = await mount(<View workspace="w" path="s.jsonl" kind="agent" page={page} targetRef={`s.jsonl#L1.b0:c${at}-${at + 13}`} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />)
    const words = el.querySelector('.reader-card[data-line="1"] .reader-block.reader-text')!
    expect(words.querySelector('h2')?.textContent).toBe('What was built')
    const hl = words.querySelector('.hl')
    expect(hl?.textContent).toBe('habit tracker')
    expect(hl?.parentElement?.tagName).toBe('STRONG')
  } finally {
    delete (Element.prototype as Partial<Element>).scrollIntoView
  }
})
