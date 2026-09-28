// @vitest-environment jsdom
// The chat drawn by its real components under jsdom (src/chat/Rows.tsx, src/chat/Holds.tsx). A session's records
// render as rows: the analyst's message, the reply's markdown with its citations as chips, a tool-call card with the
// card it made, and a stopped turn; Claude Code's API error as its card, with Retry, and a view build's wait after one.
// What holds a session besides its permission requests (an alert, the rules "don't ask again" added) shows above the
// composer. A chip names a thing in words in the sans and anything code-like in mono; a chip that names a document, a
// canvas group or a label is drawn as that thing on its surface. Rendering logs no React error.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { restartedNow } from '../../src/chat/AgentCard.tsx'
import { Holds, RESTARTED_LINE } from '../../src/chat/Holds.tsx'
import { apiRetry, foldRecords, withApiErrors } from '../../src/chat/model.ts'
import { ThreadChip, ThreadsContext } from '../../src/chat/Notes.tsx'
import { MAIN_RETRY_NOTE, Rows } from '../../src/chat/Rows.tsx'
import { cardsText, DocChip, GroupChip, LabelChip, withDocName } from '../../src/chat/SurfaceChips.tsx'
import { Chip } from '../../src/components/Chip.tsx'
import { RefChip } from '../../src/components/RefChip.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const P = 'mcp__plugin_thimble_thimble__'
let errors: string[] = []

beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  // a chip may look up its card's name; nothing answers
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const LOG = [
  { type: 'user', ts: '2026-08-30T14:00:00Z', text: 'How many agents reviewed a PR? See [[agents/agent-01.jsonl#L3]].', by: 'terminal' },
  { type: 'text', delta: 'There are **three**, listed below:\n\n- agent-01\n- agent-02\n\nIn all [[3|card:abcd1234#agents/total]] agents.' },
  { type: 'tool_use', ts: '2026-08-30T14:00:01Z', id: 't1', name: `${P}add_card`, input: { kind: 'table', question: 'Reviews per agent', code: 'df' } },
  { type: 'tool_result', ts: '2026-08-30T14:00:04Z', id: 't1', summary: 'card:abcd1234\n3 rows', cell_id: 'abcd1234' },
  { type: 'done', ts: '2026-08-30T14:00:05Z', session_id: 'sess' },
  { type: 'error', ts: '2026-08-30T14:00:06Z', message: 'stopped', kind: 'interrupted', detail: 'the analyst stopped it' },
] as unknown as ChatRecord[]

async function rows(records: ChatRecord[] | ReturnType<typeof foldRecords>): Promise<HTMLElement> {
  const folded = records.length && 'kind' in records[0] ? (records as ReturnType<typeof foldRecords>) : foldRecords(records as ChatRecord[])
  const el = await mount(
    <ThreadsContext.Provider value={{ labels: new Map() }}>
      <Rows rows={folded} ws="w" streaming={false} />
    </ThreadsContext.Provider>,
  )
  await settle()
  return el
}

describe('chat rows', () => {

  test("the analyst's message, markdown with a value chip, a tool-call card with the card it made, and a stopped turn", async () => {
    const el = await rows(LOG)
    const user = el.querySelector('.chat-user .chat-message')
    expect(user?.textContent).toMatch(/How many agents reviewed a PR\?/)
    expect(user?.getAttribute('data-by')).toBe('terminal')
    expect(el.querySelector('.chat-user .refchip')?.getAttribute('data-ref')).toBe('agents/agent-01.jsonl#L3')
    expect(el.querySelector('.chat-text strong')?.textContent).toBe('three')
    expect(el.querySelectorAll('.chat-text li')).toHaveLength(2)
    const value = el.querySelector('.chat-text .refchip-value')
    expect(value?.textContent).toBe('3')
    expect(value?.getAttribute('data-ref')).toBe('card:abcd1234#agents/total')
    const tool = el.querySelector('.chat-tool.toolcard[data-tool="add_card"]')
    expect(tool).not.toBeNull()
    expect(tool?.querySelector('.toolcard-chips .refchip[data-ref="card:abcd1234"]')).not.toBeNull()
    expect(el.querySelector('.chat-stopped')).not.toBeNull()
    expect(errors).toEqual([])
  })
})
