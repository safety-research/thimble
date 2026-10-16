// @vitest-environment jsdom
// A check's comments on Claude's answers in the browser's chat (src/chat/answerComments.ts, src/chat/AnswerComment.tsx,
// src/chat/markdown.tsx rehypeAnswerMarks, src/chat/Rows.tsx): each open comment tints its passage in main's chat in its
// check's colour (the palette place the backend sends as `color`, as checkColour draws a check), found in the drawn
// words though the comment quotes the raw markdown; a click opens the comment under the answer (the check's name, the
// comment, its details) and Done dismisses it through its route, and the tint goes; a deep link `?ref=answer:<turn>#s<n>`
// opens it. Rows name their transcript rows by uuid; an older log without uuids finds the passage by its words.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { commentsOfRow, plainQuote, type AnswerComment } from '../../src/chat/answerComments.ts'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { foldRecords } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const TURN = '5e55a000-0000-4000-8000-00000000a001'
const ROW = '5e55a000-0000-4000-8000-00000000a002'
const ANSWER = 'The board holds 412 posts. After 19 June there are **0 new messages** to other agents on any page [[0|card:c1#out/L3]].\n\nThe rest is quiet.'
const comment = (extra: Partial<AnswerComment> = {}): AnswerComment => ({
  id: 'ac1', check: 'important-details', check_name: 'Important details', color: 2, about: 'it looks for what a reader would likely miss',
  turn: TURN, row: ROW, ref: `answer:${TURN}#s2`, start: 27, end: 120,
  quote: 'After 19 June there are **0 new messages** to other agents on any page [[0|card:c1#out/L3]].',
  text: 'The label could not read 899 revisions whose text the dump hides.', details: 'See [[card:c2]] for the hidden revisions.',
  status: 'open', ...extra,
})

let comments: AnswerComment[] = []
let posts: string[] = []
let revealed: string[] = []
beforeEach(() => {
  comments = [comment()]
  posts = []
  revealed = []
  // jsdom draws nothing, so it has no scrollIntoView: the passage's anchor says what came into view
  Element.prototype.scrollIntoView = function (this: Element) {
    revealed.push(this.getAttribute('data-anchor') ?? '')
  }
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    if (init.method === 'POST') posts.push(u)
    const body = u.endsWith('/answer-comments') ? { comments, running: [] } : u.includes('/answer-comments/') ? { ok: true } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('finding the passage', () => {
  test('the raw quote as the chat draws it: citations as their value, links as their text, no emphasis or list marks', () => {
    expect(plainQuote(comment().quote)).toBe('After 19 June there are 0 new messages to other agents on any page 0.')
    expect(plainQuote('- See [the log](runs/a.jsonl#L4) and `wc -l`.')).toBe('See the log and wc -l.')
    expect(plainQuote('A bare [[card:c9]] cite.')).toBe('A bare cite.')
  })

  test("a row's comments: those naming one of its uuids, else, with no uuid, those whose words it holds; never a dismissed one", () => {
    const c = comment()
    expect(commentsOfRow({ text: ANSWER, uuids: [ROW] }, [c])).toEqual([c])
    expect(commentsOfRow({ text: ANSWER, uuids: ['other'] }, [c])).toEqual([])
    expect(commentsOfRow({ text: ANSWER }, [c])).toEqual([c])
    expect(commentsOfRow({ text: 'something else' }, [c])).toEqual([])
    expect(commentsOfRow({ text: ANSWER, uuids: [ROW] }, [{ ...c, status: 'dismissed' }])).toEqual([])
  })

  test("the passage is wrapped in the check's colour across the bold words and the citation, the first piece anchored", async () => {
    const el = await mount(<ChatMarkdown text={ANSWER} marks={[{ id: 'ac1', quote: comment().quote, colour: 'var(--label-2)', ref: `answer:${TURN}#s2`, active: false }]} />)
    const marks = [...el.querySelectorAll('mark.answer-tint')]
    expect(marks.length).toBeGreaterThan(1)
    expect(marks.map((m) => m.textContent).join('')).toBe('After 19 June there are 0 new messages to other agents on any page .')
    expect(marks[0].getAttribute('data-anchor')).toBe(`answer:${TURN}#s2`)
    expect(marks.slice(1).every((m) => !m.hasAttribute('data-anchor'))).toBe(true)
    expect((marks[0] as HTMLElement).style.getPropertyValue('--tint')).toBe('var(--label-2)')
    expect(el.textContent).toContain('The board holds 412 posts.')
    const none = await mount(<ChatMarkdown text={ANSWER} marks={[{ id: 'x', quote: 'words the answer never says', colour: 'red', ref: 'answer:x#s1', active: false }]} />)
    expect(none.querySelector('mark')).toBeNull()
  })
})

describe("main's chat", () => {
  const records = (uuid?: string): ChatRecord[] => [
    { type: 'user', text: 'What happened on the board after 19 June?' },
    { type: 'text', delta: ANSWER, ...(uuid ? { uuid } : {}) } as ChatRecord,
    { type: 'done', result: null },
  ]

  test('the tinted passage opens its comment, and Done dismisses it through its route and takes the tint away', async () => {
    const el = await mount(<Rows rows={foldRecords(records(ROW))} ws="mini" chat="main" />)
    await settle()
    await settle()
    const first = el.querySelector<HTMLElement>('mark.answer-tint')!
    expect(first).not.toBeNull()
    expect(first.style.getPropertyValue('--tint')).toBe('var(--label-2)')
    expect(el.querySelector('.answer-comment')).toBeNull()
    await act(async () => first.click())
    const card = el.querySelector('.answer-comment')!
    expect(card.querySelector('.answer-comment-check')?.textContent).toBe('Important details')
    expect(card.querySelector('.answer-comment-text')?.textContent).toBe(comment().text)
    expect(card.querySelector('.answer-comment-details summary')?.textContent).toBe('Details')
    expect(el.querySelector('mark.answer-tint-open')).not.toBeNull()
    await act(async () => card.querySelector<HTMLButtonElement>('.answer-comment-done')!.click())
    await settle()
    expect(posts).toEqual(['/api/ws/mini/answer-comments/ac1/dismiss'])
    expect(el.querySelector('.answer-comment')).toBeNull()
    expect(el.querySelector('mark.answer-tint')).toBeNull()
  })

  test("a thread's chat draws no tint, and an older log without uuids finds the passage by its words", async () => {
    const thread = await mount(<Rows rows={foldRecords(records(ROW))} ws="mini" chat="or1" />)
    await settle()
    expect(thread.querySelector('mark.answer-tint')).toBeNull()
    const older = await mount(<Rows rows={foldRecords(records())} ws="mini" chat="main" />)
    await settle()
    await settle()
    expect(older.querySelector('mark.answer-tint')).not.toBeNull()
  })

  test('a deep link to the passage opens its comment', async () => {
    const { teleport } = await import('../../src/lib/teleport.ts')
    const { bus } = await import('../../src/lib/bus.ts')
    const opened: string[] = []
    const off = bus.on('openChat', (e) => opened.push(e.chatId))
    const el = await mount(<Rows rows={foldRecords(records(ROW))} ws="mini" chat="main" />)
    await settle()
    await settle()
    await act(async () => teleport(`answer:${TURN}#s2`))
    await settle()
    await act(async () => new Promise((r) => setTimeout(r, 5)))
    expect(opened).toEqual(['main'])
    expect(el.querySelector('.answer-comment')?.getAttribute('data-comment')).toBe('ac1')
    expect(revealed).toEqual([`answer:${TURN}#s2`])
    off()
  })
})
