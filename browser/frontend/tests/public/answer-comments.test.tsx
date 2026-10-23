// @vitest-environment jsdom
// A check's comments on Claude's answer in main's chat (src/chat/answerComments.ts, AnswerComment.tsx, Rows.tsx): the
// answer's rows carry the turn its `done` record names; a comment on that turn tints its passage in the drawn words in
// its check's color, a click opens the comment card the canvas and the report draw in a popover beside the passage (Esc or a press outside closes it), ✓ resolves it and
// takes the tint away; another turn's comment, a thread's chat and an answer still streaming show none.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { commentsOfRow, plainQuote, type AnswerComment } from '../../src/chat/answerComments.ts'
import { foldRecords, type TextRow } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const TURN = '9f1c2a3b'
const ANSWER = 'The board holds 412 posts. After 19 June there are **0 new messages** to other agents.\n\nThe rest is quiet.'
const comment = (over: Partial<AnswerComment> = {}): AnswerComment => ({
  id: 'ac1', check: 'important-details', check_name: 'Important details', color: 2, turn: TURN, row: '0', ref: `answer:${TURN}#s2`,
  start: 27, end: 90, quote: 'After 19 June there are **0 new messages** to other agents.', text: 'The label could not read 899 revisions.',
  details: 'See [[card:hidden-revisions]] for them.', status: 'open', ...over,
})
const records: ChatRecord[] = [{ type: 'user', text: 'What happened after 19 June?' }, { type: 'text', delta: ANSWER }, { type: 'done', result: null, turn: TURN }]

const click = (el: Element | null) => act(async () => (el as HTMLElement).click())

describe('which rows a comment is on', () => {
  test("an answer's rows carry the turn its done record names, and a row still streaming none", () => {
    const [, row] = foldRecords(records) as [unknown, TextRow]
    expect(row.turn).toBe(TURN)
    const [, open] = foldRecords(records.slice(0, 2)) as [unknown, TextRow]
    expect(open.turn).toBeUndefined()
    expect(commentsOfRow(open, [comment()])).toEqual([])
  })

  test("a comment is on the row of its turn whose drawn words hold its passage", () => {
    const row = { text: ANSWER, turn: TURN }
    expect(plainQuote(comment().quote)).toBe('After 19 June there are 0 new messages to other agents.')
    expect(commentsOfRow(row, [comment()]).map((c) => c.id)).toEqual(['ac1'])
    expect(commentsOfRow(row, [comment({ turn: 'other' })])).toEqual([])
    expect(commentsOfRow(row, [comment({ status: 'dismissed' })])).toEqual([])
    expect(commentsOfRow({ text: 'The rest is quiet.', turn: TURN }, [comment()])).toEqual([])
  })
})

describe("a check's comment on Claude's answer, in main's chat", () => {
  let posts: string[] = []
  async function chat(chatId = 'main', recs = records): Promise<HTMLElement> {
    posts = []
    let open = true
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
      const u = String(url)
      if (init.method === 'POST') {
        posts.push(u)
        open = false
      }
      const body = u.endsWith('/answer-comments') ? { comments: [comment({ status: open ? 'open' : 'dismissed' })], running: [] } : u.includes('/answer-comments/') ? { id: 'ac1' } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const el = await mount(<Rows rows={foldRecords(recs)} ws="mini" chat={chatId} />)
    await settle()
    await settle()
    return el
  }

  test('the passage is tinted in its check color, and a click opens the comment card in a popover beside it', async () => {
    const el = await chat()
    // one mark per text node: the bold words are a mark of their own
    const marks = [...el.querySelectorAll<HTMLElement>('mark.answer-tint')]
    expect(marks.map((m) => m.textContent).join('')).toBe('After 19 June there are 0 new messages to other agents.')
    const tint = marks[0]
    expect(tint.style.getPropertyValue('--tint')).toContain('var(--label')
    expect(tint.dataset.anchor).toBe(`answer:${TURN}#s2`)
    expect(document.querySelector('.wu-cm')).toBeNull()
    await click(tint)
    // the card is not under the answer: it floats in a popover on the body
    expect(el.querySelector('.wu-cm')).toBeNull()
    const card = document.querySelector<HTMLElement>('.answer-cm-pop[data-answer-comment-pop="ac1"] .wu-cm.answer-cm')!
    expect(card.dataset.comment).toBe('ac1')
    expect(card.querySelector('.wu-cm-name')?.textContent).toBe('Important details')
    expect(card.querySelector('.wu-cm-statement')?.textContent).toBe('The label could not read 899 revisions.')
    expect(el.querySelector('mark.answer-tint-open')).not.toBeNull()
    await click(card.querySelector('.wu-cm-more'))
    expect(card.querySelector('.wu-cm-details [data-ref="card:hidden-revisions"]')).not.toBeNull()
    // a second click on the passage folds the card away
    await click(el.querySelector('mark.answer-tint'))
    expect(document.querySelector('.wu-cm')).toBeNull()
  })

  test('Esc, or a press outside the popover, closes it; a press inside keeps it', async () => {
    const el = await chat()
    await click(el.querySelector('mark.answer-tint'))
    const press = (t: Element) => act(async () => void t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    await press(document.querySelector('.answer-cm-pop .wu-cm-statement')!)
    expect(document.querySelector('.answer-cm-pop')).not.toBeNull()
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('.answer-cm-pop')).toBeNull()
    expect(el.querySelector('mark.answer-tint-open')).toBeNull()
    await click(el.querySelector('mark.answer-tint'))
    expect(document.querySelector('.answer-cm-pop')).not.toBeNull()
    await press(document.body)
    expect(document.querySelector('.answer-cm-pop')).toBeNull()
  })

  test('a click makes it active with its field, and ✓ resolves it and its tint', async () => {
    const el = await chat()
    await click(el.querySelector('mark.answer-tint'))
    const card = () => document.querySelector<HTMLElement>('.answer-cm-pop .wu-cm.answer-cm')!
    await click(card().querySelector('.wu-cm-statement'))
    expect(card().classList.contains('wu-cm-active')).toBe(true)
    expect(card().querySelector('.wu-cm-reply textarea')).not.toBeNull()
    await click(card().querySelector('.wu-cm-resolve'))
    await settle()
    expect(posts).toEqual(['/api/ws/mini/answer-comments/ac1/dismiss'])
    expect(document.querySelector('.wu-cm')).toBeNull()
    expect(el.querySelector('mark.answer-tint')).toBeNull()
  })

  test("a thread's chat and an answer still streaming show no tint", async () => {
    expect((await chat('t-thread')).querySelector('mark.answer-tint')).toBeNull()
    unmountAll()
    expect((await chat('main', records.slice(0, 2))).querySelector('mark.answer-tint')).toBeNull()
  })

  test("a click on a citation's words in the passage opens the citation alone, and closes an open comment", async () => {
    const cited = ANSWER.replace('**0 new messages**', '[0 new messages](#)')
    const el = await chat('main', [records[0], { type: 'text', delta: cited }, records[2]])
    const inCitation = [...el.querySelectorAll<HTMLElement>('.mark-words mark.answer-tint')]
    expect(inCitation.map((m) => m.textContent)).toEqual(['0 new messages'])
    await click(inCitation[0])
    expect(document.querySelector('.mark-pop')).not.toBeNull()
    expect(document.querySelector('.answer-cm-pop')).toBeNull()
    // the passage's other words open its comment; a press on the citation then makes the comment way
    const other = [...el.querySelectorAll<HTMLElement>('mark.answer-tint')].find((m) => !m.closest('.mark-words'))!
    await click(other)
    expect(document.querySelector('.answer-cm-pop')).not.toBeNull()
    await act(async () => void inCitation[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('.answer-cm-pop')).toBeNull()
  })
})
