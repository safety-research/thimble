// A timeline of clock times with no date (bug hunt B22): each event shows its time as the code gave it, on an axis
// spaced by time, a change of day named; a card an older thimble.timeline stored on 2000-01-01 shows its times without
// that made-up date (hooks/term/draw.ts clockTimes). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import { CELLS } from './fixtures'

const TIMELINE = 'application/vnd.thimble.timeline+json'

function drawn(times: string[]): string[] {
  const events = times.map((time, i) => ({ time, label: `event ${i + 1}` }))
  const cell = { ...(CELLS.e0time00 as object), outputs: [{ [TIMELINE]: { events } }] } as unknown as ThimbleCell
  return cardLayout(cardOfCell(cell).card, 60, -1).lines.map(l => l.map(s => s.s).join(''))
}

test('clock times show as written, on an axis, with the day named where it changes', () => {
  const lines = drawn(['22:14:07', '22:15:30', '23:58:00', '00:02:10'])
  // the axis spaces them by time: the two minutes past midnight land near the end, not after a day's gap
  expect(lines[0]).toMatch(/^●●─{40,}●─●$/)
  const rows = lines.filter(l => l.includes('event'))
  expect(rows.map(r => r.split('●')[0]!.trim())).toEqual(['day 1 22:14:07', '22:15:30', '23:58:00', 'day 2 00:02:10'])
  expect(lines.join('\n')).not.toContain('Jan')
})

test("an older card's clock times on 2000-01-01 show without the date", () => {
  const rows = drawn(['2000-01-01T22:14:07', '2000-01-01T22:15:30']).filter(l => l.includes('event'))
  expect(rows.map(r => r.split('●')[0]!.trim())).toEqual(['22:14:07', '22:15:30'])
})
