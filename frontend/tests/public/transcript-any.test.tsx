// @vitest-environment jsdom
// Transcript for anything close to a transcript, and a PDF as itself: the server's sniff decides the mode, a text chat
// log reads as turns whose lines keep their own records, and a PDF ref opens at its page; records that are objects
// offer the Table, a citation of words deep in a record marks them, speakers named only by id show the corpus's names
// for them, and a markdown file's front matter shows folded (src/files/views/transcript.tsx, table.tsx, text.tsx,
// src/files/views/registry.ts, src/files/Reader.tsx).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { pdfPage, Reader } from '../../src/files/Reader.tsx'
import { ReaderLabelsContext, type ReaderLabels } from '../../src/files/marks.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { segmentsFor, segmentsFrom } from '../../src/files/views/common.tsx'
import { pickView, scoreViews, viewByType } from '../../src/files/views/registry.ts'
import { OBJECTS_SCORE, tableScore } from '../../src/files/views/table.tsx'
import { frontMatterLines, metaFields } from '../../src/files/views/text.tsx'
import transcript, { chatTurns, conversationTurns, idKey, madeBlocks, nameOf, parsedLines, pick, shortId, shownLines, speakerIds, textOf, timeOf, unwrapStream } from '../../src/files/views/transcript.tsx'
import { api } from '../../src/lib/api.ts'
import type { Concept, SourcePage, SourceRecord, TranscriptHint, View } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const NO_LABELS = { all: [], on: [], focus: null, byId: new Map(), presence: new Map() } as unknown as FilesLabels

const line = (n: number, text: string, turn?: { speaker: string; at: number; time?: string }): SourceRecord => ({
  line: n,
  record: { text },
  blocks: [{ kind: 'text', text }],
  meta: turn ? { turn } : {},
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('which mode a file opens in', () => {
  const text = (lines: string[]) => lines.map((t) => ({ text: t }))
  test('a chat log the sniff is sure of opens as a transcript, beside Raw; one it only offers it for keeps its own best mode', () => {
    const sure: TranscriptHint = { format: 'text', score: 0.95, style: 'colon' }
    const scored = scoreViews('logs/chat.txt', 'text', text(['User: hi', 'Assistant: hello']), sure)
    expect(pickView(scored).type).toBe('transcript')
    const md = scoreViews('notes/changelog.md', 'text', text(['### Added', '- x']), { format: 'text', score: 0.5, style: 'heading' })
    expect(pickView(md).type).toBe('text')
    expect(md.find((s) => s.def.type === 'transcript')!.score).toBeGreaterThan(0)
    const csv = scoreViews('chats/tickets.csv', 'text', text(['speaker,message', 'customer,hi']), { format: 'csv', score: 0.95, keys: { speaker: 'speaker', text: 'message' } })
    expect(pickView(csv).type).toBe('transcript')
  })
  test('records that are objects offer the Table under Raw when they are not flat, and flat ones open in it', () => {
    const turns = [1, 2, 3].map((i) => ({ id: `t${i}`, session_id: 's', agent_action: { command: `click ${i}` }, error: null, created_at: '2026-07-10 17:00' }))
    expect(tableScore(turns)).toBe(OBJECTS_SCORE)
    const scored = scoreViews('computer_use_turns.jsonl', 'text', turns, null)
    expect(pickView(scored).type).toBe('raw')
    expect(scored.find((s) => s.def.type === 'table')!.score).toBeGreaterThan(0)
    expect(tableScore([{ a: 1, b: 'x' }, { a: 2, b: 'y' }])).toBe(0.85)
    expect(tableScore([{ a: 1 }, 'a line'])).toBe(0)
  })
  test('without a sniff, a file is no transcript unless its records read as messages', () => {
    expect(scoreViews('notes.txt', 'text', text(['just prose']), null).find((s) => s.def.type === 'transcript')!.score).toBe(0)
    expect(transcript.match('a.jsonl', 'text', [{ author: 'a', body: 'x' }, { author: 'b', body: 'y' }])).toBe(0.9)
  })
})

describe('a text chat log as turns', () => {
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
  test('a line that starts a turn opens one, and the lines after it go on it', () => {
    const turns = chatTurns(records)
    expect(turns.map((t) => [t.line, t.end, t.turn?.speaker ?? null])).toEqual([
      [1, 1, null],
      [2, 2, 'User'],
      [3, 5, 'Assistant'],
      [6, 8, 'Human'],
    ])
    expect(shownLines(turns[2].recs, turns[2].turn).map((r) => r.line)).toEqual([3, 4])
    expect(shownLines(turns[3].recs, turns[3].turn).map((r) => r.line)).toEqual([6, 8])
  })
  test('the first line shows from where its words start, and a label span keeps the whole line’s offsets', () => {
    const block = { kind: 'text' as const, text: 'Assistant: the groupby test' }
    const segs = segmentsFrom(segmentsFor(block, [15, 22]), 11)
    expect(segs.map((s) => s.text).join('')).toBe('the groupby test')
    expect(segs.find((s) => s.cls === 'hl')).toMatchObject({ text: 'groupby', start: 15 })
  })
  test('the view draws a card per turn with its speaker, each line in its own record', async () => {
    const page: SourcePage = { path: 'logs/chat.md', kind: 'text', total_lines: 8, start: 1, records }
    const View = transcript.component
    const el = await mount(<View workspace="w" path="logs/chat.md" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'text', score: 0.95, style: 'colon' }} />)
    const cards = [...el.querySelectorAll('.reader-card')]
    expect(cards.map((c) => c.getAttribute('data-line'))).toEqual(['1', '2', '3', '6'])
    expect(cards.map((c) => c.querySelector('.reader-record-head')?.textContent ?? '')).toEqual(['', 'User', 'Assistant', 'Human'])
    expect(cards[2].textContent).toContain('the groupby test drops a key.It started with the patch.')
    expect(cards[2].textContent).not.toContain('Assistant:')
    expect([...cards[2].querySelectorAll('.reader-block')].map((b) => b.getAttribute('data-line'))).toEqual(['3', '4'])
  })
  test('a label on a line inside a turn shows in the gutter of the turn’s card', async () => {
    const flagged = { id: 'k1', name: 'Blames the patch', unit: 'record', labels: ['yes', 'no'], classes: [] } as unknown as Concept
    const ctx: ReaderLabels = {
      path: 'logs/chat.md',
      on: [flagged],
      lanes: [flagged],
      focus: 'k1',
      rows: new Map([['logs/chat.md#L4', new Map([['k1', { ref: 'logs/chat.md#L4', label: 'yes', confidence: null, source: null }]])]]),
      want: () => undefined,
    }
    const page: SourcePage = { path: 'logs/chat.md', kind: 'text', total_lines: 8, start: 1, records }
    const View = transcript.component
    const el = await mount(
      <ReaderLabelsContext.Provider value={ctx}>
        <View workspace="w" path="logs/chat.md" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'text', score: 0.95, style: 'colon' }} />
      </ReaderLabelsContext.Provider>,
    )
    const lit = (line: string) => !!el.querySelector(`.reader-card[data-line="${line}"] > .reader-gutter .reader-gutter-cell.is-lit`)
    expect(lit('3')).toBe(true)
    expect(lit('2')).toBe(false)
    expect(lit('6')).toBe(false)
  })
})

describe('messages in any shape', () => {
  test('who speaks, the words and the time, wherever a record keeps them', () => {
    const r = { message: { author: { name: 'bob' }, content: [{ type: 'text', text: 'hey' }, { type: 'text', text: 'there' }] }, ts: 1700000000 }
    expect(nameOf(pick(r, 'message.author'))).toBe('bob')
    expect(nameOf({ displayName: 'Ann', id: 7 })).toBe('Ann')
    expect(nameOf({ Full_Name: 'Ben' })).toBe('Ben')
    expect(textOf(pick(r, 'message.content'))).toBe('hey\n\nthere')
    expect(timeOf(pick(r, 'ts'))).toBe('2023-11-14 22:13')
    expect(timeOf('1700000000.0001')).toBe('2023-11-14 22:13')
    expect(timeOf('2024-10-01T09:00:00Z')).toBe('2024-10-01 09:00')
    expect(timeOf(12.5)).toBe('12.5')
    expect(textOf({ content_type: 'text', parts: ['a', 'b'] })).toBe('a\n\nb')
  })
  test('a CSV file’s rows show as posts under the columns the sniff named', async () => {
    const rows = ['timestamp,speaker,message', '2024-10-01T09:00:00Z,customer,"hello, there"', '2024-10-01T09:01:00Z,agent,hi']
    const page: SourcePage = { path: 'c.csv', kind: 'text', total_lines: 3, start: 1, records: rows.map((t, i) => line(i + 1, t)) }
    const View = transcript.component
    const hint: TranscriptHint = { format: 'csv', score: 0.95, keys: { speaker: 'speaker', text: 'message', time: 'timestamp' }, delimiter: ',' }
    const el = await mount(<View workspace="w" path="c.csv" kind="text" page={page} loadMore={() => undefined} transcript={hint} />)
    const heads = [...el.querySelectorAll('.reader-record-head')].map((h) => h.textContent)
    expect(heads).toEqual(['customer · 2024-10-01 09:00', 'agent · 2024-10-01 09:01'])
    expect(el.querySelector('.reader-card[data-line="2"]')?.textContent).toContain('hello, there')
  })
})

describe('JSON lines', () => {
  const View = transcript.component
  test('who speaks is the first of the keys the sniff names that a record holds', async () => {
    const records: SourceRecord[] = [
      { speakerName: 'host', content: 'Welcome.', timestamp: '2026-04-02T17:47:10Z' },
      { agentName: 'Agent A', goal: 'Look up charities', timestamp: '2026-04-02T17:48:02Z' },
    ].map((r, i) => ({ line: i + 1, record: r, blocks: [{ kind: 'text', text: String(r.content ?? '') }], meta: {} }))
    expect(pick(records[1].record, 'speakerName|agentName')).toBe('Agent A')
    expect(pick({ speakerName: '', agentName: 'b' }, 'speakerName|agentName')).toBe('b')
    const hint: TranscriptHint = { format: 'messages', score: 0.95, keys: { speaker: 'speakerName|agentName', text: 'content', time: 'timestamp' } }
    const page: SourcePage = { path: 'village.jsonl', kind: 'text', total_lines: 2, start: 1, records }
    const el = await mount(<View workspace="w" path="village.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={hint} />)
    expect([...el.querySelectorAll('.reader-record-head')].map((h) => h.textContent)).toEqual(['host · 2026-04-02 17:47', 'Agent A · 2026-04-02 17:48'])
  })
  test('a stream nested under a key in each record shows the nested records, their time the row’s', async () => {
    const rows = [
      { id: 'c1', created_at: '2026-03-24 20:51:20', content: { type: 'system', subtype: 'status', session_id: 's1' } },
      { id: 'c2', created_at: '2026-03-24 20:51:25', content: { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'I will list the files.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, { type: 'thinking', thinking: '' }] } } },
      { id: 'c3', created_at: '2026-03-24 20:51:27', content: { type: 'user', session_id: 's1', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'notes.txt' }] }] } } },
    ]
    const records: SourceRecord[] = rows.map((r, i) => ({ line: i + 1, record: r, blocks: [{ kind: 'raw', text: JSON.stringify(r) }], meta: {} }))
    const open = unwrapStream(records, 'content')
    expect(open[1].blocks).toEqual([
      { kind: 'text', text: 'I will list the files.' },
      { kind: 'tool_use', text: 'Bash\n{\n  "command": "ls"\n}' },
    ])
    expect(open[2].blocks).toEqual([{ kind: 'tool_result', text: 'notes.txt' }])
    expect(open[1].meta.timestamp).toBe('2026-03-24 20:51:25')
    const page: SourcePage = { path: 'sdk.jsonl', kind: 'text', total_lines: 3, start: 1, records }
    const el = await mount(<View workspace="w" path="sdk.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'stream', score: 1, wrap: 'content' }} />)
    const cards = [...el.querySelectorAll('.reader-card')]
    expect(cards.map((c) => c.getAttribute('data-line'))).toEqual(['2', '3'])
    expect(cards[0].querySelector('.reader-record-head')?.textContent).toBe('assistant · 2026-03-24 20:51')
    expect(cards[0].textContent).toContain('I will list the files.')
    expect(el.querySelector('.reader-syschip')?.textContent).toContain('1')
  })
  test('a record with no words to show gets no row, unless a citation points at it', async () => {
    const turn = (n: number, content: { type: string; text?: string; thinking?: string }[]): SourceRecord => ({
      line: n,
      record: { type: 'assistant', session_id: 's1', message: { role: 'assistant', content } },
      blocks: content.filter((c) => c.type === 'text').map((c) => ({ kind: 'text' as const, text: c.text ?? '' })),
      meta: {},
    })
    const records = [turn(1, [{ type: 'text', text: 'Reading the logs.' }]), turn(2, [{ type: 'thinking', thinking: '' }]), turn(3, [{ type: 'text', text: '  ' }]), turn(4, [{ type: 'text', text: 'Done.' }])]
    const page: SourcePage = { path: 's.jsonl', kind: 'agent', total_lines: 4, start: 1, records }
    const lines = (el: HTMLElement) => [...el.querySelectorAll('.reader-card')].map((c) => c.getAttribute('data-line'))
    expect(lines(await mount(<View workspace="w" path="s.jsonl" kind="agent" page={page} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />))).toEqual(['1', '4'])
    // jsdom has no scrollIntoView, which brings a citation's record into view
    Element.prototype.scrollIntoView = () => undefined
    try {
      expect(lines(await mount(<View workspace="w" path="s.jsonl" kind="agent" page={page} targetRef="s.jsonl#L2" loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />))).toEqual(['1', '2', '4'])
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
    const posts: SourceRecord[] = [
      { author: 'ana', body: 'hi' },
      { author: 'bo', body: '' },
    ].map((r, i) => ({ line: i + 1, record: r, blocks: [r.body ? { kind: 'text', text: r.body } : { kind: 'raw', text: JSON.stringify(r) }], meta: {} }))
    const board: SourcePage = { path: 'b.jsonl', kind: 'text', total_lines: 2, start: 1, records: posts }
    const hint: TranscriptHint = { format: 'messages', score: 0.95, keys: { speaker: 'author', text: 'body' } }
    expect(lines(await mount(<View workspace="w" path="b.jsonl" kind="text" page={board} loadMore={() => undefined} transcript={hint} />))).toEqual(['1'])
  })
  test('a stream the server keeps whole, one raw block per record, shows its turns as words', async () => {
    const rows = [
      { type: 'user', sessionId: 's1', message: { role: 'user', content: 'Which pages were reverted?' } },
      { type: 'assistant', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }] } },
      { type: 'assistant', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'The policy pages.' }] } },
    ]
    const records: SourceRecord[] = rows.map((r, i) => ({ line: i + 1, record: r, blocks: [{ kind: 'raw', text: JSON.stringify(r, null, 2) }], meta: {} }))
    expect(madeBlocks(records[2])).toEqual([{ kind: 'text', text: 'The policy pages.' }])
    expect(madeBlocks({ line: 4, record: { type: 'system' }, blocks: [{ kind: 'raw', text: '{}' }], meta: {} })).toBeNull()
    const page: SourcePage = { path: 'run.jsonl', kind: 'text', total_lines: 3, start: 1, records }
    const el = await mount(<View workspace="w" path="run.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />)
    const cards = [...el.querySelectorAll('.reader-card')]
    expect(cards.map((c) => c.getAttribute('data-line'))).toEqual(['1', '3'])
    expect(cards[1].textContent).toContain('The policy pages.')
    expect(el.textContent).not.toContain('"type"')
  })
  test('lines that each hold a conversation show one card per line, its turns inside', async () => {
    const records: SourceRecord[] = [1, 2].map((n) => ({
      line: n,
      record: { title: `chat ${n}`, messages: [{ role: 'user', content: `question ${n}` }, { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] }] },
      blocks: [],
      meta: {},
    }))
    const hint: TranscriptHint = { format: 'conversations', score: 0.95, keys: { list: 'messages', speaker: 'role', text: 'content' } }
    const page: SourcePage = { path: 'sft.jsonl', kind: 'text', total_lines: 2, start: 1, records }
    const el = await mount(<View workspace="w" path="sft.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={hint} />)
    const cards = [...el.querySelectorAll('.reader-card')]
    expect(cards.map((c) => c.getAttribute('data-line'))).toEqual(['1', '2'])
    expect(cards.map((c) => c.querySelector('.reader-record-head')?.textContent)).toEqual(['chat 1', 'chat 2'])
    expect([...cards[1].querySelectorAll('.reader-conv-speaker')].map((s) => s.textContent)).toEqual(['user', 'assistant'])
    expect(cards[1].textContent).toContain('question 2')
    expect(cards[1].textContent).toContain('an answer')
  })
  test('a prompt and its response read as two turns', () => {
    expect(conversationTurns({ prompt: 'p', response: 'r' }, { format: 'conversations', score: 0.95, pair: ['prompt', 'response'] })).toEqual([
      { speaker: 'prompt', text: 'p', time: null },
      { speaker: 'response', text: 'r', time: null },
    ])
    expect(conversationTurns({ other: 1 }, { format: 'conversations', score: 0.95, keys: { list: 'messages', speaker: 'role', text: 'content' } })).toBeNull()
  })
  test('JSON lines in a file the server pages as text are parsed here and show as posts', async () => {
    const texts = [JSON.stringify({ role: 'user', content: 'why does it fail?' }), 'not json', JSON.stringify({ role: 'assistant', content: 'a missing key' })]
    const records = texts.map((t, i) => line(i + 1, t))
    expect(parsedLines(records).map((r) => r.record.role ?? null)).toEqual(['user', null, 'assistant'])
    const hint: TranscriptHint = { format: 'messages', score: 0.95, lines: true, keys: { speaker: 'role', text: 'content' } }
    const page: SourcePage = { path: 'app.log', kind: 'text', total_lines: 3, start: 1, records }
    const el = await mount(<View workspace="w" path="app.log" kind="text" page={page} loadMore={() => undefined} transcript={hint} />)
    const heads = [...el.querySelectorAll('.reader-record-head')].map((h) => h.textContent)
    expect(heads).toEqual(['user', '(unsigned)', 'assistant'])
    expect(el.querySelector('.reader-card[data-line="3"]')?.textContent).toContain('a missing key')
  })
})

describe('a citation of words deep in a record', () => {
  const View = transcript.component
  const span = (path: string, line: number, block: string, words: string) => {
    const start = block.indexOf(words)
    expect(start).toBeGreaterThan(0)
    return `${path}#L${line}.b0:c${start}-${start + words.length}`
  }
  const withScroll = async (run: () => Promise<void>) => {
    // jsdom has no scrollIntoView, which brings a citation's record into view
    Element.prototype.scrollIntoView = () => undefined
    try {
      await run()
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  }
  test('opens the field of a post with no words that holds them, whole, and highlights them', async () => {
    const letter = `Subject: a framework\n\n${'Some earlier lines of the letter. '.repeat(30)}It was tested under "pressure"\nin May.${' Later lines.'.repeat(20)}`
    const rows = [
      { id: 'e1', data: { agentId: 'a-1', content: 'Sending the letter now.' }, created_at: '2026-07-08 17:40:00' },
      { id: 'e2', data: { agentId: 'a-1', actionType: 'OUTREACH', recipient: 'a researcher', messageContent: letter }, created_at: '2026-07-08 17:46:35' },
    ]
    const records: SourceRecord[] = rows.map((r, i) => ({ line: i + 1, record: r, blocks: [i === 0 ? { kind: 'event', text: r.data.content! } : { kind: 'raw', text: JSON.stringify(r, null, 2) }], meta: {} }))
    const hint: TranscriptHint = { format: 'messages', score: 0.5, keys: { speaker: 'data.speakerId|data.agentId', text: 'data.content', time: 'created_at' } }
    const page: SourcePage = { path: 'events.jsonl', kind: 'events', total_lines: 2, start: 1, records }
    const ref = span('events.jsonl', 2, records[1].blocks[0].text, 'tested under \\"pressure\\"\\nin May')
    vi.spyOn(api, 'speakerNames').mockResolvedValue({ names: {} })
    await withScroll(async () => {
      const el = await mount(<View workspace="w" path="events.jsonl" kind="events" page={page} targetRef={ref} loadMore={() => undefined} transcript={hint} />)
      const open = el.querySelector('.reader-card[data-line="2"] .reader-msg-field-open')!
      expect(open.querySelector('.reader-msg-field')?.textContent).toBe('messageContent')
      expect(open.querySelector('.hl')?.textContent).toBe('tested under "pressure"\nin May')
      expect(open.textContent).toContain('Later lines. Later lines.')
      expect(el.querySelector('.reader-card[data-line="2"]')?.textContent).toContain('recipient a researcher')
    })
  })
  test('marks them in the words of a post, and in a nested record’s blocks, where the server’s offsets do not apply', async () => {
    const posts = [
      { author: 'ana', body: 'First a note.' },
      { author: 'bo', body: `${'filler words '.repeat(40)}the key was dropped` },
    ]
    const records: SourceRecord[] = posts.map((r, i) => ({ line: i + 1, record: r, blocks: [{ kind: 'raw', text: JSON.stringify(r, null, 2) }], meta: {} }))
    const board: SourcePage = { path: 'b.jsonl', kind: 'text', total_lines: 2, start: 1, records }
    const hint: TranscriptHint = { format: 'messages', score: 0.95, keys: { speaker: 'author', text: 'body' } }
    await withScroll(async () => {
      const el = await mount(<View workspace="w" path="b.jsonl" kind="text" page={board} targetRef={span('b.jsonl', 2, records[1].blocks[0].text, 'key was dropped')} loadMore={() => undefined} transcript={hint} />)
      expect(el.querySelector('.reader-card[data-line="2"] .hl')?.textContent).toBe('key was dropped')
    })
    const sdk = { id: 'c2', content: { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: 'I will grep for "retraction" in the notes.' }] } } }
    const stream: SourcePage = { path: 'sdk.jsonl', kind: 'text', total_lines: 1, start: 1, records: [{ line: 1, record: sdk, blocks: [{ kind: 'raw', text: JSON.stringify(sdk, null, 2) }], meta: {} }] }
    await withScroll(async () => {
      const el = await mount(<View workspace="w" path="sdk.jsonl" kind="text" page={stream} targetRef={span('sdk.jsonl', 1, stream.records[0].blocks[0].text, '\\"retraction\\" in')} loadMore={() => undefined} transcript={{ format: 'stream', score: 1, wrap: 'content' }} />)
      const hl = el.querySelector('.reader-block[data-block="1"] .hl')
      expect(hl?.textContent).toBe('"retraction" in')
    })
  })
})

describe('speakers named only by id', () => {
  const View = transcript.component
  const ids = ['6365764a-b6e2-4dfa-94cd-2d1aef5b54f7', 'b699b1e2-389e-4eea-bd5c-dbfb020a8996']
  const rows = [
    { id: 'm1', agent_speaker_id: ids[0], user_speaker_id: null, content: 'first', created_at: '2026-07-10 21:09:27' },
    { id: 'm2', agent_speaker_id: null, user_speaker_id: ids[1], content: 'second', created_at: '2026-07-10 21:10:00' },
  ]
  const records: SourceRecord[] = rows.map((r, i) => ({ line: i + 1, record: r, blocks: [{ kind: 'raw', text: JSON.stringify(r) }], meta: {} }))
  const hint: TranscriptHint = { format: 'messages', score: 0.5, keys: { speaker: 'agent_speaker_id|user_speaker_id', text: 'content', time: 'created_at' } }
  test('a key that holds ids, or a value shaped as one, names the speaker by id', () => {
    expect(idKey('agent_speaker_id|user_speaker_id')).toBe(true)
    expect(idKey('data.speakerId|data.agentId')).toBe(true)
    expect(idKey('speakerName|agentName')).toBe(false)
    expect(speakerIds(records, hint.keys!.speaker)).toEqual(ids)
    expect(speakerIds([{ line: 1, record: { author: ids[0] }, blocks: [], meta: {} }, { line: 2, record: { author: 'GPT-5.5' }, blocks: [], meta: {} }], 'author')).toEqual([ids[0]])
    expect(shortId(ids[0])).toBe('6365764a…')
    expect(shortId('u-17')).toBe('u-17')
  })
  test('shows the name the corpus gives an id, else the id shortened, the whole id on hover', async () => {
    const asked = vi.spyOn(api, 'speakerNames').mockResolvedValue({ names: { [ids[0]]: 'GPT-5.5' } })
    const page: SourcePage = { path: 'chat_messages.jsonl', kind: 'text', total_lines: 2, start: 1, records }
    const el = await mount(<View workspace="names-test" path="chat_messages.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={hint} />)
    await settle()
    expect(asked).toHaveBeenCalledWith('names-test', 'chat_messages.jsonl', 'agent_speaker_id|user_speaker_id', ids.join(','))
    const heads = [...el.querySelectorAll('.reader-record-head')]
    expect(heads.map((h) => h.textContent)).toEqual(['GPT-5.5 · 2026-07-10 21:09', 'b699b1e2… · 2026-07-10 21:10'])
    expect(heads.map((h) => h.querySelector('[title]')?.getAttribute('title'))).toEqual(ids)
  })
})

describe('a markdown file’s front matter', () => {
  const doc = ['---', 'pretty_name: Toy village', 'license: "other"', 'tags:', '  - agents', '  - logs', 'summary: >-', '  A few agents', '  and their logs.', 'configs:', '  - config_name: events', '    data_files: events.jsonl.gz', '---', '', '# Toy village', '', 'Logs of a few agents.']
  test('is found between its fences, and its fields read one per row', () => {
    expect(frontMatterLines(doc)).toBe(13)
    expect(frontMatterLines(['# Title', '---'])).toBe(0)
    expect(frontMatterLines(['---', 'no end'])).toBe(0)
    expect(frontMatterLines(['+++', 'title = "x"', '+++'])).toBe(3)
    expect(frontMatterLines(['---', '', 'An intro set between two rules.', '', '---', '# Title'])).toBe(0)
    expect(frontMatterLines(['---', '# a comment', '_draft: true', '---'])).toBe(4)
    expect(metaFields(doc.slice(1, 12))).toEqual([
      { key: 'pretty_name', value: 'Toy village' },
      { key: 'license', value: 'other' },
      { key: 'tags', value: 'agents, logs' },
      { key: 'summary', value: 'A few agents and their logs.' },
      { key: 'configs', block: '- config_name: events\n  data_files: events.jsonl.gz' },
    ])
  })
  test('shows folded above the rendered document, which starts after it', async () => {
    const page: SourcePage = { path: 'README.md', kind: 'text', total_lines: doc.length, start: 1, records: doc.map((t, i) => line(i + 1, t)) }
    const View = viewByType('text')!.component
    const el = await mount(<View workspace="w" path="README.md" kind="text" page={page} loadMore={() => undefined} />)
    const toggle = el.querySelector('.reader-md-meta-toggle') as HTMLElement
    expect(toggle.textContent).toBe('Metadata5 fields')
    expect(el.querySelector('.reader-md-meta-fields')).toBeNull()
    expect(el.querySelector('.reader-md h1')?.getAttribute('data-anchor')).toBe('README.md#L15')
    expect(el.textContent).not.toContain('pretty_name')
    await act(async () => toggle.click())
    expect([...el.querySelectorAll('.reader-md-meta-fields dt')].map((d) => d.textContent)).toEqual(['pretty_name', 'license', 'tags', 'summary', 'configs'])
  })
})

describe('a whole-file JSON transcript', () => {
  test('a turn’s card shows the labels of the lines up to the next turn', async () => {
    vi.spyOn(api, 'sourceTurns').mockResolvedValue({
      path: 'e.json',
      total: 2,
      start: 0,
      n_groups: 1,
      groups: { '0': { title: '', first: 0 } },
      turns: [
        { i: 0, line: 3, speaker: 'user', role: 'user', text: 'why does it fail?', group: 0 },
        { i: 1, line: 9, speaker: 'assistant', role: 'assistant', text: 'a missing key', group: 0 },
      ],
    })
    const flagged = { id: 'k1', name: 'Asks why', unit: 'record', labels: ['yes', 'no'], classes: [] } as unknown as Concept
    const ctx: ReaderLabels = {
      path: 'e.json',
      on: [flagged],
      lanes: [flagged],
      focus: 'k1',
      rows: new Map([['e.json#L5', new Map([['k1', { ref: 'e.json#L5', label: 'yes', confidence: null, source: null }]])]]),
      want: () => undefined,
    }
    const page: SourcePage = { path: 'e.json', kind: 'text', total_lines: 12, start: 1, records: [] }
    const View = transcript.component
    const el = await mount(
      <ReaderLabelsContext.Provider value={ctx}>
        <View workspace="w" path="e.json" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'json', score: 0.95 }} />
      </ReaderLabelsContext.Provider>,
    )
    await settle()
    const lit = (line: string) => !!el.querySelector(`.reader-card[data-line="${line}"] > .reader-gutter .reader-gutter-cell.is-lit`)
    expect([...el.querySelectorAll('.reader-card')].map((c) => c.getAttribute('data-line'))).toEqual(['3', '9'])
    expect(lit('3')).toBe(true)
    expect(lit('9')).toBe(false)
  })
  test('a turn with no words gets no card: the card before shows its labels, and a conversation it opens keeps its title', async () => {
    vi.spyOn(api, 'sourceTurns').mockResolvedValue({
      path: 'e.json',
      total: 4,
      start: 0,
      n_groups: 2,
      groups: { '0': { title: '', first: 0 }, '1': { title: '', first: 2 } },
      turns: [
        { i: 0, line: 3, speaker: 'user', role: 'user', text: 'why does it fail?', group: 0 },
        { i: 1, line: 6, speaker: 'assistant', role: 'assistant', text: '  ', group: 0 },
        { i: 2, line: 9, speaker: 'system', role: 'system', text: '', group: 1 },
        { i: 3, line: 11, speaker: 'user', role: 'user', text: 'and now?', group: 1 },
      ],
    })
    const flagged = { id: 'k1', name: 'Asks why', unit: 'record', labels: ['yes', 'no'], classes: [] } as unknown as Concept
    const ctx: ReaderLabels = {
      path: 'e.json',
      on: [flagged],
      lanes: [flagged],
      focus: 'k1',
      rows: new Map([['e.json#L7', new Map([['k1', { ref: 'e.json#L7', label: 'yes', confidence: null, source: null }]])]]),
      want: () => undefined,
    }
    const page: SourcePage = { path: 'e.json', kind: 'text', total_lines: 12, start: 1, records: [] }
    const View = transcript.component
    const el = await mount(
      <ReaderLabelsContext.Provider value={ctx}>
        <View workspace="w" path="e.json" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'json', score: 0.95 }} />
      </ReaderLabelsContext.Provider>,
    )
    await settle()
    expect([...el.querySelectorAll('.reader-card')].map((c) => c.getAttribute('data-line'))).toEqual(['3', '11'])
    expect(!!el.querySelector('.reader-card[data-line="3"] > .reader-gutter .reader-gutter-cell.is-lit')).toBe(true)
    expect([...el.querySelectorAll('.reader-session')].map((s) => s.textContent)).toEqual(['Conversation 1', 'Conversation 2'])
  })
  test('a citation of words opens at the turn the server finds holding them, among turns that share a line, and marks them', async () => {
    const turns = vi.spyOn(api, 'sourceTurns').mockResolvedValue({
      path: 'm.json',
      total: 2,
      start: 0,
      n_groups: 1,
      groups: { '0': { title: '', first: 0 } },
      turns: [
        { i: 0, line: 1, speaker: 'user', role: 'user', text: 'why does the build fail?', group: 0 },
        { i: 1, line: 1, speaker: 'assistant', role: 'assistant', text: 'The groupby test drops the NaN key.', group: 0 },
      ],
      cited: { i: 1, quote: 'drops the NaN key' },
    })
    const page: SourcePage = { path: 'm.json', kind: 'text', total_lines: 1, start: 1, records: [] }
    const View = transcript.component
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? '')
    }
    try {
      const el = await mount(<View workspace="w" path="m.json" kind="text" page={page} targetRef="m.json#L1.b0:c120-137" loadMore={() => undefined} transcript={{ format: 'json', score: 0.95 }} />)
      await settle()
      expect(turns).toHaveBeenCalledWith('w', 'm.json', 0, expect.any(Number), 1, { block: 0, start: 120, end: 137 })
      const [first, second] = [...el.querySelectorAll('.reader-card')]
      expect(second.classList.contains('reader-target')).toBe(true)
      expect(second.querySelector('.hl')?.textContent).toBe('drops the NaN key')
      expect(first.classList.contains('reader-target')).toBe(false)
      expect(first.querySelector('.hl')).toBeNull()
      expect(scrolled[0]).toBe('drops the NaN key')
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })
  test('a turn with no words inside a conversation gets no row', async () => {
    const records: SourceRecord[] = [{ line: 1, record: { messages: [{ role: 'system', content: '' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: null }] }, blocks: [], meta: {} }]
    const hint: TranscriptHint = { format: 'conversations', score: 0.95, keys: { list: 'messages', speaker: 'role', text: 'content' } }
    const page: SourcePage = { path: 'sft.jsonl', kind: 'text', total_lines: 1, start: 1, records }
    const View = transcript.component
    const el = await mount(<View workspace="w" path="sft.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={hint} />)
    expect([...el.querySelectorAll('.reader-conv-speaker')].map((s) => s.textContent)).toEqual(['user'])
    expect(el.textContent).not.toContain('(empty)')
  })
})

describe('a PDF ref', () => {
  test('opens at the page it names', () => {
    expect(pdfPage('docs/a.pdf#p4', 'docs/a.pdf')).toBe(4)
    expect(pdfPage('docs/a.pdf#p4-p6', 'docs/a.pdf')).toBe(4)
    expect(pdfPage('docs/a.pdf#page=2', 'docs/a.pdf')).toBe(2)
    expect(pdfPage('docs/a.pdf', 'docs/a.pdf')).toBeNull()
    expect(pdfPage('docs/b.pdf#p3', 'docs/a.pdf')).toBeNull()
    expect(pdfPage('docs/a.pdf#p0', 'docs/a.pdf')).toBeNull()
  })
  test('the File browser shows the PDF itself in the browser’s viewer, at the page, or says the browser cannot', async () => {
    const show = async (inPage: boolean) => {
      Object.defineProperty(navigator, 'pdfViewerEnabled', { value: inPage, configurable: true })
      return mount(<Reader workspace="w" path="docs/a b.pdf" kind="text" targetRef="docs/a b.pdf#p3" labels={NO_LABELS} lead={<span />} />)
    }
    const frame = (await show(true)).querySelector('iframe.reader-pdf-frame')
    expect(frame?.getAttribute('src')).toBe('/api/corpora/w/pdf/docs/a%20b.pdf#page=3')
    const none = await show(false)
    expect(none.querySelector('iframe')).toBeNull()
    expect(none.textContent).toContain('Open the PDF')
  })
  test('the viewers made for PDFs stand beside it in the mode switch, a fragment one reads opens it, and file labels show', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
    const pages = { slug: 'pages', name: 'Pages', ok: true, file_type: true, accepts: [{ form: 'page-<n>' }], claims: ['**/*.pdf'] } as unknown as View
    vi.spyOn(api, 'viewsForFile').mockResolvedValue([pages])
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: true, configurable: true })
    const audited = { id: 'k1', name: 'Audited', unit: 'file', labels: ['yes', 'no'], classes: [] } as unknown as Concept
    const labels = { ...NO_LABELS, on: [audited], presence: new Map([['k1', { 'docs/a.pdf': { yes: 1 } }]]) } as unknown as FilesLabels
    const el = await mount(<Reader workspace="w" path="docs/a.pdf" kind="text" targetRef="docs/a.pdf#p2" labels={labels} lead={<span />} />)
    await settle()
    const modes = [...el.querySelectorAll('.reader-modes [role="radio"], .reader-modes button:not(.seg-remove)')].map((b) => b.textContent)
    expect(modes).toEqual(['PDF', 'Pages'])
    expect(el.querySelector('.reader-modes .seg-remove')?.getAttribute('aria-label')).toBe('Delete Pages')
    expect(el.querySelector('iframe.reader-pdf-frame')).not.toBeNull()
    expect(el.querySelector('.reader-filelabel')?.textContent).toBe('Audited')
    unmountAll()
    vi.spyOn(api, 'viewsForFile').mockResolvedValue([pages])
    const other = await mount(<Reader workspace="w" path="docs/a.pdf" kind="text" targetRef="docs/a.pdf#page-2" labels={NO_LABELS} lead={<span />} />)
    await settle()
    expect(other.querySelector('.reader-viewer')).not.toBeNull()
    expect(other.querySelector('iframe.reader-pdf-frame')).toBeNull()
    const pdf = [...other.querySelectorAll('.reader-modes [role="radio"], .reader-modes button')].find((b) => b.textContent === 'PDF') as HTMLElement
    await act(async () => pdf.click())
    expect(other.querySelector('iframe.reader-pdf-frame')).not.toBeNull()
    expect(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes('viewOf:docs/a.pdf')) ?? '')).toContain('pdf')
  })
})
