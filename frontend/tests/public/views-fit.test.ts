// Which of Files' views fit in the top bar (src/files/viewsFit.ts fitViews): all of them while they and New view fit;
// else the first ones that fit beside ⋯ and New view, the picked one always among them in its own place; and in a bar
// too narrow for the picked one beside ⋯ and New view, none, every option then in the ⋯ menu.
import { expect, test } from 'vitest'
import { fitViews } from '../../src/files/viewsFit.ts'

const base = { widths: [100, 120, 140, 90], gap: 4, tail: 28, more: 28 }

test('every option shows while they and New view fit, without the ⋯', () => {
  // 100 + 120 + 140 + 90 + 28 and four gaps
  expect(fitViews({ ...base, room: 494, active: 0 })).toEqual([0, 1, 2, 3])
})

test('the first options that fit beside ⋯ and New view show, the rest go in the menu', () => {
  // 100 + 120 + 28 + 28 and three gaps = 288
  expect(fitViews({ ...base, room: 300, active: 0 })).toEqual([0, 1])
  expect(fitViews({ ...base, room: 287, active: 0 })).toEqual([0])
  expect(fitViews({ ...base, room: 287, active: 1 }), "the picked one in the first one's place").toEqual([1])
})

test('the picked option shows in its own place, taking the room of the last ones that fit', () => {
  expect(fitViews({ ...base, room: 300, active: 3 })).toEqual([0, 3])
  // the picked option wider than what it replaces pushes out one more
  expect(fitViews({ ...base, room: 300, active: 2 })).toEqual([2])
})

test('a bar too narrow for the picked option beside ⋯ and New view shows no option', () => {
  expect(fitViews({ ...base, room: 150, active: 2 })).toEqual([])
  expect(fitViews({ ...base, room: 40, active: 0 })).toEqual([])
})

test('no option picked (a proposal is not a choice): only the first ones that fit', () => {
  expect(fitViews({ ...base, room: 300, active: -1 })).toEqual([0, 1])
})
