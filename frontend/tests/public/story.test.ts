// The story's pure helpers (src/report/storyModel.ts): a section's blocks in reading order, the editor's sections and
// their save, the edits the editor makes, the cards a story shows and a step's terms.
import { describe, expect, test } from 'vitest'
import type { WriteupSection } from '../../src/lib/types.ts'
import {
  editSections,
  moveBlock,
  moveSection,
  retype,
  sectionBlocks,
  stepBlock,
  stepMatches,
  storyBody,
  storyCells,
  type StorySection,
} from '../../src/report/storyModel.ts'

const s = (id: string, text: string, bullet?: '-') => ({ id, text, refs: [], tags: [], ...(bullet ? { bullet } : {}) })

const SECTION: WriteupSection = {
  id: 'sec1',
  heading: 'Refunds doubled',
  card: 'left',
  paragraphs: [
    { id: 'p1', sentences: [s('s1', 'They doubled.'), s('s2', 'In one week.')] },
    { id: 'p2', sentences: [s('s3', 'The X200.', '-'), s('s4', 'A week of use.', '-')] },
    { id: 'p3', kind: 'quote', speaker: 'a customer', sentences: [s('s5', 'It stopped after four days.')] },
    { id: 'p4', kind: 'divider', sentences: [] },
  ],
  figures: [
    { id: 'm1', cell: 'card:t1', caption: 'Per week', role: 'main', after_paragraph: null, highlight: ['week 11'] },
    { id: 'f1', cell: 'card:n1', caption: 'Leading', after_paragraph: null },
    { id: 'f2', cell: 'card:t1', caption: 'Its picture', after_paragraph: 'p2', role: 'image' },
    { id: 'f3', cell: 'card:c1', caption: 'Orphan', after_paragraph: 'gone' },
  ],
}

let n = 0
const mint = () => `id${++n}`

describe("a stored section's blocks", () => {
  test('the cards that lead it, each paragraph with the cards after it, the orphans last, and never its own card', () => {
    const blocks = sectionBlocks(SECTION)
    expect(blocks.map((b) => [b.id, b.type])).toEqual([
      ['f1', 'card'],
      ['p1', 'text'],
      ['p2', 'bullets'],
      ['f2', 'image'],
      ['p3', 'quote'],
      ['p4', 'divider'],
      ['f3', 'card'],
    ])
    expect(blocks[1].text).toBe('They doubled. In one week.')
    expect(blocks[2].text).toBe('The X200.\nA week of use.')
    expect(blocks[4].speaker).toBe('a customer')
  })

  test("the editor's sections: where each card stands and its card; a story with none opens on a new section", () => {
    const [sec] = editSections({ sections: [SECTION] }, mint)
    expect(sec.side).toBe('left')
    expect(sec.main).toEqual({ id: 'm1', cell: 'card:t1', caption: 'Per week' })
    const fresh = editSections({ sections: [] }, mint)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatchObject({ heading: '', side: 'right', main: null, blocks: [{ type: 'bullets', text: '' }] })
  })

  test('the save: a card block not given a card is left out, a divider carries no text, a quote its speaker', () => {
    const sections: StorySection[] = [
      {
        id: 'a',
        heading: '  Two   words ',
        side: 'none',
        main: { id: 'm', cell: 'card:t1', caption: 'x' },
        blocks: [
          { id: 'b1', type: 'text', text: 'One.' },
          { id: 'b2', type: 'card', text: '', cell: '', caption: '' },
          { id: 'b3', type: 'divider', text: '' },
          { id: 'b4', type: 'quote', text: 'Said.', speaker: ' someone ' },
          { id: 'b5', type: 'image', text: '', cell: 'card:t1', caption: 'Pic' },
        ],
      },
    ]
    const body = storyBody(' A  title ', sections, 'tab')
    expect(body.title).toBe('A title')
    expect(body.client).toBe('tab')
    expect(body.sections[0]).toMatchObject({ id: 'a', heading: 'Two words', card: 'none', main: { id: 'm', cell: 'card:t1', caption: 'x' } })
    expect(body.sections[0].blocks).toEqual([
      { id: 'b1', type: 'text', text: 'One.' },
      { id: 'b3', type: 'divider' },
      { id: 'b4', type: 'quote', text: 'Said.', speaker: 'someone' },
      { id: 'b5', type: 'image', cell: 'card:t1', caption: 'Pic' },
    ])
  })
})

describe("the editor's edits", () => {
  const two = (): StorySection[] => [
    { id: 'A', heading: 'A', side: 'right', main: null, blocks: ['a1', 'a2', 'a3'].map((id) => ({ id, type: 'text' as const, text: id })) },
    { id: 'B', heading: 'B', side: 'right', main: null, blocks: ['b1'].map((id) => ({ id, type: 'text' as const, text: id })) },
  ]
  const ids = (secs: StorySection[]) => secs.map((x) => x.blocks.map((b) => b.id))

  test('a block moved within its section counts the index as the section stood before the move', () => {
    expect(ids(moveBlock(two(), 'a1', 0, 3))).toEqual([['a2', 'a3', 'a1'], ['b1']])
    expect(ids(moveBlock(two(), 'a3', 0, 0))).toEqual([['a3', 'a1', 'a2'], ['b1']])
    expect(ids(moveBlock(two(), 'a2', 0, 1))).toEqual([['a1', 'a2', 'a3'], ['b1']])
  })

  test('a block moved into another section, and one step at a time across a section edge', () => {
    expect(ids(moveBlock(two(), 'a2', 1, 1))).toEqual([['a1', 'a3'], ['b1', 'a2']])
    expect(ids(stepBlock(two(), 'a3', 1))).toEqual([['a1', 'a2'], ['a3', 'b1']])
    expect(ids(stepBlock(two(), 'b1', -1))).toEqual([['a1', 'a2', 'a3', 'b1'], []])
    expect(ids(stepBlock(two(), 'a1', -1))).toEqual([['a1', 'a2', 'a3'], ['b1']])
    expect(ids(stepBlock(two(), 'a1', 1))).toEqual([['a2', 'a1', 'a3'], ['b1']])
  })

  test('a block retyped keeps its words where the new type has words', () => {
    expect(retype({ id: 'x', type: 'bullets', text: 'One.\nTwo.' }, 'text')).toEqual({ id: 'x', type: 'text', text: 'One. Two.' })
    expect(retype({ id: 'x', type: 'text', text: 'Said.' }, 'quote')).toEqual({ id: 'x', type: 'quote', text: 'Said.', speaker: '' })
    expect(retype({ id: 'x', type: 'text', text: 'Gone.' }, 'divider')).toEqual({ id: 'x', type: 'divider', text: '' })
    expect(retype({ id: 'x', type: 'text', text: 'Gone.' }, 'card')).toEqual({ id: 'x', type: 'card', text: '', cell: '', caption: '' })
  })

  test('a section moved counts the index as the story stood before the move', () => {
    const three = [...two(), { id: 'C', heading: 'C', side: 'right' as const, main: null, blocks: [] }]
    expect(moveSection(three, 0, 3).map((x) => x.id)).toEqual(['B', 'C', 'A'])
    expect(moveSection(three, 2, 0).map((x) => x.id)).toEqual(['C', 'A', 'B'])
    expect(moveSection(three, 1, 2).map((x) => x.id)).toEqual(['A', 'B', 'C'])
  })
})

describe('the cards a story shows', () => {
  test("the cards a story shows, for the sidebar's ✓, and a step's terms as words of their own", () => {
    expect(storyCells({ sections: [SECTION] })).toEqual(['card:t1', 'card:n1', 'card:t1', 'card:c1'])
    expect(stepMatches('week 11 212', ['week 11'])).toBe(true)
    expect(stepMatches('week 110', ['week 11'])).toBe(false)
  })
})
