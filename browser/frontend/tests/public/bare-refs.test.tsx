// @vitest-environment jsdom
// A ref the model writes bare in a reply, without its [[ ]], is the same link as its [[ref]] (src/chat/markdown.tsx
// BARE_SRC): a report's passage, a view's unit, an orientation call, a thread and each form of a card's ref. Prose that
// only looks like one ("the report: it") stays text.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { refParts } from '../../src/canvas/RefEditor.tsx'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import { registerCells } from '../../src/lib/cellName.ts'
import { parseInline } from '../../src/report/inlineParse.ts'
import type { ResolvedRef } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  registerCells([{ id: 'ab12cd34', title: 'Wiki edits per agent', slug: 'wiki-edits' }])
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const refsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-ref]')].map((c) => c.dataset.ref)

test("a report passage's bare ref in a reply is a link, never its raw text", async () => {
  const el = await mount(<ChatMarkdown text="I named the setup, Sweep 2 Opus with PRs + issues, in report sentence report:report#a0104c0c." />)
  expect(refsIn(el)).toEqual(['report:report#a0104c0c'])
  expect(el.textContent).not.toContain('report:report')
  expect(el.textContent).toContain('in report sentence')
  expect(el.textContent?.trimEnd().endsWith('.')).toBe(true)
})

test('every kind of thimble ref written bare is a link, its trailing punctuation left as text', async () => {
  const text = [
    'A card card:ab12cd34, its run card:ab12cd34@2, its lines card:ab12cd34@out0#L3-5, its step card:ab12cd34#step-2,',
    'its cell card:ab12cd34#merged/agent-07. A label concept:k1a2b3c4, a group group:g1a2b3c4, a report report:findings,',
    'a paragraph report:story#p12, a view view:inbox, a unit view:inbox/c-4471; a call call:orient/12#L3-L9 and a thread chat:t1a2b3c4#5.',
  ].join(' ')
  const el = await mount(<ChatMarkdown text={text} />)
  expect(refsIn(el)).toEqual([
    'card:ab12cd34', 'card:ab12cd34@2', 'card:ab12cd34@out0#L3-5', 'card:ab12cd34#step-2', 'card:ab12cd34#merged/agent-07',
    'concept:k1a2b3c4', 'group:g1a2b3c4', 'report:findings', 'report:story#p12', 'view:inbox', 'view:inbox/c-4471',
    'call:orient/12#L3-L9', 'chat:t1a2b3c4#5',
  ])
})

test('prose that only looks like a ref stays text', async () => {
  const el = await mount(<ChatMarkdown text="In the report: it reads well. My point of view: fine. See https://x.org/view:abc and a [[report:findings]] link." />)
  expect(refsIn(el)).toEqual(['report:findings'])
})

test("a click on a bare passage's link opens the passage", async () => {
  vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: 'report:report#a0104c0c', kind: 'report', excerpt: 'Leaderless teams merged more PRs' } as unknown as ResolvedRef)
  const el = await mount(<ChatMarkdown text="in report sentence report:report#a0104c0c." />)
  const c = el.querySelector<HTMLElement>('[data-ref="report:report#a0104c0c"]')!
  const refs: string[] = []
  const off = bus.on('openRef', (e) => void refs.push(e.ref))
  await act(async () => c.click())
  await settle()
  off()
  expect(refs).toEqual(['report:report#a0104c0c'])
})

test('the takeaway editor and a report sentence read a bare passage ref as the same token', () => {
  expect(refParts('See report:report#a0104c0c.').map((p) => ('ref' in p ? p.ref : p.text))).toEqual(['See ', 'report:report#a0104c0c', '.'])
  const nodes = parseInline('As report:story#p3 says, `x` and **y**.')
  expect(nodes.filter((n) => n.kind === 'ref').map((n) => (n.kind === 'ref' ? n.ref : ''))).toEqual(['report:story#p3'])
  expect(nodes.some((n) => n.kind === 'code')).toBe(true)
  expect(nodes.some((n) => n.kind === 'strong')).toBe(true)
})
