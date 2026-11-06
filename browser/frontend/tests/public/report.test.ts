// The report editor's model (src/report/model.ts). A stored document becomes editor blocks and back: a block the
// analyst did not touch saves the writer's own text unchanged, and a citation is one atom that is never split.
import { expect, test } from 'vitest'
import { blocksFromDoc, contentFromText, editorBlocksFromWire, origTexts, sameWire, wireFromEditor, type EditorBlockLike } from '../../src/report/model.ts'
import type { Writeup } from '../../src/lib/types.ts'

const sentence = (id: string, text: string, extra: object = {}) => ({ id, text, refs: [], tags: [], ...extra })
const DOC = {
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
} as unknown as Pick<Writeup, 'title' | 'sections' | 'title_locked'>

test('a document read into the editor and back is the same document, each citation one atom', () => {
  const wire = blocksFromDoc(DOC)
  const blocks = editorBlocksFromWire(wire) as EditorBlockLike[]
  const back = wireFromEditor(blocks.map((b) => ({ ...b, children: [] })), origTexts(wire))
  expect(back).toEqual(wire)
  expect(sameWire(back, wire)).toBe(true)
  // a value with a bar, spaces or a slash stays one atom with its ref
  const cites = (contentFromText('Median [[4.2 days|card:ab12#median wait/all PRs]] per review.') as { type: string; props?: unknown }[]).filter((p) => p.type === 'cite')
  expect(cites).toEqual([{ type: 'cite', props: { value: '4.2 days', ref: 'card:ab12#median wait/all PRs' } }])
})
