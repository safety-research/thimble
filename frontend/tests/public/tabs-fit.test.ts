// Which file tabs the strip shows (src/files/viewsFit.ts fitTabs): every tab while they fit at their narrowest, else
// the first ones in order beside the menu's button, the open tab always among them, alone when nothing else fits.
import { expect, test } from 'vitest'
import { fitTabs } from '../../src/files/viewsFit.ts'

const widths = [113, 158, 203, 186, 190, 102]
const mins = (active: number) => widths.map((w, i) => (i === active ? w : Math.min(w, 132)))

test('every tab shows while all fit at their narrowest', () => {
  expect(fitTabs({ widths, mins: mins(4), room: 1188, more: 63, active: 4 })).toEqual([0, 1, 2, 3, 4, 5])
  expect(fitTabs({ widths, mins: mins(4), room: 113 + 132 * 3 + 190 + 102, more: 63, active: 4 })).toEqual([0, 1, 2, 3, 4, 5])
})

test('past that the first ones show beside the menu, the open tab in its own place', () => {
  expect(fitTabs({ widths, mins: mins(4), room: 700, more: 63, active: 4 })).toEqual([0, 1, 2, 4])
  expect(fitTabs({ widths, mins: mins(0), room: 700, more: 63, active: 0 })).toEqual([0, 1, 2, 3])
  expect(fitTabs({ widths, mins: mins(5), room: 700, more: 63, active: 5 })).toEqual([0, 1, 2, 3, 5])
})

test('a strip too narrow for the open tab beside the menu still shows the open tab', () => {
  expect(fitTabs({ widths, mins: mins(2), room: 150, more: 63, active: 2 })).toEqual([2])
  expect(fitTabs({ widths, mins: mins(-1), room: 150, more: 63, active: -1 })).toEqual([])
})
