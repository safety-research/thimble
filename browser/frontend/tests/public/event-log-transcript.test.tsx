// @vitest-environment jsdom
// The Transcript view of an agent's event log (src/files/views/transcript.tsx): JSON lines keyed by what each record is
// (`kind`), as the server pages them (backend readers/transcripts.dress). The task is the person's turn, under the
// name the log gives it; a message is a turn by its role; a tool call and its result are blocks of the agent's turn,
// under the agent's name; a note (a review, the end) is headed by its kind, its other fields on one line.
import { afterEach, describe, expect, test } from 'vitest'
import transcript, { recordKind, recordKindKey, restFields } from '../../src/files/views/transcript.tsx'
import type { SourcePage, SourceRecord, TranscriptHint } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const HINT: TranscriptHint = { format: 'messages', score: 0.95, keys: { speaker: 'role', text: 'text' } }
const raw = (record: any) => [{ kind: 'raw' as const, text: JSON.stringify(record) }]
const rec = (line: number, record: any, meta: any = {}): SourceRecord => ({ line, record, blocks: raw(record), meta })
const RECORDS: SourceRecord[] = [
  rec(1, { kind: 'task', text: 'Add a dark theme to the settings page.' }, { speaker: 'task' }),
  rec(2, { kind: 'message', role: 'agent', text: 'I will look at the styles first.' }),
  rec(3, { kind: 'tool_call', tool: 'search', args: { pattern: 'theme' } }, { speaker: 'agent', blocks: [{ kind: 'tool_use', text: 'search\n{\n  "pattern": "theme"\n}' }] }),
  rec(4, { kind: 'tool_result', tool: 'search', text: 'styles/app.css: 4 matches' }, { speaker: 'agent', blocks: [{ kind: 'tool_result', text: 'styles/app.css: 4 matches' }] }),
  rec(5, { kind: 'review', reviewer: 'Pat Lindqvist', verdict: 'approved' }),
]
const page: SourcePage = { path: 'runs/run-07.jsonl', kind: 'text', total_lines: 5, start: 1, records: RECORDS }
const View = transcript.component

describe('what a record of an event log is', () => {
  test('its kind under kind, type, event or event_type', () => {
    expect(recordKind({ kind: 'review' })).toBe('review')
    expect(recordKind({ event: 'end' })).toBe('end')
    expect(recordKindKey({ kind: 'review', reviewer: 'x' })).toBe('kind')
    expect(recordKindKey({ reviewer: 'x' })).toBeNull()
  })
  test("a note's one line leaves out the key that named its kind", () => {
    const fields = restFields(RECORDS[4].record, { author: 'role', body: 'text' }, null, 'kind')
    expect(fields.map(([k]) => k)).toEqual(['reviewer', 'verdict'])
  })
})

describe('the Transcript view of an event log', () => {
  test('heads: the task, the agent for its messages, tool calls and results, a note by its kind', async () => {
    const el = await mount(<View workspace="w" path="runs/run-07.jsonl" kind="text" page={page} loadMore={() => undefined} transcript={HINT} />)
    const heads = [...el.querySelectorAll('.reader-record-head')].map((h) => h.textContent)
    expect(heads).toEqual(['task', 'agent', 'agent', 'agent', 'review'])
    const card = (line: string) => el.querySelector(`.reader-card[data-line="${line}"]`)!
    expect(card('1').textContent).toContain('Add a dark theme')
    expect(card('3').querySelector('.reader-tool_use')?.textContent).toContain('search')
    expect(card('4').querySelector('.reader-tool_result')?.textContent).toContain('4 matches')
    expect(card('5').textContent).toContain('Pat Lindqvist')
    expect(card('5').textContent).not.toContain('kind')
  })
})
