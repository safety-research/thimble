// @vitest-environment jsdom
// One comment card for every comment, in the Report's margin and on the canvas (src/report/CommentCard.tsx): its
// header is its check's name in the check's color beside the color square, with no "Claude" before it; it shows its
// statement, and its details only once Show more under the statement opens them (Show less folds them again), their
// citations as chips; ✓ (Done) resolves it, and its head holds nothing else (no Ask, no Know it); a click makes it
// active, with a field whose text opens a thread anchored to the comment's place with the comment's id and words. Matt
// 2026-10-09: "it shows a short comment, then you expand for
// details (which can contain some citations), and can ask follow ups"; "instead of the >, use text like 'Show more' or
// something that's placed below the short description".
import { act, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CommentCard, threadText, type CommentThread, type CommentView } from '../../src/report/CommentCard.tsx'
import { extraEvidence, openComments } from '../../src/report/checkComments.ts'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta, WriteupComment } from '../../src/lib/types.ts'
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

describe('what a comment shows', () => {
  test("its check's name in the check's color and its statement; its details only once Show more under it opens them", async () => {
    const el = await mount(<Held comment={IMPORTANT} />)
    const name = el.querySelector<HTMLElement>('.wu-cm-name')!
    expect(name.textContent).toBe('Important details')
    expect(name.style.color).toBe('var(--label-2)')
    expect(el.querySelector<HTMLElement>('.wu-cm-sq')!.style.background).toBe('var(--label-2)')
    expect(el.querySelector('.wu-cm-head')!.textContent).not.toContain('Claude')
    expect(el.querySelector('.wu-cm-head')!.textContent).not.toContain('Heads up')
    expect(el.querySelector('.wu-cm-statement')!.textContent).toBe('Blocking the web also blocks GitHub.')
    expect(el.querySelector('.wu-cm-details')).toBeNull()
    expect(el.textContent).not.toContain('Bake them')

    // no chevron in the header: the control is a button of words, after the statement
    expect(el.querySelector('.wu-cm .wu-chev')).toBeNull()
    expect([...el.querySelectorAll('.wu-cm-head button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'))).toEqual(['Done'])
    expect(el.textContent).not.toContain('Ask')
    expect(el.textContent).not.toContain('Know it')
    const more = el.querySelector<HTMLButtonElement>('.wu-cm-more')!
    expect(more.tagName).toBe('BUTTON')
    expect(more.textContent).toBe('Show more')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    const order = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(order(el.querySelector('.wu-cm-statement')!, more)).toBeTruthy()
    await click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(more.textContent).toBe('Show less')
    const details = el.querySelector('.wu-cm-details')!
    expect(order(details, more)).toBeTruthy() // Show less stands under the details it folds
    expect([...details.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual(['The pandas build fetches two libraries from GitHub 2.', 'Bake them into the image.'])
    expect([...details.querySelectorAll<HTMLElement>('.refchip')].map((c) => c.dataset.ref)).toEqual(['card:abc123#libs/TOTAL'])
    expect(el.querySelector('.wu-cm-reply')).toBeNull() // Show more opens the details, not the field
    await click(more)
    expect(el.querySelector('.wu-cm-details')).toBeNull()
    expect(more.textContent).toBe('Show more')
  })

  test('a comment with no details has no Show more; the refs its statement cited show as chips in its details', async () => {
    const plain = await mount(<Held comment={{ ...IMPORTANT, details: '', evidence: [] }} />)
    expect(plain.querySelector('.wu-cm-more')).toBeNull()
    expect(plain.textContent).not.toContain('Show more')
    expect(extraEvidence(['card:a', 'card:b'], 'see [[card:a]]')).toEqual(['card:b'])
    const cited = await mount(<Held comment={{ ...IMPORTANT, details: '', evidence: ['card:abc123'] }} />)
    await click(cited.querySelector('.wu-cm-more'))
    expect([...cited.querySelectorAll<HTMLElement>('.wu-cm-details .refchip')].map((c) => c.dataset.ref)).toEqual(['card:abc123'])
  })

  test("Claude's note and the analyst's own name their author, each with ✓ alone in its head", async () => {
    const el = await mount(
      <>
        <Held comment={{ ...IMPORTANT, id: 'n1', check: null, author: 'claude' }} />
        <Held comment={{ ...IMPORTANT, id: 'n2', check: null, author: 'analyst', details: '' }} />
      </>,
    )
    expect([...el.querySelectorAll('.wu-cm-name')].map((n) => n.textContent)).toEqual(['Claude', 'You'])
    expect([...el.querySelectorAll('.wu-cm-head')].map((h) => [...h.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')))).toEqual([['Done'], ['Done']])
  })

  test("a document's stored comments carry their details to the margin; one resolved as known before 0.7.0 stays resolved", () => {
    const stored = [
      { id: 'c1', sentence_id: 's1', text: 'The table counts 311, not 411.', details: 'See [[card:abc123]].', author: 'check', check: 'unverified', status: 'open', evidence: 'card:abc123' },
      { id: 'c2', sentence_id: 's1', text: 'The account is a bot.', details: '', author: 'check', check: 'important-details', status: 'dismissed', resolution: 'known' },
    ] as unknown as WriteupComment[]
    const got = openComments(stored, [])
    expect(got.map((c) => c.id)).toEqual(['c1'])
    const [c] = got
    expect([c.text, c.details, c.evidence]).toEqual(['The table counts 311, not 411.', 'See [[card:abc123]].', ['card:abc123']])
  })
})

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

  test("a thread from the Report's margin is anchored to the comment's passage", () => {
    const thread: CommentThread = { anchor: 'report:report#s4', passage: 'Most saves came in one week of June.', surface: 'report' }
    expect(threadText({ ...IMPORTANT, check: null, author: 'claude', details: '' }, 'Claude', thread)).toBe('Most saves came in one week of June.\n\nClaude’s comment k1: Blocking the web also blocks GitHub.')
  })
})
