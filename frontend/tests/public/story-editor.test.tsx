// @vitest-environment jsdom
// The story's editor (src/report/StoryEditor.tsx) under jsdom: a click makes a text block a field; Enter splits it and
// Backspace in an empty block removes it; `/` opens the block-type menu, typing narrows it, and Section starts a new
// section; a section's bar sets where its card stands; edits save as the story's sections (PUT …/story). No layout.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { StoryDoc } from '../../src/lib/types.ts'
import { StoryEditor } from '../../src/report/StoryEditor.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const DOC: StoryDoc = {
  renderer: 'story',
  title: 'Refunds',
  generation: 1,
  sections: [
    { id: 'sec00001', heading: '', card: 'right', paragraphs: [{ id: 'par00001', sentences: [{ id: 'sen00001', text: 'One charger drove them.', refs: [], tags: [] }] }], figures: [] },
    {
      id: 'sec00002',
      heading: 'They doubled',
      card: 'right',
      paragraphs: [{ id: 'par00002', sentences: [{ id: 'sen00002', text: 'Refunds doubled in March.', refs: [], tags: [] }, { id: 'sen00003', text: 'Most name one charger.', refs: [], tags: [] }] }],
      figures: [],
    },
  ],
}

let puts: { url: string; body: any }[] = []

beforeEach(() => {
  puts = []
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      puts.push({ url: u, body })
      return new Response(JSON.stringify({ ...DOC, title: body.title }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/canvas')) return new Response(JSON.stringify({ cells: [], groups: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 404 })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

async function editor(): Promise<HTMLElement> {
  return mount(<StoryEditor ws="mini" slug="story" doc={DOC} client="tab1" onSaved={() => {}} comments={[]} on={new Set()} look={{ colour: () => '', name: () => '' } as never} picked={null} filter={null} />)
}

const field = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('textarea.wu-se-field')!
const setValue = async (t: HTMLTextAreaElement, v: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(t, v)
    t.dispatchEvent(new Event('input', { bubbles: true }))
  })
const key = async (t: HTMLElement, k: string) => act(async () => void t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
const blockTexts = (el: HTMLElement, sec = 1) => [...el.querySelectorAll('.wu-se-sec')[sec].querySelectorAll('.wu-se-block')].map((b) => (b.querySelector('textarea.wu-se-field') as HTMLTextAreaElement | null)?.value ?? b.textContent)

describe("the story's editor", () => {
  test('the title stands as the first section\'s headline, and each other section opens with its own', async () => {
    const el = await editor()
    const secs = el.querySelectorAll('.wu-se-sec')
    expect(secs).toHaveLength(2)
    expect((secs[0].querySelector('.wu-se-title') as HTMLTextAreaElement).value).toBe('Refunds')
    expect((secs[1].querySelector('.wu-se-heading') as HTMLTextAreaElement).value).toBe('They doubled')
    expect(secs[1].querySelector('.wu-se-block')?.getAttribute('data-anchor')).toBe('report:story#ppar00002')
  })

  test('Enter starts a new block with the words after the caret, and Backspace in an empty block removes it', async () => {
    const el = await editor()
    const read = el.querySelectorAll('.wu-se-sec')[1].querySelector<HTMLElement>('.wu-se-read')!
    await act(async () => read.click())
    const t = field(el)
    expect(t.value).toBe('Refunds doubled in March. Most name one charger.')
    const at = 'Refunds doubled in March.'.length
    t.setSelectionRange(at, at)
    await key(t, 'Enter')
    expect(blockTexts(el)).toEqual(['Refunds doubled in March.', 'Most name one charger.'])
    // the caret is in the new block, at its start
    expect(document.activeElement).toBe(field(el))
    expect(field(el).value).toBe('Most name one charger.')
    await setValue(field(el), '')
    await key(field(el), 'Backspace')
    expect(blockTexts(el)).toEqual(['Refunds doubled in March.'])
  })

  test('`/` in an empty block opens the menu of block types, narrowed by what follows it', async () => {
    const el = await editor()
    const read = el.querySelectorAll('.wu-se-sec')[1].querySelector<HTMLElement>('.wu-se-read')!
    await act(async () => read.click())
    const t = field(el)
    t.setSelectionRange(t.value.length, t.value.length)
    await key(t, 'Enter')
    await setValue(field(el), '/')
    expect([...document.querySelectorAll('.wu-se-slash .menu-item')].map((b) => b.textContent)).toEqual(['Text', 'Headline', 'List', 'Card', 'Quote', 'Divider', 'Card image', 'Section'])
    await setValue(field(el), '/qu')
    expect([...document.querySelectorAll('.wu-se-slash .menu-item')].map((b) => b.textContent)).toEqual(['Quote'])
    await key(field(el), 'Enter')
    expect(el.querySelectorAll('.wu-se-sec')[1].querySelectorAll('.wu-se-block')[1].classList.contains('wu-se-b-quote')).toBe(true)
    expect(field(el).value).toBe('')
  })

  test('`/` Section splits the section there: the blocks after it open a new section, whose headline takes the caret', async () => {
    const el = await editor()
    const read = el.querySelectorAll('.wu-se-sec')[1].querySelector<HTMLElement>('.wu-se-read')!
    await act(async () => read.click())
    const t = field(el)
    const at = 'Refunds doubled in March.'.length
    t.setSelectionRange(at, at)
    await key(t, 'Enter')
    // Enter at the start of the second sentence's block leaves an empty block before it, which takes the slash
    field(el).setSelectionRange(0, 0)
    await key(field(el), 'Enter')
    expect(blockTexts(el)).toEqual(['Refunds doubled in March.', '', 'Most name one charger.'])
    await act(async () => el.querySelectorAll('.wu-se-sec')[1].querySelector<HTMLElement>('.wu-se-read.wu-se-empty')!.click())
    await setValue(field(el), '/sec')
    expect([...document.querySelectorAll('.wu-se-slash .menu-item')].map((b) => b.textContent)).toEqual(['Section'])
    await key(field(el), 'Enter')
    const secs = el.querySelectorAll('.wu-se-sec')
    expect(secs).toHaveLength(3)
    expect(blockTexts(el, 1)).toEqual(['Refunds doubled in March.'])
    expect(blockTexts(el, 2)).toEqual(['Most name one charger.'])
    expect(document.activeElement).toBe(secs[2].querySelector('.wu-se-heading'))
  })

  test("a section's bar sets where its card stands, and the story is saved as its sections", async () => {
    const el = await editor()
    const sec = el.querySelectorAll('.wu-se-sec')[1]
    const opts = [...sec.querySelectorAll<HTMLButtonElement>('.wu-se-bar .seg-opt')]
    expect(opts.map((b) => [b.getAttribute('aria-label'), b.textContent, b.getAttribute('aria-checked')])).toEqual([
      ['Card on the right', '', 'true'],
      ['Card on the left', '', 'false'],
      ['Card full width', '', 'false'],
      ['No card', '', 'false'],
    ])
    const left = opts[1]
    await act(async () => left.click())
    expect(left.getAttribute('aria-checked')).toBe('true')
    expect(el.querySelectorAll('.wu-se-sec')[1].classList.contains('wu-se-left')).toBe(true)
    await act(async () => new Promise((r) => setTimeout(r, 900)))
    await settle()
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe('/api/ws/mini/investigations/main/types/story/story')
    expect(puts[0].body).toEqual({
      title: 'Refunds',
      client: 'tab1',
      sections: [
        { id: 'sec00001', heading: '', card: 'right', main: null, blocks: [{ id: 'par00001', type: 'text', text: 'One charger drove them.' }] },
        { id: 'sec00002', heading: 'They doubled', card: 'left', main: null, blocks: [{ id: 'par00002', type: 'text', text: 'Refunds doubled in March. Most name one charger.' }] },
      ],
    })
  })
})
