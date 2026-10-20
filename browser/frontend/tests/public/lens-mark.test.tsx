// @vitest-environment jsdom
// A mark's card opens under its words with the lens's name as a quiet line and the mark's title as the heading, and its
// own text shows none of the reply's marks: an explainer's term that the reply marks stays plain inside an important
// detail's card.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
import type { Mark } from '../../src/lib/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const marks: Mark[] = [
  { id: 'm1', lens: 'explain', term: 'qux', body: 'The name of one wiki in the data.' },
  {
    id: 'm2',
    lens: 'details',
    term: 'a few sources may sit behind many names',
    title: 'Name count may overstate people',
    body: '- The qux edits came from many names.\n- The ranges are coarse.',
    here: 'Group the names by range before saying no one dominated.',
  },
]
const text = 'The qux wiki got most edits. So a few sources may sit behind many names, which I have not checked.'

test("a mark's card has the title as its heading, a quiet lens name, and no marks of its own", async () => {
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set() }}>
      <ChatMarkdown text={text} marks={marks} />
    </ChipContext.Provider>,
  )
  await settle()
  expect([...el.querySelectorAll<HTMLElement>('.lens-mark')].map((m) => m.dataset.lens)).toEqual(['explain', 'details'])

  const term = el.querySelector<HTMLElement>('.lens-mark[data-lens=details] > .lens-mark-term')!
  await act(async () => term.click())
  const card = el.querySelector<HTMLElement>('.lens-card')!
  expect(card.querySelector('.lens-card-kind')?.textContent).toBe('Important details')
  expect(card.querySelector('.lens-card-title')?.textContent).toBe('Name count may overstate people')
  // the marked words are not repeated: they stand in their tint just above the card
  expect(card.textContent).not.toContain('a few sources may sit behind many names')
  expect(card.querySelectorAll('li')).toHaveLength(2)
  expect(card.querySelector('.lens-card-here')?.textContent).toBe('To doGroup the names by range before saying no one dominated.')
  // the explainer's term is plain text inside the card
  expect(card.textContent).toContain('The qux edits came from many names.')
  expect(card.querySelectorAll('.lens-mark')).toHaveLength(0)

  // an explainer has no title: its term is the heading
  await act(async () => term.click())
  await act(async () => el.querySelector<HTMLElement>('.lens-mark[data-lens=explain] > .lens-mark-term')!.click())
  const gloss = el.querySelector<HTMLElement>('.lens-card')!
  expect(gloss.querySelector('.lens-card-kind')?.textContent).toBe('Explainers')
  expect(gloss.querySelector('.lens-card-title')?.textContent).toBe('qux')
})
