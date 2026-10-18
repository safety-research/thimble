// After "Run again on these 326" (the records Claude's safeguards refused), the Labels pane counts the label as its card,
// the terminal and `thimble state` do: the values of the run that the Run again took into it, never the Run again's own
// 326 (bug hunt round 10, K9: "1 of 326 records · 318 failed" for good, beside "249 of 1,746" everywhere else). The
// server keeps the ended Run again as the label's run record, its `summary` the merged run with `again`, and the kept
// run its own `ts` with the Run again's under `again` (backend concepts._record_application merge).
import { expect, test } from 'vitest'
import { failedText, labelStatus, outcomeText } from '../../src/files/labels.ts'
import type { Concept, ConceptRun } from '../../src/lib/types.ts'

const AT = '2026-10-18T02:48:39+00:00'
const AGAIN_AT = '2026-10-18T02:49:56+00:00'
const merged = {
  ts: AT, paths: ['brews.jsonl'], total: 2064, matched_total: 2064, labeled: 1746, failed: 318, matches: 249, status: 'done',
  refused: 318, again: { ts: AGAIN_AT, total: 326, labeled: 8, failed: 318, created_by: 'user' },
}
const label = (lastRun: unknown, run: ConceptRun | null): Concept =>
  ({ id: 'k9', name: 'steeped', unit: 'record', kind: 'prompt', labels: ['steeped', 'ok'], counts: { steeped: 249, ok: 1497 }, last_run: lastRun, run }) as unknown as Concept
// the Run again's own record as it ended: its 326 records, 1 of them given the first value
const again = (summary: unknown): ConceptRun => ({ run_id: 'r2', status: 'done', started: AGAIN_AT, total: 326, done: 326, labeled: 8, failed: 318, matches: 1, ...(summary ? { summary } : {}) })

test('after a Run again, the Labels pane counts the label, not the Run again on its 326 records', () => {
  // the list read again, or the page reloaded: the run record the server keeps is the Run again's
  for (const s of [labelStatus(label(merged, again(merged))), labelStatus(label(merged, null), again(null))]) {
    expect(s?.state).toBe('done')
    if (s?.state !== 'done') return
    expect(outcomeText(s)).toBe('249 of 1,746 records')
    expect(failedText(s)).toBe('318 failed')
    expect(s.ts).toBe(AGAIN_AT)
  }
  // the moment the Run again ends, before the list is read again: the kept run as it was, never the 326
  const before = { ...merged, labeled: 1738, failed: 326, matches: 248, again: undefined }
  const s = labelStatus({ ...label(before, null), counts: { steeped: 248, ok: 1490 } } as Concept, again(merged))
  expect(s?.state === 'done' && outcomeText(s)).toBe('248 of 1,738 records')
})

test('a new run that ended after the kept one still stands in for it until the list is read again', () => {
  const later = { run_id: 'r3', status: 'done', started: '2026-10-18T03:00:00+00:00', total: 2064, done: 2064, labeled: 2064, failed: 0, matches: 300 }
  const s = labelStatus(label(merged, null), later)
  expect(s?.state === 'done' && outcomeText(s)).toBe('300 of 2,064 records')
})
