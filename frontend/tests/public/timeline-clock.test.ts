// A timeline of clock times with no date (bug hunt B22, thimble.timeline keeps "22:14:07" as given): the canvas shows
// each time as written, in time order across midnight, spaced by time, the day named where it changes
// (src/canvas/DataViz.tsx timelineRows).
import { expect, test } from 'vitest'
import { timelineRows } from '../../src/canvas/DataViz.tsx'

test('clock times read as times of day, rolling over midnight in the order given', () => {
  const rows = timelineRows([
    { time: '22:14:07', label: 'clicks' },
    { time: '22:15:30', label: 'a new thread' },
    { time: '23:58:00', label: 'late' },
    { time: '00:02:10', label: 'past midnight' },
  ])
  expect(rows.map((r) => r.time)).toEqual(['day 1 22:14:07', '22:15:30', '23:58:00', 'day 2 00:02:10'])
  expect(rows.map((r) => r.label)).toEqual(['clicks', 'a new thread', 'late', 'past midnight'])
  // spaced by time: the hour and 42 minutes before 23:58 is a break, the four minutes over midnight are not
  expect(rows.map((r) => r.brk)).toEqual(['', '', '2 h', ''])
  expect(rows.some((r) => /Jan|2000/.test(r.time))).toBe(false)
})
