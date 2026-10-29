// @vitest-environment jsdom
// A question typed in the page's ask box during the tour goes with the box (src/tour/engine.ts closeBox): while the tour
// runs the box sends nothing, and when the tour moves on from the ⌘-click step, or ends there, it closes the box as Esc
// does. Nothing of the question reaches main's composer, which keeps what the analyst typed there. Enter in the box,
// which the tour takes as a real key only, is checked in the browser (tests/public/browser/tour.test.ts).
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { Composer } from '../../src/chat/Composer.tsx'
import { createTour, type Snaps, type Step } from '../../src/tour/engine.ts'
import snaps from '../../src/tour/examples.json'
import { tourSteps } from '../../src/tour/steps.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

/** The page's ask box as the ⌘ pointer draws it (pointer/PointerBox), `text` typed in it; Esc closes it, as there. */
function askBox(text: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'pointer-box'
  const field = document.createElement('textarea')
  field.value = text
  box.append(field)
  document.body.append(box)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    box.remove()
    document.removeEventListener('keydown', onKey)
  }
  document.addEventListener('keydown', onKey)
  return box
}
/** `text` typed into a React text field, as a person types it. */
const typeInto = (field: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
/** The step that waits for the question once the ask box is open, and a step after it. */
const asking = () => tourSteps('⌘').find((s) => s.sub && s.title === '⌘-click to ask')!
const after: Step = { title: 'After', body: 'The next step.' }

test("the tour moving on from the ⌘-click step closes the ask box, and main's composer keeps only what the analyst typed there", async () => {
  const el = await mount(<Composer onSend={() => undefined} sending={false} />)
  const field = el.querySelector('textarea')!
  await typeInto(field, 'My own question')
  const tour = createTour(snaps as Snaps)
  tour.start([asking(), after])
  const box = askBox('Why did the database run out of connections?')
  await act(async () => document.querySelector<HTMLElement>('.tour-pop [data-tour="next"]')!.click())
  expect(tour.state().title).toBe('After')
  expect(box.isConnected).toBe(false)
  expect(field.value).toBe('My own question')
  await act(async () => void tour.end())
  expect(field.value).toBe('My own question')
})

test("the tour ending on the ⌘-click step closes the ask box too, and main's composer stays empty", async () => {
  const el = await mount(<Composer onSend={() => undefined} sending={false} />)
  const tour = createTour(snaps as Snaps)
  tour.start([asking(), after])
  const box = askBox('And when did it recover?')
  await act(async () => void tour.end())
  expect(box.isConnected).toBe(false)
  expect(el.querySelector('textarea')!.value).toBe('')
})
