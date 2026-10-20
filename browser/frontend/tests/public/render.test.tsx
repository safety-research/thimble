// @vitest-environment jsdom
// The chat drawn by its real components under jsdom (src/chat/Rows.tsx): a session's records render as rows, the
// analyst's message, the reply's markdown with its citations as chips, a tool-call card with the card it made, and a
// stopped turn. Rendering logs no React error.
// The browser's smoke test, page half: smoke.json holds the records the server leaves when a question gets an answer
// with a card (browser/server/tests/test_smoke.py checks that it still leaves records of that form).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'
import SMOKE from './smoke.json'

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
    expect(el.querySelector('.chat-user .refchip')?.classList.contains('chip-tone-evidence')).toBe(true)
    expect(el.querySelector('.chat-text strong')?.textContent).toBe('three')
    expect(el.querySelectorAll('.chat-text li')).toHaveLength(2)
    const value = el.querySelector('.chat-text .refchip-value')
    expect(value?.textContent).toBe('3')
    expect(value?.getAttribute('data-ref')).toBe('card:abcd1234#agents/total')
    const tool = el.querySelector('.chat-tool.toolcard[data-tool="add_card"]')
    expect(tool).not.toBeNull()
    expect(tool?.querySelector('.toolcard-chips .refchip[data-ref="card:abcd1234"]')?.classList.contains('chip-tone-accent')).toBe(true)
    expect(el.querySelector('.chat-stopped')).not.toBeNull()
    expect(errors).toEqual([])
  })

  test('smoke: a question to the server gets an answer that cites the card it made', async () => {
    const el = await rows(SMOKE as unknown as ChatRecord[])
    const card = (SMOKE.find((r) => r.type === 'tool_result') as { cell_id: string }).cell_id
    expect(el.querySelector('.chat-user .chat-message')?.textContent).toMatch(/How did the runs end\?/)
    const answer = [...el.querySelectorAll('.chat-text')].map((t) => t.textContent).join(' ')
    expect(answer).toMatch(/One of the two runs merged/)
    expect(el.querySelector(`.chat-text .refchip[data-ref="card:${card}"]`)).not.toBeNull()
    expect(el.querySelector(`.chat-tool.toolcard[data-tool="add_card"] .refchip[data-ref="card:${card}"]`)).not.toBeNull()
    expect(errors).toEqual([])
  })

  test("a turn's cards and its token use are not drawn under the reply; the page opens the canvas on the card", async () => {
    const el = await rows(SMOKE as unknown as ChatRecord[])
    const card = (SMOKE.find((r) => r.type === 'tool_result') as { cell_id: string }).cell_id
    // the card is one chip on its tool call, and no drawing; the done record's usage leaves no line
    expect(el.querySelectorAll(`[data-ref="card:${card}"], [data-anchor="card:${card}"]`).length).toBeGreaterThan(0)
    expect(el.querySelector('figure, .chat-cards, .chat-card')).toBeNull()
    expect(el.textContent).not.toMatch(/\bcached\b|\d out\b|Opus/)
    const tabs: string[] = []
    const refs: string[] = []
    const offs = [bus.on('showTab', (e) => void tabs.push(e.tab)), bus.on('openRef', (e) => void refs.push(e.ref))]
    dispatch({ type: 'open-card', card } as never, true) // the history the stream replays opens nothing
    dispatch({ type: 'open-card', card } as never)
    offs.forEach((off) => off())
    expect(tabs).toEqual(['canvas'])
    expect(refs).toEqual([`card:${card}`])
  })
})
