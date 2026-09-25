// Where a file ref opens among the views (src/files/viewChoice.ts): a view's forms decide which fragments it may take, a
// view whose reader answers nothing for the place is passed over, so a ref never opens a view that shows nothing, and a
// quoted passage opens at the record it sits in when no view knows the passage itself.
import { describe, expect, test } from 'vitest'
import { accepts, chooseView, viewPlace } from '../../src/files/viewChoice.ts'

// a transcript view that takes a line and any conversation id, and a board view that takes lines alone
const convs = { slug: 'conversations', accepts: [{ form: 'L<n>', means: 'the file' }, { form: '<conv>', means: 'one conversation' }] }
const board = { slug: 'board', accepts: [{ form: 'L<n>', means: 'one post' }] }

describe('viewPlace', () => {
  test('a form with a free placeholder accepts a span, so the reader is asked before the view opens', async () => {
    const span = 'L1.b0:c120-164'
    expect(accepts(convs, span)).toBe(true)
    expect(chooseView({ views: [convs], fragment: span })).toBe('v:conversations')
    const asked: string[] = []
    const knows = async (s: string, r: string) => (asked.push(r), r.endsWith('#L1'))
    expect(await viewPlace([convs], 'run1/a.json', span, knows)).toEqual({ slug: 'conversations', ref: 'run1/a.json#L1' })
    expect(asked).toEqual(['run1/a.json#L1.b0:c120-164', 'run1/a.json#L1'])
  })

  test('the record of a span goes to the first view in order that knows it, whichever view accepted the span', async () => {
    const reader = { slug: 'reader', accepts: [{ form: 'L<n>', means: 'the file' }] }
    const knows = async (_: string, r: string) => r.endsWith('#L1')
    expect(await viewPlace([reader, convs, board], 'a.json', 'L1.b0:c178010-178064', knows)).toEqual({ slug: 'reader', ref: 'a.json#L1' })
  })

  test('a span in a view that accepts only lines opens at its record, the post it quotes', async () => {
    expect(accepts(board, 'L7.b0:c3-9')).toBe(false)
    expect(await viewPlace([board], 'board.jsonl', 'L7.b0:c3-9', async () => true)).toEqual({ slug: 'board', ref: 'board.jsonl#L7' })
  })

  test('the first view that accepts the fragment and knows the place opens it', async () => {
    const knows = async (s: string) => s === 'board'
    expect(await viewPlace([convs, board], 'b.jsonl', 'L4', knows)).toEqual({ slug: 'board', ref: 'b.jsonl#L4' })
    expect(await viewPlace([convs, board], 'b.jsonl', 'c4', async () => true)).toEqual({ slug: 'conversations', ref: 'b.jsonl#c4' })
  })

  test('no view that knows the place leaves the ref to the File browser, and a view that does not accept it is never asked', async () => {
    const asked: string[] = []
    expect(await viewPlace([board], 'b.jsonl', 'c4', async (s) => (asked.push(s), true))).toBeNull()
    expect(asked).toEqual([])
    expect(await viewPlace([convs, board], 'b.jsonl', 'L2.b1', async () => false)).toBeNull()
  })
})
