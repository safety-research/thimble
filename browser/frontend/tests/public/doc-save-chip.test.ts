// The quiet line of a document save in the chat (src/chat/chips.ts docSave): the verb the chip says, so the first
// writer's save over the analyst's own notes, which is generation 2 (Draft 1 is the analyst's), still reads "wrote".
import { describe, expect, test } from 'vitest'
import { docSave } from '../../src/chat/chips'

describe('a document save in the chat', () => {
  test("the first writer's save over the analyst's notes is generation 2 and reads wrote", () => {
    expect(docSave('artifact', 'report:report', 'wrote', 2)).toEqual({ verb: 'wrote', generation: 2 })
  })
  test('a later save reads revised, and so does an in-place edit with no generation', () => {
    expect(docSave('artifact', 'report:report', 'revised', 3)).toEqual({ verb: 'revised', generation: 3 })
    expect(docSave('artifact', 'report:report#s1', 'revised')).toEqual({ verb: 'revised' })
  })
  test('an older chip that names its generation in its text reads by the number', () => {
    expect(docSave('artifact', 'report:report', 'the report, generation 1')).toEqual({ verb: 'wrote', generation: 1 })
    expect(docSave('artifact', 'report:report', 'the report, generation 2')).toEqual({ verb: 'revised', generation: 2 })
  })
  test('a chip on something else is no document save', () => {
    expect(docSave('artifact', 'group:g1', 'wrote', 1)).toBeNull()
    expect(docSave('note', 'report:report', 'wrote', 1)).toBeNull()
  })
})
