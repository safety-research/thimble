// The Report tab's History (src/report/historyModel.ts): a document's generations as rows, newest first, each with
// when it was written, who wrote it, its length and what changed. Invented data.
import { describe, expect, test } from 'vitest'
import type { DocHistory, DocVersion } from '../../src/lib/types.ts'
import { changesOf, currentRef, draftMeta, draftName, historyRows, previousOf, rowMeta, sameRef, whenLabel, whoWrote } from '../../src/report/historyModel.ts'

const version = (n: number, over: Partial<DocVersion> = {}): DocVersion => ({
  n,
  ts: '',
  source: n === 1 ? 'first' : 'terminal',
  instructions: null,
  summary: [],
  summary_from: null,
  run: null,
  current: false,
  available: true,
  words: null,
  writer: null,
  revisions: [],
  ...over,
})

// local times, so the labels read the same in any time zone
const at = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m).toISOString()
const now = new Date(2026, 8, 25, 21, 0)

describe('whenLabel', () => {
  test('a time today is its clock, another day adds the date, another year the year', () => {
    expect(whenLabel(at(25, 13, 52), now)).toBe('13:52')
    expect(whenLabel(at(24, 9, 5), now)).toBe('Sep 24, 09:05')
    expect(whenLabel(new Date(2025, 0, 3, 8, 0).toISOString(), now)).toBe('Jan 3 2025, 08:00')
  })
  test('no time or a bad one is empty', () => {
    expect(whenLabel('', now)).toBe('')
    expect(whenLabel(null, now)).toBe('')
    expect(whenLabel('not a time', now)).toBe('')
  })
})

describe('whoWrote', () => {
  test("a save inside a writer's session is the writer's, though the server stamps it terminal", () => {
    expect(whoWrote({ source: 'terminal', writer: 'f8d92c55' })).toBe('Writer')
    expect(whoWrote({ source: 'first', writer: 'f8d92c55' })).toBe('Writer')
  })
  test("the analyst's own save is yours, anything else Claude's", () => {
    expect(whoWrote({ source: 'analyst', writer: null })).toBe('You')
    expect(whoWrote({ source: 'terminal', writer: null })).toBe('Claude')
    expect(whoWrote({ source: '', writer: null })).toBe('Claude')
  })
})

describe('changesOf', () => {
  test('the summary lines, trimmed and without blanks; the first draft says so; a later one without a summary says nothing', () => {
    expect(changesOf({ n: 2, summary: [' 5 sections reworded. ', '', '2 sections kept as written.'] })).toEqual([
      '5 sections reworded.',
      '2 sections kept as written.',
    ])
    expect(changesOf({ n: 1, summary: [] })).toEqual(['First draft'])
    expect(changesOf({ n: 3, summary: [] })).toEqual([])
  })
})

describe('historyRows', () => {
  const h: DocHistory = {
    slug: 'report',
    generation: 3,
    versions: [
      version(1, { ts: at(25, 13, 47), words: 1148, writer: 'w1' }),
      version(3, { ts: at(25, 13, 52), words: 1247, writer: 'w1', current: true, summary: ['4 sections added.'], summary_from: 'diff' }),
      version(2, { ts: at(25, 13, 48), words: 1, instructions: '  shorter  ', summary: ['Cut the caveats.'], summary_from: 'writer' }),
      version(0, { available: false }),
    ].filter((v) => v.n > 0),
  }
  const rows = historyRows(h, now)

  test('newest first, each a numbered draft', () => {
    expect(rows.map((r) => r.label)).toEqual(['Draft 3', 'Draft 2', 'Draft 1'])
    expect(rows.map((r) => r.current)).toEqual([true, false, false])
  })
  test('each row says when, who and how long, and what changed', () => {
    expect(rowMeta(rows[0])).toBe('13:52 · Writer · 1,247 words')
    expect(rowMeta(rows[1])).toBe('13:48 · Claude · 1 word')
    expect(rows[1].asked).toBe('shorter')
    expect(rows[1].changes).toEqual(['Cut the caveats.'])
    expect(rows[2].changes).toEqual(['First draft'])
    expect(rows[0].writer).toBe('w1')
  })
  test('a draft whose text is gone is listed but does not open, and its unknowns are left out of its line', () => {
    const gone = historyRows({ slug: 'report', generation: 2, versions: [version(2, { current: true }), version(1, { available: false })] }, now)
    expect(gone[1].available).toBe(false)
    expect(rowMeta(gone[1])).toBe('Claude')
  })
  test('no history is no rows', () => {
    expect(historyRows(null, now)).toEqual([])
  })
})

describe('a writer run is one draft', () => {
  // generations 5 (current, its run saved twice before) and 2 (a legacy run of generations 1 and 2, folded)
  const h: DocHistory = {
    slug: 'report',
    generation: 5,
    versions: [
      version(5, {
        current: true,
        ts: at(25, 14, 10),
        words: 900,
        writer: 'w2',
        revisions: [
          { i: 1, ts: at(25, 14, 2), words: 700, available: true, generation: null },
          { i: 2, ts: at(25, 14, 6), words: 850, available: false, generation: null },
        ],
      }),
      version(4, { ts: at(25, 13, 0), source: 'analyst', words: 820 }),
      version(2, { ts: at(25, 12, 0), writer: 'w1', words: 800, revisions: [{ i: 1, ts: at(25, 11, 58), words: 400, available: true, generation: 1 }] }),
    ],
  }
  const rows = historyRows(h, now)

  test('drafts are numbered by their place, so a folded run of old generations reads as Draft 1', () => {
    expect(rows.map((r) => [r.n, r.label])).toEqual([
      [5, 'Draft 3'],
      [4, 'Draft 2'],
      [2, 'Draft 1'],
    ])
    expect(rows[2].changes).toEqual(['First draft'])
  })
  test("a run's earlier saves are the row's revisions, oldest first", () => {
    expect(rows[0].revisions.map((r) => [r.label, r.words, r.available])).toEqual([
      ['Save 1', '700 words', true],
      ['Save 2', '850 words', false],
    ])
    expect(draftName(rows, { n: 5, rev: 1 })).toBe('Draft 3 · Save 1')
    expect(draftMeta(rows, { n: 5, rev: 1 })).toBe('14:02 · Writer · 700 words')
    expect(draftName(rows, { n: 4, rev: null })).toBe('Draft 2')
  })
  test('previous is the draft before for a draft (the first draft its run\'s last save), the save before (skipping one not kept) for a save', () => {
    expect(previousOf(rows, { n: 5, rev: null })).toEqual({ n: 4, rev: null })
    expect(previousOf(rows, { n: 5, rev: 1 })).toEqual({ n: 4, rev: null })
    expect(previousOf(rows, { n: 5, rev: 2 })).toEqual({ n: 5, rev: 1 })
    expect(previousOf(rows, { n: 2, rev: 1 })).toBeNull()
    expect(previousOf(rows, { n: 2, rev: null })).toEqual({ n: 2, rev: 1 })
    expect(previousOf(rows, { n: 9, rev: null })).toBeNull()
  })
  test('the current ref and ref equality', () => {
    expect(currentRef(rows)).toEqual({ n: 5, rev: null })
    expect(currentRef([])).toBeNull()
    expect(sameRef({ n: 5, rev: null }, { n: 5, rev: null })).toBe(true)
    expect(sameRef({ n: 5, rev: 1 }, { n: 5, rev: null })).toBe(false)
    expect(sameRef(null, { n: 5, rev: null })).toBe(false)
  })
})
