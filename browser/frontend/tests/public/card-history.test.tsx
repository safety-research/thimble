// The card's history as the side panel lists it (src/canvas/details.ts historyRows, fieldWords): each edit newest first,
// who made it and the fields it changed in the panel's words, then the card's making; an edit opens the card as it was
// before it only while its record and every later edit's were kept (backend notebook.version_of).
import { describe, expect, test } from 'vitest'
import { fieldWords, historyRows } from '../../src/canvas/details.ts'

const by = (who: string | null | undefined) => (!who || who === 'user' ? 'you' : who)

describe("a card's history rows", () => {
  test('newest first, each with who and what it changed, then the making; an edit before a gap in the records opens nothing', () => {
    const rows = historyRows(
      {
        kind: 'note',
        created_by: 'main',
        created_ts: '2026-10-09T08:00:00Z',
        ts: '2026-10-09T08:00:00Z',
        edited: [
          { by: 'main', ts: '2026-10-09T08:10:00Z', id: 'aaaaaaaa', fields: ['payload'] },
          { by: 'user', ts: '2026-10-09T09:00:00Z', fields: ['title'] },
          { by: 'main', ts: '2026-10-09T10:00:00Z', id: 'bbbbbbbb', fields: ['payload', 'takeaway'] },
        ],
      },
      by,
    )
    expect(rows).toEqual([
      { ts: '2026-10-09T10:00:00Z', what: 'edited by main', fields: 'text, takeaway', entry: 'bbbbbbbb' },
      { ts: '2026-10-09T09:00:00Z', what: 'edited by you', fields: 'question', entry: null },
      // its record was kept, but the edit after it was made before thimble kept them
      { ts: '2026-10-09T08:10:00Z', what: 'edited by main', fields: 'text', entry: null },
      { ts: '2026-10-09T08:00:00Z', what: 'created by main', fields: '', entry: null },
    ])
  })

  test("a payload's words follow the card's kind", () => {
    expect(fieldWords('plan', ['payload'])).toBe('steps')
    expect(fieldWords('code', ['title', 'code', 'takeaway'])).toBe('question, code, takeaway')
    expect(fieldWords('custom', ['payload'])).toBe('content')
    expect(fieldWords('note', undefined)).toBe('')
  })
})
