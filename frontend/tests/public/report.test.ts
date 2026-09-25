// The report editor's model (src/report/model.ts). A stored document becomes editor blocks and back: a block the
// analyst did not touch saves the writer's own text unchanged, a citation is one atom that is never split or lost, a
// prompt block is never saved, and the blocks the analyst locked are named so the editor shows them locked.
import { describe, expect, test } from 'vitest'
import {
  anchorAbove,
  blocksFromDoc,
  CITE_CHAR,
  contentFromText,
  editorBlocksFromWire,
  lockedBlocks,
  origTexts,
  plainOf,
  PROMPT_TYPE,
  readableOf,
  readableText,
  sameWire,
  textFromContent,
  TITLE_ID,
  wireFromEditor,
} from '../../src/report/model.ts'
import type { Writeup } from '../../src/lib/types.ts'

type Doc = Pick<Writeup, 'title' | 'sections' | 'title_locked'>
const sentence = (id: string, text: string, extra: object = {}) => ({ id, text, refs: [], tags: [], ...extra })
const doc = (d: object) => d as unknown as Doc

const DOC = doc({
  title: 'Review load decided which pull requests merged',
  sections: [
    {
      id: 's1',
      heading: 'The data',
      paragraphs: [
        { id: 'p1', sentences: [sentence('a1', 'There are [[345|card:ff73e071#prs/TOTAL]] pull requests.'), sentence('a2', 'Most were opened by **agent-04**.')] },
        { id: 'p2', sentences: [sentence('b1', 'first point', { bullet: '-' }), sentence('b2', 'second point [[card:abcdef12]]', { bullet: '-' })] },
        { id: 'p3', sentences: [sentence('c1', 'one', { bullet: '1.' })] },
      ],
      figures: [
        { id: 'f1', cell: 'card:abcdef12', caption: 'Per agent', after_paragraph: 'p1' },
        { id: 'f0', cell: 'card:abcdef13', caption: 'Lead', after_paragraph: null, lead: true },
        { id: 'f9', cell: null, make: 'a timeline', caption: 'Pending', after_paragraph: 'gone' },
      ],
    },
    { id: 's2', heading: 'Empty', paragraphs: [], figures: [] },
  ],
})

describe('document to blocks', () => {
  test('headings, lead figures, paragraphs, one block per bullet, placed figures, then the rest', () => {
    const wire = blocksFromDoc(DOC)
    expect(wire.title).toBe('Review load decided which pull requests merged')
    expect(wire.blocks.map((b) => [b.id, b.type])).toEqual([
      ['s1', 'heading'],
      ['f0', 'figure'],
      ['p1', 'paragraph'],
      ['f1', 'figure'],
      ['b1', 'bullet'],
      ['b2', 'bullet'],
      ['c1', 'bullet'],
      ['f9', 'figure'],
      ['s2', 'heading'],
    ])
    expect((wire.blocks[2] as { text: string }).text).toBe('There are [[345|card:ff73e071#prs/TOTAL]] pull requests. Most were opened by **agent-04**.')
    expect(wire.blocks[6]).toEqual({ id: 'c1', type: 'bullet', text: 'one', marker: '1.' })
    expect(blocksFromDoc(doc({ title: '', sections: [] })).blocks).toHaveLength(0)
  })

  test('a section without a heading gets no heading block', () => {
    const wire = blocksFromDoc(doc({
      title: 'T',
      sections: [
        { id: 's0', heading: '', paragraphs: [{ id: 'p0', sentences: [sentence('a', 'Moved up.')] }] },
        { id: 's1', heading: 'First', paragraphs: [{ id: 'p1', sentences: [sentence('b', 'Under it.')] }] },
      ],
    }))
    expect(wire.blocks.map((b) => [b.type, b.id])).toEqual([['paragraph', 'p0'], ['heading', 's1'], ['paragraph', 'p1']])
    expect(editorBlocksFromWire(wire).map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'paragraph'])
  })
})

describe('inline text', () => {
  test('styled text, links and citation atoms, and back to the same markdown', () => {
    const text = 'There are [[345|card:ff73e071#prs/TOTAL]] pull requests, **most** by *agent-04*, see [the log](https://example.org/log) and `forge pr list` and card:abcdef12.'
    const content = contentFromText(text) as any[]
    expect(content[0]).toEqual({ type: 'text', text: 'There are ', styles: {} })
    expect(content[1]).toEqual({ type: 'cite', props: { value: '345', ref: 'card:ff73e071#prs/TOTAL' } })
    expect(content[3]).toEqual({ type: 'text', text: 'most', styles: { bold: true } })
    expect(content[5]).toEqual({ type: 'text', text: 'agent-04', styles: { italic: true } })
    expect(content[7]).toEqual({ type: 'link', href: 'https://example.org/log', content: [{ type: 'text', text: 'the log', styles: {} }] })
    expect(content[9]).toEqual({ type: 'text', text: 'forge pr list', styles: { code: true } })
    expect(content[11]).toEqual({ type: 'cite', props: { value: '', ref: 'card:abcdef12' } })
    expect(textFromContent(content)).toBe(text.replace('card:abcdef12.', '[[card:abcdef12]].'))
  })

  test("a round trip of the writer's own spelling is the identity", () => {
    for (const t of [
      'Reviews cluster in the first hour.',
      'The first hour alone has [[88|card:c5466383@out0#L2]] reviews.',
      'To my reading these are **stale** branches; the data does not say so.',
      'A citation in code stays a citation: `[[forge.db#prs/12]]`.',
    ]) {
      expect(textFromContent(contentFromText(t))).toBe(t.replace('`[[forge.db#prs/12]]`', '[[forge.db#prs/12]]'))
    }
  })

  test('a citation is never split: a value with a bar, spaces or a slash stays one atom with its ref', () => {
    const content = contentFromText('Median [[4.2 days|card:ab12#median wait/all PRs]] per review.') as any[]
    const cites = content.filter((p) => p.type === 'cite')
    expect(cites).toEqual([{ type: 'cite', props: { value: '4.2 days', ref: 'card:ab12#median wait/all PRs' } }])
    expect(plainOf('Median [[4.2 days|card:ab12#median wait/all PRs]] per review.')).toBe(`Median ${CITE_CHAR} per review.`)
  })

  test('markers hug the words, and the space a writer leaves before punctuation after a citation is dropped', () => {
    expect(textFromContent([{ type: 'text', text: 'a ', styles: { bold: true } }, { type: 'text', text: 'b', styles: {} }] as any)).toBe('**a** b')
    expect(textFromContent([{ type: 'text', text: 'x', styles: { bold: true, italic: true, code: true } }] as any)).toBe('***`x`***')
    expect(textFromContent(undefined)).toBe('')
    const t = 'Twelve agents [[README.md#L3]] . Names are [[card:abcdef12]] , not accounts.'
    expect(textFromContent(contentFromText(t))).toBe('Twelve agents [[README.md#L3]]. Names are [[card:abcdef12]], not accounts.')
  })

  test('the readable text keeps a cited value and drops a bare citation with the space before it', () => {
    expect(readableText('There are [[345|card:ff73e071#prs/TOTAL]] of them [[README.md#L18]].')).toBe('There are 345 of them.')
    expect(readableText('  Two   spaces  ')).toBe('Two spaces')
    expect(readableOf(contentFromText('There are [[345|card:x]] PRs [[card:y]].'))).toBe('There are 345 PRs.')
  })
})

describe('blocks back to the document', () => {
  test('the editor blocks read back to the same document when nothing was touched', () => {
    const wire = blocksFromDoc(DOC)
    const blocks = editorBlocksFromWire(wire) as any[]
    expect(blocks[0].id).toBe(TITLE_ID)
    expect(blocks[0].props).toEqual({ level: 1 })
    expect(blocks[2]).toEqual({ id: 'f0', type: 'figure', props: { cell: 'card:abcdef13', caption: 'Lead' } })
    const back = wireFromEditor(blocks.map((b) => ({ ...b, children: [] })), origTexts(wire))
    expect(back).toEqual(wire)
    expect(sameWire(back, wire)).toBe(true)
  })

  test("an edited paragraph sends its new text, one left alone keeps the writer's spelling, empty blocks go and children flatten", () => {
    const wire = blocksFromDoc(doc({ title: 'T', sections: [{ id: 's', heading: 'H', paragraphs: [{ id: 'p', sentences: [sentence('x', 'Most are by __agent-04__.')] }, { id: 'q', sentences: [sentence('y', 'Old words.')] }], figures: [] }] }))
    const eb = editorBlocksFromWire(wire) as any[]
    eb[3].content = contentFromText('New words.')
    const back = wireFromEditor(
      [...eb, { id: 'e', type: 'paragraph', content: [] }, { id: 'n', type: 'paragraph', content: contentFromText('parent'), children: [{ id: 'k', type: 'numberedListItem', content: contentFromText('kid') }] }],
      origTexts(wire),
    )
    expect(back.blocks).toEqual([
      { id: 's', type: 'heading', text: 'H', level: 2 },
      { id: 'p', type: 'paragraph', text: 'Most are by __agent-04__.' },
      { id: 'q', type: 'paragraph', text: 'New words.' },
      { id: 'n', type: 'paragraph', text: 'parent' },
      { id: 'k', type: 'bullet', text: 'kid', marker: '1.' },
    ])
    expect(sameWire(back, wire)).toBe(false)
  })

  test('a prompt block is never saved, and names the unit above it as its place', () => {
    const wire = blocksFromDoc(DOC)
    const blocks = (editorBlocksFromWire(wire) as any[]).map((b) => ({ ...b, children: [] }))
    const at = blocks.findIndex((b) => b.type === 'paragraph')
    const prompt = { id: 'pr', type: PROMPT_TYPE, props: {}, children: [] }
    const withPrompt = [...blocks.slice(0, at + 1), prompt, ...blocks.slice(at + 1)]
    expect(wireFromEditor(withPrompt, origTexts(wire))).toEqual(wire)
    expect(anchorAbove(withPrompt, 'pr')).toBe(blocks[at].id)
    expect(anchorAbove([blocks[0], prompt, ...blocks.slice(1)], 'pr')).toBeNull()
    expect(anchorAbove(withPrompt, 'missing')).toBeNull()
  })
})

test('lockedBlocks names what the analyst locked: the title, a heading, a paragraph, every item of a locked list, a figure', () => {
  const locked = lockedBlocks(doc({
    title: 'T',
    title_locked: true,
    sections: [
      {
        id: 's1',
        heading: 'First',
        locked: true,
        paragraphs: [
          { id: 'p1', sentences: [sentence('a', 'Open.')] },
          { id: 'p2', locked: true, sentences: [sentence('b1', 'one', { bullet: '-' }), sentence('b2', 'two', { bullet: '-' })] },
        ],
        figures: [{ id: 'f1', cell: 'card:abcdef12', caption: 'c', after_paragraph: 'p1', locked: true }, { id: 'f2', cell: 'card:abcdef13', caption: 'd' }],
      },
      { id: 's2', heading: 'Second', paragraphs: [{ id: 'p3', sentences: [sentence('c', 'Not locked.')] }] },
    ],
  }))
  expect([...locked].sort()).toEqual([TITLE_ID, 'b1', 'b2', 'f1', 'p2', 's1'].sort())
  expect(lockedBlocks(doc({ title: 'T', sections: [] })).size).toBe(0)
})
