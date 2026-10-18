// @vitest-environment jsdom
// One comment card for every comment, in the Report's margin, on the canvas and under Claude's answer in main's chat
// (src/report/CommentCard.tsx): its header is its check's name in the check's color beside the color square, with no
// "Claude" before it; it shows its statement, and its details only once Show more under the statement opens them
// (Show less folds them again), their citations as chips; ✓ (Done) resolves it, and its head holds nothing else (no
// Ask, no Know it); a click makes it active, with a field whose text opens a thread anchored to the comment's place
// with the comment's id and words.
import { act, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CommentCard, type CommentThread, type CommentView } from '../../src/report/CommentCard.tsx'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import { type AnswerComment } from '../../src/chat/answerComments.ts'
import { foldRecords } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const look = { colour: (id: string | null) => (id == null ? 'var(--label-none)' : 'var(--label-2)'), name: (id: string | null) => (id === 'important-details' ? 'Important details' : (id ?? 'You')) }
const IMPORTANT: CommentView = {
  id: 'k1',
  check: 'important-details',
  author: 'check',
  text: 'Blocking the web also blocks GitHub.',
  details: '- The pandas build fetches two libraries from GitHub [[2|card:abc123#libs/TOTAL]].\n- Bake them into the image.',
  evidence: ['card:abc123#libs/TOTAL'],
}
const ON_STEP: CommentThread = { anchor: 'card:abc123#step-2', passage: 'Plan: build the environment and pilot it', where: 'step 2', surface: 'canvas' }

/** A card whose active state its parent holds, as the margin and the canvas hold it. */
function Held({ comment, onResolve, thread = ON_STEP }: { comment: CommentView; onResolve?: () => Promise<void>; thread?: CommentThread }) {
  const [active, setActive] = useState(false)
  return <CommentCard ws="w" comment={comment} look={look} active={active} onActivate={() => setActive(true)} onResolve={onResolve ?? (async () => {})} thread={thread} />
}

const click = (el: Element | null) => act(async () => (el as HTMLElement).click())

describe("a comment's actions", () => {
  test("✓ resolves a check's comment, once per press; the citation check's tag has no ✓", async () => {
    let done = 0
    const el = await mount(<Held comment={IMPORTANT} onResolve={async () => void (done += 1)} />)
    await click(el.querySelector('.wu-cm-resolve'))
    expect(done).toBe(1)
    const tag = await mount(<Held comment={{ ...IMPORTANT, id: 'tag:s1', check: 'unverified', details: '', evidence: [], fixed: true }} />)
    expect(tag.querySelector('.wu-cm-resolve')).toBeNull()
    expect(tag.querySelectorAll('.wu-cm-head button').length).toBe(0)
  })

  test('a click makes the comment active with its field, and the question opens a thread anchored to the comment', async () => {
    const made: Parameters<typeof api.createThread>[1][] = []
    vi.spyOn(api, 'createThread').mockImplementation(async (_ws, body) => {
      made.push(body)
      return { id: 't1' } as ChatMeta
    })
    const opened: string[] = []
    const off = bus.on('openChat', ({ chatId }) => void opened.push(chatId))
    const el = await mount(<Held comment={IMPORTANT} />)
    expect(el.querySelector('.wu-cm-reply')).toBeNull()
    await click(el.querySelector('.wu-cm-statement'))
    expect(el.querySelector('.wu-cm')!.classList.contains('wu-cm-active')).toBe(true)
    expect(el.querySelector('.wu-cm-details')).not.toBeNull()
    const field = el.querySelector<HTMLTextAreaElement>('.wu-cm-reply textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Which two libraries?')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle()
    off()
    expect(made).toEqual([
      {
        anchor: 'card:abc123#step-2',
        anchor_text: `Plan: build the environment and pilot it\n\nThe comment k1 of the check “Important details” (on step 2): Blocking the web also blocks GitHub.\n\n${IMPORTANT.details}`,
        surface: 'canvas',
        element: 'comment',
        text: 'Which two libraries?',
        comment: 'k1',
      },
    ])
    expect(opened).toEqual(['t1'])
  })
})

// main's chat: a check's comment on Claude's answer opens under the answer from its tinted passage, as this same card
// (src/chat/AnswerComment.tsx, src/chat/Rows.tsx).
describe("a check's comment on Claude's answer, in main's chat", () => {
  const TURN = '5e55a000-0000-4000-8000-00000000a001'
  const ROW = '5e55a000-0000-4000-8000-00000000a002'
  const ANSWER = 'The board holds 412 posts. After 19 June there are **0 new messages** to other agents.\n\nThe rest is quiet.'
  const answerComment = (): AnswerComment => ({
    id: 'ac1', check: 'important-details', check_name: 'Important details', color: 2, turn: TURN, row: ROW, ref: `answer:${TURN}#s2`,
    start: 27, end: 90, quote: 'After 19 June there are **0 new messages** to other agents.', text: 'The label could not read 899 revisions.',
    details: 'See [[card:hidden-revisions]] for them.', status: 'open',
  })
  let posts: string[] = []
  const records: ChatRecord[] = [{ type: 'user', text: 'What happened after 19 June?' }, { type: 'text', delta: ANSWER, uuid: ROW } as ChatRecord, { type: 'done', result: null } as ChatRecord]
  async function chat(): Promise<HTMLElement> {
    posts = []
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
      const u = String(url)
      if (init.method === 'POST') posts.push(u)
      const body = u.endsWith('/answer-comments') ? { comments: [answerComment()], running: [] } : u.includes('/answer-comments/') ? { ok: true } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const el = await mount(<Rows rows={foldRecords(records)} ws="mini" chat="main" />)
    await settle()
    await settle()
    return el
  }
  afterEach(() => vi.unstubAllGlobals())

  test('the tinted passage opens the comment card the canvas draws, at rest: name, statement, Show more and ✓', async () => {
    const el = await chat()
    const tint = el.querySelector<HTMLElement>('mark.answer-tint')!
    expect(el.querySelector('.wu-cm')).toBeNull()
    await click(tint)
    const card = el.querySelector<HTMLElement>('.chat-assistant .wu-cm.answer-cm')!
    expect(card.dataset.comment).toBe('ac1')
    expect(card.classList.contains('wu-cm-active')).toBe(false)
    expect(card.querySelector<HTMLElement>('.wu-cm-sq')!.style.background).toBe('var(--label-2)')
    expect(card.querySelector('.wu-cm-name')?.textContent).toBe('Important details')
    expect(card.querySelector('.wu-cm-statement')?.textContent).toBe(answerComment().text)
    expect(card.querySelector('.wu-cm-details')).toBeNull()
    expect(card.querySelector('.wu-cm-more')?.getAttribute('aria-expanded')).toBe('false')
    expect(card.querySelector('.wu-cm-resolve')).not.toBeNull()
    // the head holds the name and ✓ alone: no Close, no Done button, no <details> disclosure
    expect(card.querySelectorAll('button').length).toBe(2)
    expect(card.querySelector('details')).toBeNull()
    expect(el.querySelector('mark.answer-tint-open')).not.toBeNull()
    // Show more opens the details, their citation a chip
    await click(card.querySelector('.wu-cm-more'))
    expect(card.querySelector('.wu-cm-details [data-ref="card:hidden-revisions"]')).not.toBeNull()
    // a second click on the passage folds the card away
    await click(el.querySelector('mark.answer-tint'))
    expect(el.querySelector('.wu-cm')).toBeNull()
  })

  test('a click makes it active with its field, a click outside lets it go, and ✓ dismisses it and its tint', async () => {
    const el = await chat()
    await click(el.querySelector('mark.answer-tint'))
    const card = () => el.querySelector<HTMLElement>('.wu-cm.answer-cm')!
    await click(card().querySelector('.wu-cm-statement'))
    expect(card().classList.contains('wu-cm-active')).toBe(true)
    expect(card().querySelector('.wu-cm-reply textarea')).not.toBeNull()
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(card().classList.contains('wu-cm-active')).toBe(false)
    await click(card().querySelector('.wu-cm-resolve'))
    await settle()
    expect(posts).toEqual(['/api/ws/mini/answer-comments/ac1/dismiss'])
    expect(el.querySelector('.wu-cm')).toBeNull()
    expect(el.querySelector('mark.answer-tint')).toBeNull()
  })
})
