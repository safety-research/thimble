import { describe, expect, it } from 'vitest'
import { docSave } from '../../src/chat/chips'

describe('docSave', () => {
  it('first generation is wrote, later ones revised', () => {
    expect(docSave('artifact', 'report:report', 'wrote', 1)).toEqual({ verb: 'wrote', generation: 1 })
    expect(docSave('artifact', 'report:report', 'revised', 3)).toEqual({ verb: 'revised', generation: 3 })
  })
  it('reads an older chip text', () => {
    expect(docSave('artifact', 'report:report', 'the report, generation 1')).toEqual({ verb: 'wrote', generation: 1 })
    expect(docSave('artifact', 'report:report', 'the report, generation 2')).toEqual({ verb: 'revised', generation: 2 })
  })
  it('an edit in place is revised', () => {
    expect(docSave('artifact', 'report:report#s3', 'edited a passage')).toEqual({ verb: 'revised' })
  })
  it('null off a document', () => {
    expect(docSave('artifact', 'group:g1', 'cards')).toBeNull()
    expect(docSave('view', 'report:report', 'x')).toBeNull()
  })
})
