// @vitest-environment jsdom
// A question typed in the page's ask box during the tour outlasts the box the tour closes (src/tour/engine.ts closeBox,
// StartOptions keep): when the tour moves on from the ⌘-click step, or ends there, it closes the box as Esc does and
// hands what was typed in it to `keep`, which the shell gives main's composer (shell/TourHost, chat/pending
// offerDraft); the composer takes it into main's draft, after what is typed there (chat/Composer). Enter in the box,
// which the tour takes as a real key only, is checked in the browser (tests/public/browser/tour.test.ts).
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { Composer } from '../../src/chat/Composer.tsx'
import { offerDraft } from '../../src/chat/pending.ts'
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
/** The step that waits for the question once the ask box is open, and a step after it. */
const asking = () => tourSteps('⌘').find((s) => s.sub && s.title === '⌘-click to ask')!
const after: Step = { title: 'After', body: 'The next step.' }

test('the tour moving on from the ⌘-click step closes the ask box and keeps the question typed in it', () => {
  const kept: string[] = []
  const tour = createTour(snaps as Snaps)
  tour.start([asking(), after], { keep: (q) => kept.push(q) })
  const box = askBox('  Why did the database run out of connections?  ')
  document.querySelector<HTMLElement>('.tour-pop [data-tour="next"]')!.click()
  expect(tour.state().title).toBe('After')
  expect(box.isConnected).toBe(false)
  expect(kept).toEqual(['Why did the database run out of connections?'])
  tour.end()
})

test('the tour ending on the ⌘-click step keeps the question too; a box with nothing typed keeps nothing', () => {
  const kept: string[] = []
  const tour = createTour(snaps as Snaps)
  tour.start([asking(), after], { keep: (q) => kept.push(q) })
  const box = askBox('And when did it recover?')
  tour.end()
  expect(box.isConnected).toBe(false)
  expect(kept).toEqual(['And when did it recover?'])
  tour.start([asking(), after], { keep: (q) => kept.push(q) })
  const empty = askBox('   ')
  tour.end()
  expect(empty.isConnected).toBe(false)
  expect(kept).toEqual(['And when did it recover?'])
})

test("main's composer takes a question offered to it, after what is typed there, and leaves other threads' alone", async () => {
  // offered before the composer is drawn (the chat column folded), it is there once the composer is
  offerDraft('main', 'Why did the database run out of connections?')
  const el = await mount(<Composer onSend={() => undefined} sending={false} />)
  const field = el.querySelector('textarea')!
  expect(field.value).toBe('Why did the database run out of connections?')
  await act(async () => offerDraft('main', 'And when did it recover?'))
  expect(field.value).toBe('Why did the database run out of connections?\nAnd when did it recover?')
  await act(async () => offerDraft('chat-2', 'A question for another thread'))
  expect(field.value).toBe('Why did the database run out of connections?\nAnd when did it recover?')
})
