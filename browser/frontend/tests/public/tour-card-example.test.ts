// @vitest-environment jsdom
// The tour's example card (src/tour/examples.json pops, popsPlain): the source each of its values shows on a hover is
// headed by the cited line's number alone, as the real chip names it.
import { expect, test } from 'vitest'
import snaps from '../../src/tour/examples.json'

test("each value's source is headed by its line's number", () => {
  for (const table of [snaps.pops, snaps.popsPlain] as Record<string, string>[]) {
    expect(Object.keys(table).length).toBeGreaterThan(0)
    for (const [ref, markup] of Object.entries(table)) {
      const d = document.createElement('div')
      d.innerHTML = markup
      const line = /@out\d+#L(\d+)$/.exec(ref)![1]
      expect(d.querySelector('.refchip-pop-head .chip-text')?.textContent, ref).toBe(`line ${line}`)
    }
  }
})
