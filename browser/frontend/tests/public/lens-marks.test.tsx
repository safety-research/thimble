// @vitest-environment jsdom
// A lens's marks (src/lib/marks.ts, src/components/LensMark.tsx, src/chat/markdown.tsx): a mark shows where its lens is
// on and its surface is in the lens's scope, on words outside a citation; a click opens its card with the lens's name,
// what it says, and Ask; the citations feature turned off draws a citation's words as plain text.
import { act } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { setFeatureRows } from '../../src/features.ts'
import { shownMarks, type Lens, type Mark } from '../../src/lib/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const lens = (id: string, scope: Partial<Lens['scope']>, on = true): Lens => ({
  id, name: id === 'explain' ? 'Explainers' : 'No citation', color: id === 'explain' ? 'teal' : 'pink', builtin: id === 'explain', on,
  scope: { chat: false, cards: false, report: false, ...scope }, question: '', leaves: '', instructions: null, found: { chat: 0, cards: 0, report: 0 },
})
const mark = (id: string, l: string, term: string): Mark => ({ id, lens: l, surface: 'chat', where: 'main', term, title: `About ${term}`, body: `What ${term} means.` })

afterEach(() => {
  unmountAll()
  setFeatureRows([])
})

describe('which marks show', () => {
  test('a lens off, or a surface out of its scope, hides its marks; the lenses feature off hides them all', () => {
    const lenses = [lens('explain', { chat: true }), lens('k1', { report: true })]
    const marks = [mark('m1', 'explain', 'merge queue'), mark('m2', 'k1', 'every run')]
    expect(shownMarks(marks, lenses, 'chat').map((m) => m.id)).toEqual(['m1'])
    expect(shownMarks(marks, [lens('explain', { chat: true }, false)], 'chat').map((m) => m.id)).toEqual(['m2'])
    setFeatureRows([{ name: 'lenses', title: '', does: '', on: false }])
    expect(shownMarks(marks, lenses, 'chat')).toEqual([])
  })
})

describe('a mark in the text', () => {
  test('its words carry the mark; a click opens its card with the lens name, what it says and Ask', async () => {
    const lenses = [lens('explain', { chat: true })]
    const el = await mount(<ChatMarkdown text="It sat in the merge queue for a day." marks={[mark('m1', 'explain', 'merge queue')]} lenses={lenses} />)
    await settle()
    const term = el.querySelector<HTMLElement>('[data-mark="m1"] .lens-mark-term')!
    expect(term.textContent).toBe('merge queue')
    expect(el.querySelector('[data-mark="m1"]')?.getAttribute('data-anchor')).toBe('mark:m1')
    await act(async () => term.click())
    const card = el.querySelector('.lens-card')!
    expect(card.querySelector('.lens-card-lens')?.textContent).toBe('Explainers')
    expect(card.textContent).toContain('What merge queue means.')
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Ask', 'Close'])
  })

  test('with citations off, a citation is its words as plain text', async () => {
    setFeatureRows([{ name: 'citations', title: '', does: '', on: false }])
    const el = await mount(<ChatMarkdown text="[13](card:abc12345#outcome/merged) of the runs merged." />)
    await settle()
    expect(el.querySelector('.refchip, [data-ref]')).toBeNull()
    expect(el.textContent).toContain('13 of the runs merged.')
  })
})
