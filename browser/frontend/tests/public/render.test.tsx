// @vitest-environment jsdom
// The chat drawn by its real components under jsdom (src/chat/Rows.tsx): a session's records render as rows, the
// analyst's message, the reply's markdown with its chips and its marks, a call of the card tool with the card under it,
// and a turn that ended on an error. Rendering logs no React error.
// The browser's smoke test, page half: smoke.json holds the records the server leaves when a question gets an answer
// with a card and a checked mark (browser/server/tests/test_smoke.py checks that it still leaves records of that form).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { foldRecords, retryOf } from '../../src/chat/model.ts'
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
  { type: 'user', ts: '2026-08-30T14:00:00Z', text: 'How many agents reviewed a PR? See [[agents/agent-01.jsonl#L3]].', by: 'browser', turn: '0a1b2c3d' },
  { type: 'text', delta: 'There are **three**, listed below:\n\n- agent-01\n- agent-02\n\nIn all [[3|card:abcd1234#agents/total]] agents.' },
  { type: 'error', ts: '2026-08-30T14:00:05Z', message: "Claude's API could not be reached. Check the network and send the message again.", kind: 'api' },
  { type: 'done', ts: '2026-08-30T14:00:06Z', result: 'failed' },
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
  test("the analyst's message, markdown with a value chip, and a turn that ended on an error", async () => {
    const el = await rows(LOG)
    const user = el.querySelector('.chat-user .chat-message')
    expect(user?.textContent).toMatch(/How many agents reviewed a PR\?/)
    expect(el.querySelector('.chat-user .refchip')?.getAttribute('data-ref')).toBe('agents/agent-01.jsonl#L3')
    expect(el.querySelector('.chat-user .refchip')?.classList.contains('chip-tone-evidence')).toBe(true)
    expect(el.querySelector('.chat-text strong')?.textContent).toBe('three')
    expect(el.querySelectorAll('.chat-text li')).toHaveLength(2)
    const value = el.querySelector('.chat-text .refchip-value')
    expect(value?.textContent).toBe('3')
    expect(value?.getAttribute('data-ref')).toBe('card:abcd1234#agents/total')
    expect(el.querySelector('.chat-api-error[data-error-kind="api"] .chat-apierr-what')?.textContent).toMatch(/could not be reached/)
    expect(errors).toEqual([])
  })

  test("Retry under the error that ended the last turn sends the analyst's message again; a refusal has none", async () => {
    const retry = retryOf(LOG)
    expect(retry).toEqual({ index: 2, text: 'How many agents reviewed a PR? See [[agents/agent-01.jsonl#L3]].' })
    const sent: string[] = []
    const el = await mount(
      <ThreadsContext.Provider value={{ labels: new Map() }}>
        <Rows rows={foldRecords(LOG)} ws="w" retry={{ index: retry!.index, onRetry: async () => void sent.push(retry!.text) }} />
      </ThreadsContext.Provider>,
    )
    await act(async () => (el.querySelector('.chat-apierr-retry') as HTMLButtonElement).click())
    expect(sent).toEqual([retry!.text])
    const refused = LOG.map((r) => (r.type === 'error' ? { ...r, kind: 'refusal' } : r)) as ChatRecord[]
    expect(retryOf(refused)).toBeNull()
    expect(retryOf([...LOG, { type: 'user', text: 'next', turn: '1b2c3d4e' }] as ChatRecord[])).toBeNull()
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

  test('a new version of a card replaces it in its place; the later call points up to it and shows the kept title', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'c0000aaaa', title: 'Runs', version: 2, keys: [], tree: { t: 'Text', p: {}, c: ['2 runs'] } }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const el = await rows([
      { type: 'user', text: 'How many runs?', turn: 't1' },
      { type: 'tool_use', id: 'u1', name: 'card', input: { title: 'Runs', data: '$TMPDIR/runs.json', view: 'function view() {}' } },
      { type: 'tool_result', id: 'u1', summary: 'drawn', card: 'c0000aaaa', version: 1, title: 'Runs' },
      { type: 'text', delta: 'Two runs.' },
      { type: 'user', text: 'Only the failed ones.', turn: 't2' },
      { type: 'tool_use', id: 'u2', name: 'card', input: { id: 'c0000aaaa', edits: [{ old: 'a', new: 'b' }] } },
      { type: 'tool_result', id: 'u2', summary: 'drawn', card: 'c0000aaaa', version: 2, title: 'Runs' },
      { type: 'text', delta: 'None failed.' },
    ] as unknown as ChatRecord[])
    const calls = [...el.querySelectorAll('.chat-cardcall')]
    expect(calls).toHaveLength(2)
    expect(calls[0].querySelector('.drawn-frame[data-card="c0000aaaa"]')).not.toBeNull()
    expect(calls[1].querySelector('.drawn-frame')).toBeNull()
    expect(calls[1].querySelector('.chat-card-moved')?.textContent).toBe('↑ version 2 · “Runs” is drawn in its place above')
    expect(calls[1].querySelector('.chat-call-target')?.textContent).toBe('Runs')
    expect(errors).toEqual([])
  })
})
