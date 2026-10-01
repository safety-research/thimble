import { describe, expect, it } from 'vitest'
import { barList } from '../../src/files/ViewsBar'
import type { Proposal, View } from '../../src/lib/types'

const view = (slug: string, extra: Partial<View> = {}): View => ({
  slug, origin: 'workspace', name: slug, description: '', claims: ['board.jsonl'], accepts: [], units: [], libs: [],
  built: 't', ok: true, forms: [], first_file: 'board.jsonl', ...extra,
})
const built = (slug: string): Proposal => ({
  slug, name: slug, why: '', claims: ['board.jsonl'], arrangement: '', proposed_by: 'analyst', status: 'built', ts: 't',
})

describe('barList', () => {
  it('lists corpus views and leaves file viewers, which open in the File browser, out with their proposals', () => {
    const list = [view('timeline', { unit: { name: 'day', field: 'time' } }), view('pages', { unit: 'file', file_type: true })]
    const got = barList(list, [built('timeline'), built('pages')])
    expect(got.views.map((v) => v.slug)).toEqual(['timeline'])
    expect(got.proposals).toEqual([])
  })

  it('leaves out a view switched off in Settings', () => {
    const got = barList([view('board')], [{ ...built('timeline'), off: true }, built('board')])
    expect(got.views.map((v) => v.slug)).toEqual(['board'])
    expect(got.proposals).toEqual([])
  })
})
