// The report editor's model (src/report/model.ts). A stored document becomes editor blocks and back: a block the
// analyst did not touch saves the writer's own text unchanged, and a citation is one atom that is never split.
import { describe, expect, test } from 'vitest'
import {
  blocksFromDoc,
  CITE_CHAR,
  contentFromText,
  editorBlocksFromWire,
  origTexts,
  passageOrder,
  plainOf,
  sameWire,
  TITLE_ID,
  wireFromEditor,
} from '../../src/report/model.ts'
import type { Writeup } from '../../src/lib/types.ts'
import { openComments } from '../../src/report/checkComments.ts'

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

describe('inline text', () => {
  test('a citation is never split: a value with a bar, spaces or a slash stays one atom with its ref', () => {
    const content = contentFromText('Median [[4.2 days|card:ab12#median wait/all PRs]] per review.') as any[]
    const cites = content.filter((p) => p.type === 'cite')
    expect(cites).toEqual([{ type: 'cite', props: { value: '4.2 days', ref: 'card:ab12#median wait/all PRs' } }])
    expect(plainOf('Median [[4.2 days|card:ab12#median wait/all PRs]] per review.')).toBe(`Median ${CITE_CHAR} per review.`)
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
})

describe('comments on the title', () => {
  // the report checks read the title as a passage (report:<slug>#title), so a check's comment on it comes first
  test('a comment on the title comes before the sections\' comments', () => {
    const view = DOC as unknown as Writeup
    expect(passageOrder(view)[0]).toBe(TITLE_ID)
    const comments = [
      { id: 'c2', sentence_id: 'a1', text: 'On a sentence.', check: 'unverified', status: 'open' },
      { id: 'c1', sentence_id: TITLE_ID, text: 'No card shows seven weeks.', check: 'unverified', status: 'open' },
    ] as unknown as Writeup['comments']
    const open = openComments(comments, [], passageOrder(view))
    expect(open.map((c) => [c.id, c.sid])).toEqual([['c1', TITLE_ID], ['c2', 'a1']])
  })
})
