// @vitest-environment jsdom
// A check's comments on Claude's answer in main's chat (src/chat/answerComments.ts, AnswerComment.tsx, Rows.tsx): a
// comment on the answer's turn tints its passage in the drawn words in its check's color, a click opens the comment
// card the canvas and the report draw in a popover beside the passage, and ✓ resolves it and takes the tint away. A
// comment on a sentence the check of the citations corrected stays on its words, and one whose words the check took
// away says so beside the answer.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import type { MarkItem } from '../../src/marks/marks.ts'
import { LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

// an answer whose citation the check of the citations corrected: the chat draws "Jun 4" where Claude wrote "Jun 18"
const FIXED_TURN = '7d2e4f61'
const FIXED = 'Most accounts wrote in one week. One account made all [5,217](#) of the page deletions, starting on [Jun 18](#) and continuing through [Jul 14](#).'
const AT = FIXED.indexOf('One account')
const checked = (k: number, words: string, rest: Partial<MarkItem> = {}): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, ...rest })
const fixedRecords = (jun: Partial<MarkItem>): ChatRecord[] => [
  { type: 'user', text: 'Who deleted pages, and when?' },
  { type: 'text', delta: FIXED },
  { type: 'done', result: null, turn: FIXED_TURN },
  { type: 'marks', turn: FIXED_TURN, items: [checked(0, '5,217'), checked(1, 'Jun 18', jun), checked(2, 'Jul 14')] },
]
const JUN_4: Partial<MarkItem> = { status: 'corrected', shown: 'Jun 4', was: 'Jun 18' }
const onSentence = (id: string, check: 'explainers' | 'heads-up', words: string) => ({
  id, check, check_name: check === 'explainers' ? 'Explainers' : 'Heads up', color: check === 'explainers' ? 3 : 1, turn: FIXED_TURN,
  row: '0', ref: `answer:${FIXED_TURN}#s2`, start: AT, end: FIXED.length, quote: FIXED.slice(AT), words, text: `About ${words}.`,
  details: '', status: 'open',
})
const CHECKS = [
  { id: 'heads-up', name: 'Heads up', prompt: 'A detail to know.', colour: 1, builtin: true, shown: true, covers: ['answers'] },
  { id: 'explainers', name: 'Explainers', prompt: 'The background a reader lacks.', colour: 3, builtin: true, shown: true, covers: ['answers'] },
]

/** The server's answers: these comments on Claude's answers, the checks, and nothing else. */
function serve(comments: object[]) {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url)
    const body = u.endsWith('/answer-comments') ? { comments, running: [] } : u.endsWith('/checks') ? CHECKS : u.includes('/concepts') ? [] : { comments: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // where the words stand: the answer's text from y 100 to 900, right edge at x 400, and each tinted piece on y 300
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [top, bottom] = this.matches('mark.answer-tint') ? [300, 320] : this.matches('.chat-text') ? [100, 900] : [0, 0]
    return { top, bottom, left: 10, right: 400, width: 390, height: bottom - top, x: 10, y: top, toJSON: () => ({}) } as DOMRect
  })
  Element.prototype.scrollIntoView = () => undefined
}
const tint = (el: HTMLElement, id: string) => [...el.querySelectorAll<HTMLElement>(`mark.answer-tint[data-answer-comment="${id}"]`)].map((m) => m.textContent).join('')
const pop = () => document.querySelector<HTMLElement>('.answer-cm-pop')
const goTo = (id: string) => act(async () => bus.emit('openRef', { ref: `answer:${FIXED_TURN}#s2`, comment: id }))

test('comments on a sentence the check of the citations corrected stay on their words; Go to it opens one beside them, and the sidebar quotes the sentence as corrected', async () => {
  serve([onSentence('e1', 'explainers', 'page deletions'), onSentence('h1', 'heads-up', 'starting on Jun 18')])
  const el = await mount(<Rows rows={foldRecords(fixedRecords(JUN_4))} ws="mini" chat="main" />)
  await settle()
  await settle()
  expect(el.querySelector('.chat-text')?.textContent).toContain('starting on Jun 4 and')
  expect(tint(el, 'e1')).toBe('page deletions')
  // words that hold the corrected citation follow it onto its new words
  expect(tint(el, 'h1')).toBe('starting on Jun 4')
  await goTo('e1')
  await settle()
  expect(pop()?.querySelector('.wu-cm-statement')?.textContent).toBe('About page deletions.')
  // beside the passage: right of the answer's column, its top on the tinted words' line (RefChip placeBeside)
  expect([pop()?.style.left, pop()?.style.top]).toEqual(['424px', '298px'])
  const side = await mount(<LabelsSidebar ws="mini" section="comments" onClose={() => undefined} />)
  await settle()
  await act(async () => side.querySelector<HTMLButtonElement>('[data-category="explainers"] .lside-name')!.click())
  await settle()
  expect(side.querySelector('.lside-comment-quote')?.textContent).toBe('“One account made all 5,217 of the page deletions, starting on Jun 4 and continuing through Jul 14.”')
})

test("a comment whose words the check's rewrite took away has no tint, and Go to it opens it beside the answer, saying so", async () => {
  serve([onSentence('e1', 'explainers', 'page deletions')])
  const rewrite = { ...JUN_4, rewrite: 'One account deleted [5,217] pages from [Jun 4] to [Jul 14].' }
  const el = await mount(<Rows rows={foldRecords(fixedRecords(rewrite))} ws="mini" chat="main" />)
  await settle()
  await settle()
  expect(el.querySelector('.chat-text')?.textContent).toContain('One account deleted 5,217 pages from Jun 4 to Jul 14.')
  expect(el.querySelector('mark.answer-tint')).toBeNull()
  await goTo('e1')
  await settle()
  // never at the page's top-left corner: beside the answer's text, its top on the answer's first line
  expect([pop()?.style.left, pop()?.style.top]).toEqual(['424px', '100px'])
  expect(pop()?.textContent).toContain('“page deletions” · the check of the citations changed these words')
})
