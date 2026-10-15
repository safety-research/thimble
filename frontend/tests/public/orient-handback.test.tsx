// @vitest-environment jsdom
// The end of an orientation's or a writer's thread that sent its summary to main (src/chat/ChatPanel.tsx
// orientMessages, src/chat/HandBack.tsx HandedBack): the SubagentHandback call and the text after it become one folded
// hand-back row, drawn as the quiet line `Summary sent to main`, which a click opens on the summary as the thread's
// markdown and a second click folds; with no summary there is no extra row. What main receives is not changed here.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { orientMessages } from '../../src/chat/ChatPanel.tsx'
import { SUMMARY_SENT } from '../../src/chat/HandBack.tsx'
import { foldRecords, orientSummaries } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const SUMMARY = 'The wiki holds **1,204 revisions** of 87 pages.\n\n- Three pages hold a third of all edits.'
const records = (message: unknown): ChatRecord[] => [
  { type: 'user', text: 'Orient me in this wiki dataset.' },
  { type: 'text', delta: 'Counting revisions per page.' },
  { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'wc -l revisions.jsonl' } },
  { type: 'tool_result', id: 'u1', summary: '1204 revisions.jsonl' },
  { type: 'tool_use', id: 'u2', name: 'SubagentHandback', input: { message } },
  { type: 'tool_result', id: 'u2', summary: 'Delivered.' },
  { type: 'text', delta: 'Done.' },
  { type: 'done', result: null },
]

describe('orientMessages', () => {
  test('the hand-back call and the text after it become one hand-back row holding the summary, at the end', () => {
    const rows = orientMessages(foldRecords(records(`  ${SUMMARY}\n`)))
    const last = rows[rows.length - 1]
    expect(last).toMatchObject({ kind: 'handback', text: SUMMARY })
    expect(rows.filter((r) => r.kind === 'handback')).toHaveLength(1)
    expect(rows.some((r) => r.kind === 'tool' && r.name === 'SubagentHandback')).toBe(false)
    expect(rows.filter((r) => r.kind === 'text').map((r) => (r.kind === 'text' ? r.text : ''))).toEqual(['Counting revisions per page.'])
    expect(rows.some((r) => r.kind === 'user'), "the first message is the card's").toBe(false)
  })

  test('a hand-back with no summary leaves no extra row; a session with no hand-back keeps its rows', () => {
    for (const empty of ['', '   ', undefined, 7]) {
      const rows = orientMessages(foldRecords(records(empty)))
      expect(rows.some((r) => r.kind === 'handback')).toBe(false)
      expect(rows.some((r) => r.kind === 'tool' && r.name === 'SubagentHandback')).toBe(false)
    }
    const plain = foldRecords(records(SUMMARY).filter((r) => !('id' in r && r.id === 'u2')))
    expect(orientMessages(plain)).toEqual(plain.slice(1))
  })

  test("main's copy of the summary still reads the hand-back call's message", () => {
    expect(orientSummaries(foldRecords(records(SUMMARY)))).toEqual([SUMMARY])
  })
})

describe('the hand-back row', () => {
  const head = (el: HTMLElement) => el.querySelector<HTMLElement>('.chat-hand-back [role="button"]')!

  test('shows one quiet line with the summary folded; a click opens it as markdown, a second folds it', async () => {
    const el = await mount(<Rows rows={orientMessages(foldRecords(records(SUMMARY)))} ws="w" chat="o1" calls="o1" />)
    const line = el.querySelector('.chat-hand-back')
    expect(line?.textContent).toBe(SUMMARY_SENT)
    expect(SUMMARY_SENT).toBe('Summary sent to main')
    expect(line?.getAttribute('data-state')).toBe('handed')
    expect(el.textContent).not.toContain('1,204 revisions')
    expect(head(el).getAttribute('aria-expanded')).toBe('false')
    await act(async () => head(el).click())
    expect(head(el).getAttribute('aria-expanded')).toBe('true')
    const shown = el.querySelector('.chat-hand-back-summary .chat-text')
    expect(shown?.querySelector('strong')?.textContent).toBe('1,204 revisions')
    expect(shown?.querySelector('li')?.textContent).toBe('Three pages hold a third of all edits.')
    expect(shown?.getAttribute('data-anchor')).toMatch(/^chat:o1#\d+$/)
    await act(async () => head(el).click())
    expect(el.querySelector('.chat-hand-back-summary')).toBeNull()
  })

  test('Enter opens it from the keyboard', async () => {
    const el = await mount(<Rows rows={orientMessages(foldRecords(records(SUMMARY)))} ws="w" chat="o1" calls="o1" />)
    await act(async () => head(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(el.querySelector('.chat-hand-back-summary strong')?.textContent).toBe('1,204 revisions')
  })

  test('with no summary the thread ends with no hand-back line', async () => {
    const el = await mount(<Rows rows={orientMessages(foldRecords(records('')))} ws="w" chat="o1" calls="o1" />)
    expect(el.querySelector('.chat-hand-back')).toBeNull()
  })
})
