// What a label's row in the Labels pane counts (src/files/labels.ts labelStatus): the units that matched, as the label's
// card states them (canvas/details labelShares), so the pane and the card never give two counts for one label.
import { describe, expect, test } from 'vitest'
import { labelShares } from '../../src/canvas/details.ts'
import { labelStatus, outcomeText } from '../../src/files/labels.ts'
import type { ConceptApplication, ConceptRun } from '../../src/lib/types.ts'

const TOTAL = 50_000
const kept = (matches: number): ConceptApplication => ({
  ts: '2026-03-02T10:00:00+00:00', paths: ['logs/*.jsonl'], total: TOTAL, matched_total: TOTAL, labeled: TOTAL, failed: 0,
  status: 'done', matches,
})

describe('a label row after its run', () => {
  test('a label with several values counts a unit of any value that is not its negative, as its card does', () => {
    const labels = ['opened a port', 'read a secret', 'changed a config', 'none']
    const counts = { 'opened a port': 40, 'read a secret': 310, 'changed a config': 1_250, none: 48_400 }
    // the run record counts only the units of the first value (40), which is not what matched
    const done: ConceptRun = { status: 'done', started: '2026-03-02T10:00:00+00:00', total: TOTAL, matches: 40 }
    const s = labelStatus({ unit: 'record', labels, counts, last_run: kept(40), run: done })
    expect(s?.state).toBe('done')
    if (s?.state !== 'done') return
    expect(s.matches).toBe(1_600)
    expect(s.matches).toBe(labelShares(labels, counts, TOTAL).matched)
    expect(outcomeText(s)).toBe(`1,600 of ${TOTAL.toLocaleString()} records`)
  })

  test('a yes-or-no label counts its first value, and one whose counts are not known yet says the run\'s count', () => {
    const yes = labelStatus({ unit: 'record', labels: ['flagged', 'clean'], counts: { flagged: 12, clean: 49_988 }, last_run: kept(12) })
    expect(yes?.state === 'done' && yes.matches).toBe(12)
    const unknown = labelStatus({ unit: 'record', labels: ['flagged', 'clean'], counts: undefined, last_run: kept(12) })
    expect(unknown?.state === 'done' && unknown.matches).toBe(12)
  })
})
