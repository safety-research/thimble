// @vitest-environment jsdom
// The Transcript view for an agent transcript whose records interleave spoken turns with tool records (the sniff's
// `tools`): a tool call and its cleaned result as blocks, a reply's <thinking> as a quiet block, one line per tool and
// system message with click to expand, a Raw toggle for the stored terminal bytes, the record's label gutter, and a
// citation of words in a result (src/files/views/transcript.tsx).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import transcript, { agentDisplay, callGloss, splitThinking, toolParts } from '../../src/files/views/transcript.tsx'
import { ReaderLabelsContext, type ReaderLabels } from '../../src/files/marks.tsx'
import type { Concept, SourcePage, SourceRecord, TranscriptHint } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const HINT: TranscriptHint = { format: 'messages', score: 0.95, tools: true, keys: { speaker: 'role', text: 'content', time: 'timestamp' } }
const KEYS = { author: 'role', body: 'content', time: 'timestamp' } as const
const DIRTY = 'file1\nfile2\n<counter>3</counter> user@host:~$ done     \b\b\b\b\b\n'

const rec = (line: number, record: any): SourceRecord => ({ line, record, blocks: [{ kind: 'raw', text: JSON.stringify(record) }], meta: {} })
const RECORDS: SourceRecord[] = [
  rec(1, { role: 'System', type: 'TextMessage', timestamp: '2026-07-18T21:29:27Z', content: 'You have access to tools. Read the instructions.' }),
  rec(2, { role: 'Assistant', type: 'TextMessage', timestamp: '2026-07-18T21:30:00Z', content: "<thinking>I will look at the directory first.</thinking>\n\nListing the files now." }),
  rec(3, { role: 'Assistant', type: 'ToolMessage', timestamp: '2026-07-18T21:30:05Z', tool_name: 'terminal', tool_call: { text: 'ls -la' }, tool_result: DIRTY }),
]
const page: SourcePage = { path: 'transcript.jsonl', kind: 'text', total_lines: 3, start: 1, records: RECORDS }
const View = transcript.component

describe('reading an agent record', () => {
  test('splits a reply’s thinking from its words', () => {
    expect(splitThinking('<thinking>hmm</thinking>\n\nthe answer')).toEqual({ thinking: 'hmm', reply: 'the answer' })
    expect(splitThinking('no thinking here')).toEqual({ thinking: null, reply: 'no thinking here' })
  })
  test('reads a tool record’s name, call and result, a null call as absent', () => {
    expect(toolParts({ tool_name: 'terminal', tool_call: { text: 'ls' }, tool_result: 'out' })).toEqual({ name: 'terminal', call: { text: 'ls' }, result: 'out' })
    expect(toolParts({ tool_name: 'create_tool', tool_call: null, tool_result: '[redacted]' })).toEqual({ name: 'create_tool', call: undefined, result: '[redacted]' })
    expect(toolParts({ role: 'Assistant', content: 'hi' })).toBeNull()
  })
  test('glosses a call on one line from its telling field', () => {
    expect(callGloss({ text: 'ls -la', timeout: 30 })).toBe('ls -la')
    expect(callGloss({ path: '/tmp/x.py', file_text: '...' })).toBe('/tmp/x.py')
    expect(callGloss({ a: 1, b: 2 })).toBe('a, b')
  })
  test('a tool record becomes a tool_use block and a cleaned result, with the stored bytes kept for Raw', () => {
    const msg = agentDisplay(RECORDS[2].record, KEYS)
    expect(msg.kind).toBe('tool')
    expect(msg.toolName).toBe('terminal')
    expect(msg.summary).toBe('terminal  ls -la')
    expect(msg.blocks[0]).toEqual({ kind: 'tool_use', text: 'terminal\n{\n  "text": "ls -la"\n}' })
    expect(msg.blocks[1].kind).toBe('tool_result')
    expect(msg.blocks[1].text).not.toContain('<counter>')
    expect(msg.blocks[1].text).not.toContain('\b')
    expect(msg.blocks[1].text).toContain('user@host:~$ done')
    expect(msg.blocks[1].raw).toBe(DIRTY)
  })
  test('a reply with thinking becomes a quiet thinking block then its words; a system record its words', () => {
    const asst = agentDisplay(RECORDS[1].record, KEYS)
    expect(asst.kind).toBe('text')
    expect(asst.blocks.map((b) => b.kind)).toEqual(['thinking', 'text'])
    expect(asst.summary).toBe('Listing the files now.')
    expect(agentDisplay(RECORDS[0].record, KEYS).kind).toBe('system')
  })
})

describe('the agent transcript view', () => {
  test('heads name the speaker, the tool and the time; tool and system fold to one line, a reply shows', async () => {
    const el = await mount(<View workspace="w" path="transcript.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={HINT} />)
    const heads = [...el.querySelectorAll('.reader-record-head')].map((h) => h.textContent)
    expect(heads).toEqual(['System · 2026-07-18 21:29', 'Assistant · 2026-07-18 21:30', 'Assistant · terminal · 2026-07-18 21:30'])
    // the reply is shown (its thinking a quiet block), the system and tool messages are one line
    const card = (line: string) => el.querySelector(`.reader-card[data-line="${line}"]`)!
    expect(card('2').querySelector('.reader-msg-oneline')).toBeNull()
    expect(card('2').querySelector('.reader-thinking')?.textContent).toContain('look at the directory')
    expect(card('2').textContent).toContain('Listing the files now.')
    expect(card('1').querySelector('.reader-msg-oneline')?.textContent).toContain('You have access to tools')
    expect(card('3').querySelector('.reader-msg-oneline')?.textContent).toBe('terminal  ls -la')
    // the folded tool result keeps its full, cleaned text in the DOM for a search to find
    expect(card('3').querySelector('.reader-msgfold-full')?.textContent).toContain('user@host:~$ done')
    expect(el.textContent).not.toContain('<counter>')
  })
  test('clicking a folded tool message opens it; Raw shows the stored bytes, Cleaned hides them again', async () => {
    const el = await mount(<View workspace="w" path="transcript.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={HINT} />)
    const card = el.querySelector('.reader-card[data-line="3"]')! as HTMLElement
    await act(async () => (card.querySelector('.reader-msg-oneline') as HTMLElement).click())
    expect(card.querySelector('.reader-msg-oneline')).toBeNull()
    expect(card.querySelector('.reader-tool_use')?.textContent).toContain('terminal')
    const result = card.querySelector('.reader-tool_result')!
    expect(result.textContent).toContain('user@host:~$ done')
    expect(result.textContent).not.toContain('<counter>')
    const raw = card.querySelector('.reader-raw-toggle') as HTMLElement
    expect(raw.textContent).toBe('Raw')
    await act(async () => raw.click())
    expect(card.querySelector('.reader-tool_result')?.textContent).toContain('<counter>3</counter>')
    expect((card.querySelector('.reader-raw-toggle') as HTMLElement).textContent).toBe('Cleaned')
  })
  test('a label on a record lights its gutter at the left edge', async () => {
    const flagged = { id: 'k1', name: 'Ran a scan', unit: 'record', labels: ['yes', 'no'], classes: [] } as unknown as Concept
    const ctx: ReaderLabels = {
      path: 'transcript.jsonl',
      on: [flagged],
      lanes: [flagged],
      focus: 'k1',
      rows: new Map([['transcript.jsonl#L3', new Map([['k1', { ref: 'transcript.jsonl#L3', label: 'yes', confidence: null, source: null }]])]]),
      want: () => undefined,
    }
    const el = await mount(
      <ReaderLabelsContext.Provider value={ctx}>
        <View workspace="w" path="transcript.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={HINT} />
      </ReaderLabelsContext.Provider>,
    )
    const lit = (line: string) => !!el.querySelector(`.reader-card[data-line="${line}"] > .reader-gutter .reader-gutter-cell.is-lit`)
    expect(lit('3')).toBe(true)
    expect(lit('2')).toBe(false)
  })
  test('a Claude Code stream tool result is cleaned too, with Raw for the stored bytes, and a clean result is unchanged', async () => {
    const dirtyRec = { type: 'user', session_id: 's1', message: { role: 'user', content: [{ type: 'tool_result', content: DIRTY }] } }
    const cleanRec = { type: 'user', session_id: 's1', message: { role: 'user', content: [{ type: 'tool_result', content: 'all good\nno control bytes' }] } }
    const records: SourceRecord[] = [
      { line: 1, record: { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'Running it.' }] } }, blocks: [{ kind: 'text', text: 'Running it.' }], meta: {} },
      { line: 2, record: dirtyRec, blocks: [{ kind: 'tool_result', text: DIRTY }], meta: {} },
      { line: 3, record: cleanRec, blocks: [{ kind: 'tool_result', text: 'all good\nno control bytes' }], meta: {} },
    ]
    const streamPage: SourcePage = { path: 'run.jsonl', kind: 'text', total_lines: 3, start: 1, records }
    const el = await mount(<View workspace="w" path="run.jsonl" kind="text" page={streamPage} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />)
    const dirty = el.querySelector('.reader-card[data-line="2"]')!
    expect(dirty.querySelector('.reader-tool_result')?.textContent).toContain('user@host:~$ done')
    expect(dirty.querySelector('.reader-tool_result')?.textContent).not.toContain('<counter>')
    expect((dirty.querySelector('.reader-raw-toggle') as HTMLElement).textContent).toBe('Raw')
    await act(async () => (dirty.querySelector('.reader-raw-toggle') as HTMLElement).click())
    expect(dirty.querySelector('.reader-tool_result')?.textContent).toContain('<counter>3</counter>')
    // a clean result needs no toggle and is shown as stored
    const clean = el.querySelector('.reader-card[data-line="3"]')!
    expect(clean.querySelector('.reader-raw-toggle')).toBeNull()
    expect(clean.querySelector('.reader-tool_result')?.textContent).toContain('all good')
  })
  test('a citation of words in a tool result opens the message and highlights them', async () => {
    Element.prototype.scrollIntoView = () => undefined
    try {
      const el = await mount(<View workspace="w" path="transcript.jsonl" kind="text" page={page} targetRef="transcript.jsonl#L3" loadMore={() => undefined} transcript={HINT} />)
      const card = el.querySelector('.reader-card[data-line="3"]')!
      // the cited message is open (no one-line summary), its result shown
      expect(card.querySelector('.reader-msg-oneline')).toBeNull()
      expect(card.classList.contains('reader-target')).toBe(true)
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })
})
