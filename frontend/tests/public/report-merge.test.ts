// A stored version of the report that arrives while the editor holds unsaved edits (src/report/merge.ts), and the
// caret kept in its block while the editor's blocks are rebuilt from it (src/report/caret.ts). The analyst's changed
// and new blocks stay theirs; every block they did not touch takes the stored version, so the save that follows keeps a
// writer's or a thread's change and who made it; a block they deleted stays deleted unless it was changed meanwhile.
// A lock the analyst clicked shows before the server has it.
import { Schema } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import { describe, expect, test } from 'vitest'
import { caretBack, caretInBlock } from '../../src/report/caret.ts'
import { locksShown, mergeUnsaved } from '../../src/report/merge.ts'
import type { DocBlocks } from '../../src/report/model.ts'

const para = (id: string, text: string) => ({ id, type: 'paragraph' as const, text })
const heading = (id: string, text: string) => ({ id, type: 'heading' as const, text, level: 2 })

const BASE: DocBlocks = {
  title: 'Review load decided which pull requests merged',
  blocks: [heading('h1', 'The data'), para('p1', 'Twelve agents reviewed 40 pull requests.'), para('p2', 'Most reviews came in the first hour.'), para('p3', 'Three agents did half of them.')],
}

describe('a stored version merged into unsaved edits', () => {
  test("the analyst's changed block stays theirs, a block they did not touch takes the stored text", () => {
    const mine = { ...BASE, blocks: BASE.blocks.map((b) => (b.id === 'p1' ? para('p1', 'Twelve agents reviewed 40 pull requests in May.') : b)) }
    const stored = { ...BASE, blocks: BASE.blocks.map((b) => (b.id === 'p2' ? para('p2', 'Most reviews came early.') : b)) }
    const out = mergeUnsaved(stored, BASE, mine)
    expect(out.blocks.map((b) => b.text)).toEqual(['The data', 'Twelve agents reviewed 40 pull requests in May.', 'Most reviews came early.', 'Three agents did half of them.'])
    expect(out.title).toBe(BASE.title)
  })

  test("the stored version's new and removed blocks stand; the analyst's new block goes after the block it follows", () => {
    const mine = { ...BASE, blocks: [...BASE.blocks.slice(0, 2), para('n1', 'Add how long the reviews took.'), ...BASE.blocks.slice(2)] }
    const stored = { title: 'A shorter title', blocks: [BASE.blocks[0], BASE.blocks[1], para('w1', 'A paragraph the writer added.'), BASE.blocks[3]] }
    const out = mergeUnsaved(stored, BASE, mine)
    expect(out.blocks.map((b) => b.id)).toEqual(['h1', 'p1', 'n1', 'w1', 'p3'])
    expect(out.title).toBe('A shorter title')
  })

  test('a block the analyst deleted stays deleted unless the stored version changed it; their title wins when they changed it', () => {
    const mine = { title: 'My title', blocks: BASE.blocks.filter((b) => b.id !== 'p2' && b.id !== 'p3') }
    const stored = { ...BASE, blocks: BASE.blocks.map((b) => (b.id === 'p3' ? para('p3', 'Three agents did most of them.') : b)) }
    const out = mergeUnsaved(stored, BASE, mine)
    expect(out.blocks.map((b) => b.id)).toEqual(['h1', 'p1', 'p3'])
    expect(out.blocks[2].text).toBe('Three agents did most of them.')
    expect(out.title).toBe('My title')
  })

  test('a block the analyst changed where the stored version removed it comes back after the block it followed', () => {
    const mine = { ...BASE, blocks: BASE.blocks.map((b) => (b.id === 'p2' ? para('p2', 'Most reviews came in the first ten minutes.') : b)) }
    const stored = { ...BASE, blocks: BASE.blocks.filter((b) => b.id !== 'p2') }
    expect(mergeUnsaved(stored, BASE, mine).blocks.map((b) => b.id)).toEqual(['h1', 'p1', 'p2', 'p3'])
  })
})

describe('the caret while the blocks are rebuilt', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      para: { group: 'block', content: 'text*', attrs: { id: { default: null } } },
      text: {},
    },
  })
  const p = (id: string, text: string) => schema.node('para', { id }, text ? [schema.text(text)] : [])

  test('the caret goes back into its block as far as it was, clamped to a shorter block, and nowhere once the block is gone', () => {
    const before = schema.node('doc', null, [p('p1', 'One two three.'), p('p2', 'Four five six.')])
    const sel = TextSelection.create(before, 1 + 14 + 2 + 4) // "Four" typed up to its end in p2
    const caret = caretInBlock(sel)
    expect(caret).toEqual({ id: 'p2', offset: 5 })
    // p1 rewritten longer by a writer: the caret keeps its place in p2
    const after = schema.node('doc', null, [p('p1', 'One two three, and four.'), p('p2', 'Four five six.')])
    const back = caretBack(after, caret!)!
    expect(back.$from.parent.attrs.id).toBe('p2')
    expect(back.$from.parentOffset).toBe(4)
    // p2 shortened: the caret goes to its end
    const shorter = schema.node('doc', null, [p('p1', 'One.'), p('p2', 'Fo')])
    const clamped = caretBack(shorter, caret!)!
    expect(clamped.$from.parent.attrs.id).toBe('p2')
    expect(clamped.$from.parentOffset).toBe(2)
    expect(caretBack(schema.node('doc', null, [p('p1', 'One.')]), caret!)).toBeNull()
  })
})

describe('the locks shown', () => {
  test("the stored locks, with each click the server has not answered shown as clicked", () => {
    const stored = new Set(['p1', 'p2'])
    expect([...locksShown(stored, new Map())].sort()).toEqual(['p1', 'p2'])
    expect([...locksShown(stored, new Map([['p3', true], ['p1', false]]))].sort()).toEqual(['p2', 'p3'])
    expect([...stored].sort()).toEqual(['p1', 'p2'])
  })
})
