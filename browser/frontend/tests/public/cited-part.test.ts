// @vitest-environment jsdom
// A click on a citation of a part a card's program draws (`card:<id>#merged`) marks that part, as a cited cell is.
import { expect, test } from 'vitest'
import { partOf, revealPart } from '../../src/lib/tableCell.ts'

test('a click on a citation of a part a card draws marks the part', () => {
  expect(partOf('card:abc123#merged')).toBe('merged')
  expect(partOf('card:abc123')).toBeNull()
  const card = document.createElement('div')
  card.innerHTML = '<svg><g class="dk-hits"><rect data-region="open"/><rect data-region="merged"/></g></svg>'
  const box = revealPart(card, 'merged')
  expect(box?.getAttribute('data-region')).toBe('merged')
  expect(box?.classList.contains('cite-cell-flash')).toBe(true)
  expect(card.querySelector('[data-region="open"]')?.classList.contains('cite-cell-flash')).toBe(false)
  expect(revealPart(card, 'closed')).toBeNull()
})
