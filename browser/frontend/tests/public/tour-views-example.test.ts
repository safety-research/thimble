// @vitest-environment jsdom
// The tour's Views step (src/tour/steps.ts) says its view is the tour's example, not one of the analyst's own: thimble
// builds views for their files, and this one is on the tour's example data. The browser check (browser/tour.test.ts)
// sees the step's Example badge in the views bar.
import { expect, test } from 'vitest'
import { tourSteps } from '../../src/tour/steps.ts'

test("the Views step says its view is on the tour's example data", () => {
  const step = tourSteps('⌘').find((s) => s.title === 'Views')!
  expect(step.body).toMatch(/example data/)
})
