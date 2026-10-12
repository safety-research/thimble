// @vitest-environment jsdom
// What a turn holds beyond its words, in any format the sniff reads: its reasoning, its tool calls (name and arguments)
// and their results, as the server reads them (backend transcripts.turn_blocks), shown as the blocks a Claude Code
// stream's records get: a whole-file JSON transcript's turns (an ATIF trajectory's steps), JSON lines of messages and
// JSON lines that each hold a conversation; a turn with a tool call folds to one line, as a stream's record does; a
// Claude Code stream shows as before; a whole-file JSON transcript's row shows the turn's own number, not the file's line,
// and a label of its JSON document's records (by pointer) colors and filters exactly the turns that are those records
// (src/files/views/transcript.tsx, common.tsx, useColorBy.ts, useFilterBy.ts).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { colourVar } from '../../src/files/labels'
import { rowsByRef } from '../../src/files/marks.tsx'
import { useColorBy, type ColorBy } from '../../src/files/useColorBy'
import { useFilterBy, type FilterBy } from '../../src/files/useFilterBy'
import type { FilesLabels } from '../../src/files/useLabels'
import { writeColor } from '../../src/files/colorChoice'
import transcript, { madeTurnBlocks, turnRecords } from '../../src/files/views/transcript.tsx'
import { api } from '../../src/lib/api.ts'
import type { Concept, SourcePage, SourceRecord, SourceTurn } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const View = transcript.component
const kinds = (card: Element | null | undefined) => [...(card?.querySelectorAll('.reader-block') ?? [])].map((b) => [...b.classList].find((c) => c.startsWith('reader-') && c !== 'reader-block'))
const open = async (card: Element | null | undefined) => {
  const line = card?.querySelector<HTMLButtonElement>('.reader-fold-line')
  if (line) await act(async () => line.click())
}

const STEP: SourceTurn = {
  i: 1,
  n: 3,
  line: 9,
  speaker: 'model-a',
  role: 'other',
  text: 'Listing the folder.',
  blocks: [
    { kind: 'thinking', text: 'It may hold a test layout.' },
    { kind: 'text', text: 'Listing the folder.' },
    { kind: 'tool_use', text: 'bash\n{\n  "command": "ls -la /app"\n}' },
    { kind: 'tool_result', text: 'total 8\nhello.py' },
  ],
}

describe('a whole-file JSON transcript’s turns', () => {
  test('a step shows its reasoning, words, tool call and its result as blocks, folded to one line until opened', async () => {
    vi.spyOn(api, 'sourceTurns').mockResolvedValue({
      path: 't.json',
      total: 3,
      start: 0,
      n_groups: 1,
      groups: { '0': { title: '', first: 0 } },
      turns: [
        { i: 0, line: 3, speaker: 'user', role: 'user', text: 'List the folder.', group: 0 },
        { ...STEP, group: 0 },
        { i: 2, line: 20, speaker: 'model-a', role: 'other', text: '', group: 0, blocks: [{ kind: 'tool_use', text: 'bash\n{\n  "command": "pwd"\n}' }, { kind: 'tool_result', text: '/app' }] },
      ],
    })
    const page: SourcePage = { path: 't.json', kind: 'text', total_lines: 30, start: 1, records: [] }
    const el = await mount(<View workspace="w" path="t.json" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'json', score: 0.95 }} />)
    await settle()
    const card = (line: string) => el.querySelector(`.reader-card[data-line="${line}"]`)
    expect([...el.querySelectorAll('.reader-card')].map((c) => c.getAttribute('data-line'))).toEqual(['3', '9', '20'])
    expect(kinds(card('3'))).toEqual(['reader-text'])
    // each row shows the turn's own number (its step's, else its place), the file's line on hover
    const no = (line: string) => card(line)!.querySelector('.reader-lineno')!
    expect(['3', '9', '20'].map((l) => no(l).textContent)).toEqual(['1', '3', '3'])
    expect(no('9').getAttribute('title')).toBe('line 9')
    expect(card('9')!.classList.contains('is-folded')).toBe(true)
    expect(card('9')!.querySelector('.reader-fold-text')!.textContent).toBe('Listing the folder. · bash ls -la /app · total 8 hello.py')
    await open(card('9'))
    expect(kinds(card('9'))).toEqual(['reader-thinking', 'reader-text', 'reader-tool_use', 'reader-tool_result'])
    expect(card('9')!.querySelector('.reader-tool_use')!.textContent).toContain('"command": "ls -la /app"')
    expect(card('9')!.querySelector('.reader-tool_result')!.textContent).toContain('hello.py')
    expect(kinds(card('20'))).toEqual(['reader-tool_use', 'reader-tool_result'])
  })
  test('a tool result’s terminal output is cleaned, its stored bytes kept for Raw', () => {
    const [b] = madeTurnBlocks([{ kind: 'tool_result', text: 'ok\x1b[0m\n' }])
    expect(b.text).not.toContain('\x1b')
    expect(b.raw).toBe('ok\x1b[0m\n')
    expect(madeTurnBlocks([{ kind: 'tool_result', text: 'plain' }])).toEqual([{ kind: 'tool_result', text: 'plain' }])
  })
})

describe('JSON lines', () => {
  const rec = (line: number, record: any, meta: Record<string, any> = {}): SourceRecord => ({ line, record, blocks: [{ kind: 'raw', text: JSON.stringify(record) }], meta })
  test('a message’s blocks from the server show under its author, and a tool call that is a record of its own under who it stands for', async () => {
    const records = [
      rec(1, { role: 'user', content: 'List the folder.' }),
      rec(2, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }] }, { blocks: [{ kind: 'tool_use', text: 'shell\n{\n  "command": "ls"\n}' }] }),
      rec(3, { type: 'function_call_output', call_id: 'c1', output: 'hello.py' }, { blocks: [{ kind: 'tool_result', text: 'hello.py' }], speaker: 'tool' }),
    ]
    const page: SourcePage = { path: 'm.jsonl', kind: 'text', total_lines: 3, start: 1, records }
    const el = await mount(<View workspace="w" path="m.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'messages', score: 0.95, keys: { speaker: 'role', text: 'content' } }} />)
    const cards = [...el.querySelectorAll('.reader-card')]
    expect(cards.map((c) => c.querySelector('.reader-record-head')!.textContent)).toEqual(['user', 'assistant', 'tool'])
    await open(cards[1])
    await open(cards[2])
    expect(kinds(cards[1])).toEqual(['reader-tool_use'])
    expect(kinds(cards[2])).toEqual(['reader-tool_result'])
    expect(cards[2].querySelector('.reader-tool_result')!.textContent).toContain('hello.py')
  })
  test('a line holding a conversation shows each turn’s blocks from the server', async () => {
    const conv = { messages: [{ role: 'user', content: 'Weather?' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'weather', arguments: '{}' } }] }] }
    const turns = [
      { speaker: 'user', text: 'Weather?' },
      { speaker: 'assistant', text: '', blocks: [{ kind: 'tool_use', text: 'weather\n{}' }] },
      { speaker: 'tool', text: 'sunny', blocks: [{ kind: 'tool_result', text: 'sunny' }] },
    ]
    const page: SourcePage = { path: 'c.jsonl', kind: 'text', total_lines: 1, start: 1, records: [rec(1, conv, { turns })] }
    const el = await mount(<View workspace="w" path="c.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'conversations', score: 0.95, keys: { list: 'messages', speaker: 'role', text: 'content' } }} />)
    await open(el.querySelector('.reader-card'))
    expect([...el.querySelectorAll('.reader-conv-speaker')].map((s) => s.textContent)).toEqual(['user', 'assistant', 'tool'])
    expect(kinds(el.querySelector('.reader-card'))).toEqual(['reader-text', 'reader-tool_use', 'reader-tool_result'])
  })
  test('a Claude Code stream shows its tool call and result as before', async () => {
    const records = [
      rec(1, { type: 'assistant', uuid: 'u1', session_id: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'Listing.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
      rec(2, { type: 'user', uuid: 'u2', session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'notes.txt' }] } }),
    ]
    const page: SourcePage = { path: 's.jsonl', kind: 'text', total_lines: 2, start: 1, records }
    const el = await mount(<View workspace="w" path="s.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'stream', score: 1 }} />)
    const cards = [...el.querySelectorAll('.reader-card')]
    for (const c of cards) await open(c)
    expect(cards.map(kinds)).toEqual([['reader-text', 'reader-tool_use'], ['reader-tool_result']])
  })
})

describe('a label of a JSON document’s records over its turns', () => {
  // an ATIF trajectory's steps are the records labels mark (`#/steps/<i>`, at the line each starts on); each step's turn
  // stands on the line of its words, a line or two into its record, and names its record (ref, rec_line)
  const P = 'run/trajectory.json'
  const STEPS: SourceTurn[] = [0, 1, 2, 3].map((i) => ({ i, line: 8 + 6 * i, rec_line: 7 + 6 * i, ref: `${P}#/steps/${i}`, speaker: i % 2 ? 'agent' : 'user', role: 'other', text: `step ${i}` }))
  const FLAG = { id: 'f', name: 'flagged', unit: 'record', labels: ['yes', 'no'], classes: [{ name: 'yes', color: 15, highlight: true }, { name: 'no', color: 0, highlight: false }] } as unknown as Concept
  const labels = { all: [FLAG], on: [FLAG], focus: null, byId: new Map([['f', FLAG]]), presence: new Map([['f', { [P]: { yes: 2, no: 1 } }]]) } as unknown as FilesLabels
  // the label marks steps 1 and 3 yes, step 2 no, and has not read step 0, as the server sends its rows
  const ROWS = rowsByRef([{ concept_id: 'f', name: 'flagged', labels: ['yes', 'no'], unit: 'record', rows: [1, 2, 3].map((i) => ({ ref: `${P}#/steps/${i}`, line: 7 + 6 * i, label: i === 2 ? 'no' : 'yes', confidence: null, source: 'model' })) }] as never)
  let color: ColorBy | null = null
  let filter: FilterBy | null = null
  function Harness() {
    const records = turnRecords(STEPS)
    color = useColorBy('w', P, true, labels, records, ROWS, 30)
    filter = useFilterBy('w', P, true, labels, [FLAG], null, records, ROWS, 30, { current: new Set<string>() })
    return null
  }
  test('colors exactly the turns of the steps it marks, and Filter by on it hides the others', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
    writeColor('w', P, { by: 'l:f', picks: ['l:f'], off: {} })
    localStorage.setItem('thimble:w:filterBy:run/trajectory.json', JSON.stringify({ by: 'l:f', off: { 'l:f': ['no', '\u0000none'] } }))
    await mount(<Harness />)
    await settle()
    expect(STEPS.map((t) => color!.colors?.get(t.line)?.color ?? null)).toEqual([null, colourVar(15), null, colourVar(15)])
    expect(STEPS.map((t) => filter!.verdict?.hides(t.line) ?? false)).toEqual([true, false, true, false])
  })
})
