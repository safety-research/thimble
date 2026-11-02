// @vitest-environment jsdom
// A transcript's words in Files read as the chat draws a reply (src/files/views/common.tsx BlockEl `markdown`,
// src/files/views/transcript.tsx): a heading, bold, italic, code and a list are drawn, not the marks typed for them; the
// words a citation quotes and the texts a span label marks are drawn on them all the same, by their places in the
// record's own text; a tool call, its result and a line of a text file stay as written.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ReaderLabelsContext, type ReaderLabels } from '../../src/files/marks.tsx'
import text from '../../src/files/views/text.tsx'
import transcript from '../../src/files/views/transcript.tsx'
import type { Concept, SourcePage, SourceRecord } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const View = transcript.component
const WORDS = '## What was built\n\nA single-user **habit tracker** that forgives a *past* miss; it shows `pending: 1`.\n\n- streaks\n- reminders'
const CALL = 'Bash\n{\n  "command": "cat **notes**"\n}'

// a Claude Code stream: the reply's words and a tool call, then the call's result
const records: SourceRecord[] = [
  {
    line: 1,
    record: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: WORDS }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat **notes**' } }] } },
    blocks: [{ kind: 'text', text: WORDS }, { kind: 'tool_use', text: CALL }],
    meta: {},
  },
  {
    line: 2,
    record: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'no **bold** here' }] } },
    blocks: [{ kind: 'tool_result', text: 'no **bold** here' }],
    meta: {},
  },
]
const page: SourcePage = { path: 's.jsonl', kind: 'agent', total_lines: 2, start: 1, records }
const words = (el: HTMLElement) => el.querySelector('.reader-card[data-line="1"] .reader-block.reader-text')!

describe("a transcript's words", () => {
  test('draw as markdown: a heading, bold, italic, code and a list, without the marks typed for them', async () => {
    const el = await mount(<View workspace="w" path="s.jsonl" kind="agent" page={page} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />)
    const w = words(el)
    expect(w.querySelector('h2')?.textContent).toBe('What was built')
    expect(w.querySelector('strong')?.textContent).toBe('habit tracker')
    expect(w.querySelector('em')?.textContent).toBe('past')
    expect(w.querySelector('code')?.textContent).toBe('pending: 1')
    expect([...w.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['streaks', 'reminders'])
    expect(w.textContent).not.toMatch(/\*|##|`/)
    // a tool call and its result stay as written
    expect(el.querySelector('.reader-tool_use')!.textContent).toBe(CALL)
    expect(el.querySelector('.reader-tool_result')!.textContent).toBe('no **bold** here')
  })

  test('the words a citation quotes are highlighted where the markdown draws them', async () => {
    const at = WORDS.indexOf('habit tracker')
    // jsdom has no scrollIntoView, which brings a citation's record into view
    Element.prototype.scrollIntoView = () => undefined
    try {
      const el = await mount(<View workspace="w" path="s.jsonl" kind="agent" page={page} targetRef={`s.jsonl#L1.b0:c${at}-${at + 13}`} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />)
      const hl = words(el).querySelector('.hl')
      expect(hl?.textContent).toBe('habit tracker')
      expect(hl?.parentElement?.tagName).toBe('STRONG')
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  test('a span label marks its texts in the drawn words, each piece with the anchor of its place in the record', async () => {
    const label = {
      id: 'k1',
      name: 'Forgiveness',
      unit: 'record',
      labels: ['yes', 'no'],
      classes: [
        { name: 'yes', color: 3, highlight: true },
        { name: 'no', color: 0, highlight: false },
      ],
    } as unknown as Concept
    const ctx: ReaderLabels = {
      path: 's.jsonl',
      on: [label],
      lanes: [label],
      focus: 'k1',
      rows: new Map([['s.jsonl#L1', new Map([['k1', { ref: 's.jsonl#L1', label: 'yes', confidence: null, source: 'regex', spans: ['user **habit', 'pending: 1'] }]])]]),
      want: () => undefined,
    }
    const el = await mount(
      <ReaderLabelsContext.Provider value={ctx}>
        <View workspace="w" path="s.jsonl" kind="agent" page={page} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />
      </ReaderLabelsContext.Provider>,
    )
    const marked = [...words(el).querySelectorAll<HTMLElement>('.reader-span')]
    const at = WORDS.indexOf('user **habit')
    const code = WORDS.indexOf('pending: 1')
    // the span across the bold's start is drawn on its words either side of it, both pieces naming the span
    expect(marked.map((m) => [m.textContent, m.dataset.anchor])).toEqual([
      ['user ', `s.jsonl#L1.b0:c${at}-${at + 12}`],
      ['habit', `s.jsonl#L1.b0:c${at}-${at + 12}`],
      ['pending: 1', `s.jsonl#L1.b0:c${code}-${code + 10}`],
    ])
    expect(marked[1].parentElement?.tagName).toBe('STRONG')
    expect(marked[2].parentElement?.tagName).toBe('CODE')
  })

  test('a line of a text file stays as written', async () => {
    const line = '## not a **heading**'
    const txt: SourcePage = { path: 'notes.txt', kind: 'text', total_lines: 1, start: 1, records: [{ line: 1, record: { text: line }, blocks: [{ kind: 'text', text: line }], meta: {} }] }
    const el = await mount(<text.component workspace="w" path="notes.txt" kind="text" page={txt} loadMore={() => undefined} />)
    expect(el.querySelector('.reader-block')!.textContent).toBe(line)
    expect(el.querySelector('h2, strong')).toBeNull()
  })
})
