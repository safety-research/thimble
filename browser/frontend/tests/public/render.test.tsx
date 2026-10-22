// @vitest-environment jsdom
// The chat drawn by its real components under jsdom (src/chat/Rows.tsx): a session's records render as rows, the
// analyst's message, the reply's markdown with its chips and its marks, a call of the card tool with the card under it,
// and a stopped turn. Rendering logs no React error.
// The browser's smoke test, page half: smoke.json holds the records the server leaves when a question gets an answer
// with a card and a checked mark (browser/server/tests/test_smoke.py checks that it still leaves records of that form).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'
import SMOKE from './smoke.json'

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
  test("the analyst's message, markdown with a value chip, and a stopped turn", async () => {
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
    expect(el.querySelector('.chat-stopped')).not.toBeNull()
    expect(errors).toEqual([])
  })

  test('smoke: a question to the server gets an answer with a card under its call and a verified mark', async () => {
    const drawn = SMOKE.find((r) => r.type === 'tool_result') as { card: string }
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(String(url))
      const tree = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['a: merged'] }, { t: 'Text', p: { dimColor: true }, c: ['pressed 0'] }] }
      return new Response(JSON.stringify({ id: drawn.card, title: 'How the runs ended', version: 1, keys: ['n'], tree }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const el = await rows(SMOKE as unknown as ChatRecord[])
    await settle()
    expect(el.querySelector('.chat-user .chat-message')?.textContent).toMatch(/How did the runs end\?/)
    // the card stands under its call, drawn from the runner's tree
    const frame = el.querySelector(`.chat-cardcall .drawn-frame[data-card="${drawn.card}"]`)
    expect(frame?.querySelector('.drawn-title')?.textContent).toBe('How the runs ended')
    expect(frame?.querySelector('.drawn-body')?.textContent).toContain('a: merged')
    expect(frame?.querySelector('.drawn-keys')?.textContent).toBe('keys n')
    expect(asked.some((u) => u.includes(`/cards/${drawn.card}?width=`))).toBe(true)
    // the reply's mark, as the check left it
    const mark = el.querySelector('.chat-text .mark')
    expect(mark?.getAttribute('data-mark-look')).toBe('verified')
    expect(mark?.textContent).toBe('"merged"')
    expect(errors).toEqual([])
  })
})
