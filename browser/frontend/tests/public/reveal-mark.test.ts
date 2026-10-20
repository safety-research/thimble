// @vitest-environment jsdom
// A found item's jump (src/lib/marks.ts keepInView): a place that lays out after the jump (a tab that just opened
// draws its figures) moves the words down; they are brought back to the middle and flashed once they stay put.
import { expect, test } from 'vitest'
import { keepInView } from '../../src/lib/marks.ts'

test('a mark that the layout moves after the jump is brought into view again, then flashed', async () => {
  const el = document.createElement('span')
  document.body.append(el)
  let top = 400
  const scrolls: number[] = []
  el.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 80, width: 80, height: 20, x: 0, y: top, toJSON: () => ({}) })
  el.scrollIntoView = () => void scrolls.push(top)
  keepInView(el)
  expect(scrolls).toEqual([400])
  await new Promise((r) => setTimeout(r, 100))
  // the figures above it draw: it moves down 130 px, below the window
  top = 530
  await new Promise((r) => setTimeout(r, 600))
  expect(scrolls).toEqual([400, 530])
  expect(el.classList.contains('mark-flash')).toBe(true)
})
