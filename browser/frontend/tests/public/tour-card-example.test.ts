// @vitest-environment jsdom
// The tour's example card (src/tour/examples.json pops, popsPlain): the source each of its values shows on a hover is
// headed by the chip thimble's own hover draws for that value in its card (components/RefChip chipLabel), which names
// the printed output the value is a line of.
import { expect, test } from 'vitest'
import { chipLabel } from '../../src/components/RefChip.tsx'
import snaps from '../../src/tour/examples.json'

test("each value's captured source is headed as thimble's own hover heads it", () => {
  for (const table of [snaps.pops, snaps.popsPlain] as Record<string, string>[]) {
    expect(Object.keys(table).length).toBeGreaterThan(0)
    for (const [ref, html] of Object.entries(table)) {
      const d = document.createElement('div')
      d.innerHTML = html
      // the values sit in their card, so their chips leave out its name
      const head = d.querySelector('.refchip-pop-head .chip-text')?.textContent
      expect(head, ref).toBe(chipLabel(ref, 'e2d6a7ec'))
      expect(head, ref).toMatch(/^printed output · line \d+$/)
    }
  }
})
