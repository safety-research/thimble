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
import { CommentCard, type CommentThread, type CommentView } from '../../src/report/CommentCard.tsx'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
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
