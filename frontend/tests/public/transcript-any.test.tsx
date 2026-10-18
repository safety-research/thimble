// @vitest-environment jsdom
// Transcript for anything close to a transcript, and a PDF as itself: the server's sniff decides the mode, a text chat
// log reads as turns whose lines keep their own records, and a PDF ref opens at its page; records that are objects
// offer the Table, a citation of words deep in a record marks them, speakers named only by id show the corpus's names
// for them, and a markdown file's front matter shows folded; a whole-file JSON transcript's turns (an ATIF trajectory's
// steps) are what Color by colors and Filter by hides, by the fields the server gives each
// (src/files/views/transcript.tsx, table.tsx, text.tsx, src/files/views/registry.ts, src/files/Reader.tsx).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { pdfPage, pickKey, Reader } from '../../src/files/Reader.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { pickView, scoreViews } from '../../src/files/views/registry.ts'
import transcript, { nameOf, pick, textOf, timeOf } from '../../src/files/views/transcript.tsx'
import { api } from '../../src/lib/api.ts'
import type { SourcePage, SourceRecord, TranscriptHint } from '../../src/lib/types.ts'
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
})

describe('a whole-file JSON transcript', () => {
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
      expect(turns).toHaveBeenCalledWith('w', 'm.json', 0, expect.any(Number), 1, { block: 0, start: 120, end: 137 }, undefined)
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
})

describe('a citation of a whole JSON document\'s message by its pointer', () => {
  test('opens at the turn the server finds that message is, though every record of the one-line document starts on line 1', async () => {
    const turns = vi.spyOn(api, 'sourceTurns').mockResolvedValue({
      path: 'chats/u7.json',
      total: 3,
      start: 0,
      n_groups: 1,
      groups: { '0': { title: 'c1', first: 0 } },
      turns: [
        { i: 0, line: 1, speaker: 'system', role: 'system', text: 'You maintain the ledger.' },
        { i: 1, line: 1, speaker: 'assistant', role: 'assistant', text: 'VOTE: lottery', group: 0, ref: 'chats/u7.json#/messages/9a1f' },
        { i: 2, line: 1, speaker: 'user', role: 'user', text: 'pushed', group: 0, ref: 'chats/u7.json#/messages/9a20' },
      ],
      target: 1,
    })
    const page: SourcePage = { path: 'chats/u7.json', kind: 'text', total_lines: 1, start: 1, records: [] }
    const View = transcript.component
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? '')
    }
    try {
      const el = await mount(<View workspace="w" path="chats/u7.json" kind="text" page={page} targetRef="chats/u7.json#/messages/9a1f" loadMore={() => undefined} transcript={{ format: 'json', score: 0.95 }} />)
      await settle()
      expect(turns.mock.calls[0]?.[6]).toBe('chats/u7.json#/messages/9a1f')
      const cards = [...el.querySelectorAll('.reader-card')]
      expect(cards.map((c) => c.classList.contains('reader-target'))).toEqual([false, true, false])
      expect(scrolled[0]).toContain('VOTE: lottery')
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  test('the reader gives its Transcript mode the pointer itself, not the line the server placed the record on', async () => {
    const text = '{"system": "You maintain the ledger.", "messages": {"9a1f": {"role": "assistant", "content": "VOTE: lottery"}}}'
    const page: SourcePage = { path: 'chats/u7.json', kind: 'text', total_lines: 1, start: 1, records: [line(1, text)], transcript: { format: 'json', score: 0.95 } }
    vi.spyOn(api, 'source').mockResolvedValue(page)
    vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: 'chats/u7.json#/messages/9a1f', kind: 'pointer', meta: { line: 1, end_line: 1 } } as never)
    const turns = vi.spyOn(api, 'sourceTurns').mockResolvedValue({ path: 'chats/u7.json', total: 0, start: 0, n_groups: 0, groups: {}, turns: [] })
    localStorage.setItem(pickKey('w', 'chats/u7.json'), JSON.stringify('transcript'))
    await mount(<Reader workspace="w" path="chats/u7.json" kind="text" labels={NO_LABELS} lead={<span />} targetRef="chats/u7.json#/messages/9a1f" />)
    await settle()
    await settle()
    expect(turns).toHaveBeenCalled()
    expect(turns.mock.calls.every((c) => c[6] === 'chats/u7.json#/messages/9a1f' && c[4] === undefined)).toBe(true)
  })
})

describe('a file whose whole parse finds no turns', () => {
  test('opens in the mode it would otherwise use, not an error, and the Transcript mode is no longer offered', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
    const text = '{"items": {"k1": {"role": "user", "content": "hi"}, "k2": {"role": "assistant", "content": "hello"}}}'
    const page: SourcePage = { path: 'logs/keyed.json', kind: 'text', total_lines: 1, start: 1, records: [line(1, text)], transcript: { format: 'json', score: 0.95 } }
    vi.spyOn(api, 'source').mockResolvedValue(page)
    const turns = vi.spyOn(api, 'sourceTurns').mockRejectedValue(new Error('415 logs/keyed.json holds no messages to show as a transcript'))
    // a Transcript pick remembered for the file gives way too
    localStorage.setItem(pickKey('w', 'logs/keyed.json'), JSON.stringify('transcript'))
    const el = await mount(<Reader workspace="w" path="logs/keyed.json" kind="text" labels={NO_LABELS} lead={<span />} />)
    await settle()
    await settle()
    expect(turns).toHaveBeenCalled()
    expect(el.textContent).not.toContain('holds no messages')
    const modes = [...el.querySelectorAll('.reader-modes [role="radio"], .reader-modes button')].map((b) => b.textContent)
    expect(modes).not.toContain('Transcript')
    expect(el.querySelector('.reader-turns')).toBeNull()
    expect(el.textContent).toContain('"role": "user"')
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
})
