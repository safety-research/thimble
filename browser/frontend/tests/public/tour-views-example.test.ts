// @vitest-environment jsdom
// The tour's Views example (src/tour/steps.ts viewsExample) is marked as the tour's own, as every other example is: its
// Example badge stands in the example's views bar, in the row of views after its last item, and not on the view. The
// browser check (browser/tour.test.ts) sees that the badge covers nothing of the bar.
import { expect, test } from 'vitest'
import { createTour, type Api, type Snaps } from '../../src/tour/engine.ts'
import snaps from '../../src/tour/examples.json'
import { tourSteps } from '../../src/tour/steps.ts'

/** The example of the step titled `title`, drawn as the tour draws it (engine.ts startRun) on a page with nothing of
 * thimble's: by the tour's own api, into a layer of the test's own, since the tour makes its layers when it starts. */
const drawExample = (title: string) => {
  const api: Api = { ...createTour(snaps as Snaps).api, ex: document.createElement('div') }
  return tourSteps('⌘').find((s) => s.title === title)!.example!(api)
}

test('the Views example carries its Example badge at the end of its views bar, and the view carries none', () => {
  const { bar, body } = drawExample('Views').els as { bar: HTMLElement; body: HTMLElement }
  const badges = [...bar.querySelectorAll('.tour-tag')]
  expect(badges).toHaveLength(1)
  const views = bar.querySelector('.files-views')!
  expect(views.lastElementChild).toBe(badges[0])
  expect(body.querySelector('.tour-tag')).toBeNull()
})
