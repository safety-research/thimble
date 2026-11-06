// @vitest-environment jsdom
// One comment card for every comment, in the Report's margin and on the canvas (src/report/CommentCard.tsx): a click
// makes it active, with a field whose question opens a side thread anchored to the comment's place, with the comment's
// id and words, and ✓ (Done) resolves it.
import { act, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
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
function Held({ onResolve }: { onResolve: () => Promise<void> }) {
  const [active, setActive] = useState(false)
  return <CommentCard ws="w" comment={IMPORTANT} look={look} active={active} onActivate={() => setActive(true)} onResolve={onResolve} thread={ON_STEP} />
}
const click = (el: Element | null) => act(async () => (el as HTMLElement).click())

test("a comment's question opens a side thread anchored to the comment, and ✓ resolves the comment", async () => {
  const made: Parameters<typeof api.createThread>[1][] = []
  vi.spyOn(api, 'createThread').mockImplementation(async (_ws, body) => {
    made.push(body)
    return { id: 't1' } as ChatMeta
  })
  const opened: string[] = []
  const off = bus.on('openChat', ({ chatId }) => void opened.push(chatId))
  let resolved = 0
  const el = await mount(<Held onResolve={async () => void (resolved += 1)} />)
  expect(el.querySelector('.wu-cm-reply')).toBeNull()
  await click(el.querySelector('.wu-cm-statement'))
  const field = el.querySelector<HTMLTextAreaElement>('.wu-cm-reply textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Which two libraries?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await settle()
  off()
  expect(made).toHaveLength(1)
  expect(made[0]).toMatchObject({ anchor: 'card:abc123#step-2', surface: 'canvas', element: 'comment', comment: 'k1', text: 'Which two libraries?' })
  // the thread reads the passage and the comment it is about
  expect(made[0].anchor_text).toContain('Plan: build the environment and pilot it')
  expect(made[0].anchor_text).toContain('Blocking the web also blocks GitHub.')
  expect(opened).toEqual(['t1'])
  await click(el.querySelector('.wu-cm-resolve'))
  expect(resolved).toBe(1)
})
