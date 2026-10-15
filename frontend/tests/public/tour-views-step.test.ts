// @vitest-environment jsdom
// The tour's Views step (src/tour/steps.ts) says what views are, in one sentence: where a view proposal waits is not
// the tour's to say.
import { expect, test } from 'vitest'
import { tourSteps } from '../../src/tour/steps.ts'

test("the Views step is one sentence about views, live and in a demo, and says nothing of a proposal's place", () => {
  for (const demo of [false, true]) {
    const body = tourSteps('⌘', true, demo).find((s) => s.title === 'Views')!.body
    if (typeof body !== 'string') throw new Error('the Views step has a fixed body')
    expect(body.split(/(?<=\.)\s+/)).toHaveLength(1)
    expect(body).not.toMatch(/reply box|accept or reject/i)
  }
})
