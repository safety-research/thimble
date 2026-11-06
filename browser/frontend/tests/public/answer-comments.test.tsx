// @vitest-environment jsdom
// A check's comments on Claude's answer in main's chat (src/chat/answerComments.ts, AnswerComment.tsx, Rows.tsx): a
// comment on the answer's turn tints its passage in the drawn words in its check's color, a click opens the comment
// card the canvas and the report draw in a popover beside the passage, and ✓ resolves it and takes the tint away.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const TURN = '9f1c2a3b'
const ANSWER = 'The board holds 412 posts. After 19 June there are **0 new messages** to other agents.\n\nThe rest is quiet.'
const COMMENT = {
  id: 'ac1', check: 'important-details', check_name: 'Important details', color: 2, turn: TURN, row: '0', ref: `answer:${TURN}#s2`,
  start: 27, end: 90, quote: 'After 19 June there are **0 new messages** to other agents.', text: 'The label could not read 899 revisions.',
  details: 'See [[card:hidden-revisions]] for them.', status: 'open',
}
const records: ChatRecord[] = [{ type: 'user', text: 'What happened after 19 June?' }, { type: 'text', delta: ANSWER }, { type: 'done', result: null, turn: TURN }]
const click = (el: Element | null) => act(async () => (el as HTMLElement).click())

test("a check's comment on Claude's answer tints its passage; a click opens its card beside it, and ✓ resolves it and its tint", async () => {
  const posts: string[] = []
  let open = true
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    if (init.method === 'POST') {
      posts.push(u)
      open = false
    }
    const body = u.endsWith('/answer-comments') ? { comments: [{ ...COMMENT, status: open ? 'open' : 'dismissed' }], running: [] } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const el = await mount(<Rows rows={foldRecords(records)} ws="mini" chat="main" />)
  await settle()
  await settle()
  // one mark per text node: the bold words are a mark of their own
  const marks = [...el.querySelectorAll<HTMLElement>('mark.answer-tint')]
  expect(marks.map((m) => m.textContent).join('')).toBe('After 19 June there are 0 new messages to other agents.')
  await click(marks[0])
  const card = () => document.querySelector<HTMLElement>('.answer-cm-pop .wu-cm.answer-cm')
  expect(card()?.querySelector('.wu-cm-name')?.textContent).toBe('Important details')
  expect(card()?.querySelector('.wu-cm-statement')?.textContent).toBe('The label could not read 899 revisions.')
  await click(card()!.querySelector('.wu-cm-resolve'))
  await settle()
  expect(posts).toEqual(['/api/ws/mini/answer-comments/ac1/dismiss'])
  expect(card()).toBeNull()
  expect(el.querySelector('mark.answer-tint')).toBeNull()
})
