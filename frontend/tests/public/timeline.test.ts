// A timeline card's rows (src/canvas/DataViz.tsx): spaced by the time between events, a wait far longer than the rest
// drawn as a break that names it, or one to a row at an equal distance when thimble.timeline's data says
// `spacing: even`. The events are invented.
import { describe, expect, test } from 'vitest'
import { asTimeline, timelineBreaks, timelineRows, waitText } from '../../src/canvas/DataViz.tsx'

const events = [
  { time: '2000-01-01T09:00:00', label: 'run starts' },
  { time: '2000-01-01T09:02:00', label: 'first save' },
  { time: '2000-01-01T14:30:00', label: 'last save' },
]

describe('timelineRows', () => {
  test('by time a long wait takes a long gap, and evenly every gap is the least one', () => {
    const byTime = timelineRows(events).map((r) => r.gap)
    expect(byTime[2]).toBeGreaterThan(byTime[1])
    const even = timelineRows(events, true).map((r) => r.gap)
    expect(even[1]).toBe(even[2])
    expect(even[2]).toBeLessThan(byTime[2])
  })

  test('the data carries the spacing the code asked for', () => {
    expect(asTimeline({ events, spacing: 'even' })?.spacing).toBe('even')
    expect(asTimeline({ events })?.spacing).toBeUndefined()
  })

  test('a wait far longer than the rest is a break that names it, and the other gaps keep their proportion', () => {
    const day = [
      { time: '2000-01-01T09:00:00', label: 'doors open' },
      { time: '2000-01-01T09:02:00', label: 'first visitor' },
      { time: '2000-01-01T09:06:00', label: 'second visitor' },
      { time: '2000-01-01T09:07:00', label: 'third visitor' },
      { time: '2000-01-01T13:30:00', label: 'delivery' },
      { time: '2000-01-01T13:34:00', label: 'doors close' },
    ]
    const rows = timelineRows(day)
    expect(rows.map((r) => r.brk)).toEqual(['', '', '', '', '4 h', ''])
    expect(rows[4].gap).toBeLessThanOrEqual(2)
    expect(rows[2].gap).toBeGreaterThan(rows[3].gap)
    expect(Math.max(...rows.map((r) => r.gap))).toBeLessThanOrEqual(28)
    expect(timelineRows(day, true).every((r) => r.brk === '')).toBe(true)
  })

  test('a long wait between dates reads in days, and a steady run of waits has no break', () => {
    const season = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-05', '2026-04-20'].map((time, i) => ({ time, label: `step ${i}` }))
    expect(timelineRows(season).map((r) => r.brk)).toEqual(['', '', '', '', '46 days'])
    const steady = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'].map((time, i) => ({ time, label: `step ${i}` }))
    expect(timelineRows(steady).every((r) => r.brk === '')).toBe(true)
  })

  test('breaks need a run of waits to be long beside, and read in the unit of the wait', () => {
    expect(timelineBreaks([0, 1, 1000])).toEqual(new Set())
    expect(timelineBreaks([0, 1, 2, 3, 1000])).toEqual(new Set([4]))
    expect(waitText(45 * 60_000, 'temporal')).toBe('45 min')
    expect(waitText(26 * 3_600_000, 'temporal')).toBe('26 h')
    expect(waitText(400 * 86_400_000, 'temporal')).toBe('13 months')
    expect(waitText(1200, 'quantitative')).toBe('+1,200')
  })
})
