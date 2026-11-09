// @vitest-environment jsdom
// The tour's Report step (src/tour/steps.ts) lays the example's Report frame (src/example, example.html?pane=report)
// over the page's own Report, with an opening in the tour's block, so the analyst uses the report there. The top bar's
// Comments button takes a click too: it opens the page's own Comments sidebar for the example's to lie over. Going back,
// or the tour's end, puts the sidebar back as the analyst had it, and the frame goes. The page's own Report is never
// touched. The page here is a stand-in with the boxes thimble lays out; the frame's panes are a stand-in that records
// what the tour asks.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { PANES_KEY, type Box, type ExampleFrame, type PanesListeners } from '../../src/example/panes.ts'
import { createTour, type Snaps, type Tour } from '../../src/tour/engine.ts'
import snaps from '../../src/tour/examples.json'
import { tourSteps } from '../../src/tour/steps.ts'

type R = [number, number, number, number]
const rect = ([x, y, width, height]: R) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect
const boxed = (el: Element, r: () => R) => Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => rect(r()) })

/** Waits up to `ms` for `ok`, letting the tour's frames run; what `ok` gave. */
async function until<T>(ok: () => T, ms = 4000): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    const got = ok()
    if (got) return got as NonNullable<T>
    if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms in vain`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const OWN = '<div class="wu-root">the analyst’s own report</div>'
let tour: Tour
let report: HTMLElement
let commentsBtn: HTMLElement
let side: HTMLElement | null = null
let placed: { pane: Box; side: Box | null } | null = null
let told: PanesListeners = {}
let frameSeen: MutationObserver

beforeEach(() => {
  placed = null
  side = null
  // the page: the Report, and the top bar's Comments button, which opens the sidebar on the right and so makes the
  // Report narrower, as the shell does
  report = document.createElement('section')
  report.className = 'shell-panel'
  report.dataset.panel = 'report'
  report.innerHTML = OWN
  boxed(report, () => (side ? [340, 68, 656, 820] : [340, 68, 1088, 820]))
  commentsBtn = document.createElement('button')
  commentsBtn.className = 'shell-side-btn'
  commentsBtn.dataset.side = 'comments'
  boxed(commentsBtn, () => [1120, 34, 96, 28])
  commentsBtn.addEventListener('click', () => {
    if (side) {
      side.remove()
      side = null
      return
    }
    side = document.createElement('aside')
    side.className = 'lside'
    side.dataset.section = 'comments'
    boxed(side, () => [1008, 68, 420, 820])
    document.body.append(side)
  })
  document.body.append(report, commentsBtn)
  // the tour's frame and the panes' paper under it are laid out by their style
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (!(this instanceof HTMLIFrameElement) && !this.classList.contains('tour-ex-paper')) return Element.prototype.getBoundingClientRect.call(this)
      const s = this.style
      return rect(s.display === 'none' ? [0, 0, 0, 0] : [parseFloat(s.left) || 0, parseFloat(s.top) || 0, parseFloat(s.width) || 0, parseFloat(s.height) || 0])
    },
  })
  // the example's Report in the frame, which records where the tour places it
  const panes: ExampleFrame = {
    place: (p, s) => void (placed = { pane: p, side: s }),
    ready: () => true,
    close: async () => undefined,
    listen: (fns) => void (told = fns),
  }
  frameSeen = new MutationObserver(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.tour-ex-panes')
    const win = frame?.contentWindow as unknown as Record<string, unknown> | null
    if (win && !win[PANES_KEY]) win[PANES_KEY] = panes
  })
  frameSeen.observe(document.body, { childList: true, subtree: true })
  tour = createTour(snaps as Snaps)
})
afterEach(() => {
  tour.end()
  frameSeen.disconnect()
  document.body.innerHTML = ''
  delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect
})

const clip = () => document.querySelector<HTMLElement>('.tour-block')!.style.clipPath
const shown = (title: string) => () => tour.state().title === title && !!tour.geometry() && getComputedStyle(document.querySelector('.tour-pop')!).visibility !== 'hidden'
/** The Report step of the tour without the chat's steps, as with the chat column folded: the last. */
const start = () => {
  const steps = tourSteps('⌘', false)
  tour.start(steps, { at: steps.findIndex((s) => s.title === 'Report') })
}

test('the Report step lays the example Report over the page’s own, with openings for it and for the Comments button, and keeps its words', async () => {
  start()
  await until(shown('Report'))
  const frame = document.querySelector<HTMLIFrameElement>('.tour-ex iframe.tour-ex-panes')!
  expect(frame.getAttribute('src')).toMatch(/example\.html\?pane=report$/)
  expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual(['340px', '68px', '1088px', '820px'])
  expect(placed).toEqual({ pane: { x: 0, y: 0, width: 1088, height: 820 }, side: null })
  // an opening over the frame, and one over the top bar's Comments button; a cutout around each
  expect(clip()).toContain('340px 68px, 340px 888px, 1428px 888px, 1428px 68px')
  expect(clip()).toContain('1120px 34px')
  expect(tour.geometry()!.holes).toHaveLength(2)
  expect(document.querySelector('.tour-pop .tour-title')?.textContent).toBe('Report')
  // the shortcuts' key: ⌘ on a Mac, Ctrl elsewhere
  expect(document.querySelector('.tour-pop .tour-body')?.textContent).toMatch(/^Write the report yourself or ask Claude to write it\. Drag in cards or (⌘|Ctrl)\+Enter to request one\.$/)
  expect(document.querySelector('.tour-pop .tour-note')?.textContent).toBe('Reopen this tour with /tour in the chat.')
  expect(report.innerHTML).toBe(OWN)
})

test('the Comments button opens the page’s sidebar under the example’s, the example’s × closes it, and the tour’s end puts it back', async () => {
  start()
  await until(shown('Report'))
  // the analyst's click on the button reaches it
  commentsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(side).not.toBeNull()
  await until(() => placed?.side != null)
  expect(placed).toEqual({ pane: { x: 0, y: 0, width: 656, height: 820 }, side: { x: 668, y: 0, width: 420, height: 820 } })
  const frame = document.querySelector<HTMLIFrameElement>('iframe.tour-ex-panes')!
  expect([frame.style.left, frame.style.width]).toEqual(['340px', '1088px'])
  await until(() => tour.geometry()!.holes.length === 3)
  // the example's × closes the page's sidebar too; asked for again, it opens
  told.side?.(false)
  expect(side).toBeNull()
  told.side?.(true)
  expect(side).not.toBeNull()
  // Done: the sidebar closed as the analyst had it, the frame gone, the page's own Report as it was
  document.querySelector<HTMLElement>('.tour-pop [data-tour="done"]')!.click()
  expect(tour.running()).toBe(false)
  expect(side).toBeNull()
  expect(document.querySelector('iframe.tour-ex-panes')).toBeNull()
  expect(report.innerHTML).toBe(OWN)
})

test('an analyst who had the Comments sidebar open finds it open after Back, and Escape the panes did not take closes the tour', async () => {
  commentsBtn.click()
  expect(side).not.toBeNull()
  start()
  await until(shown('Report'))
  await until(() => placed?.side != null)
  told.side?.(false)
  expect(side).toBeNull()
  // Back: the step before it, and the sidebar as the analyst had it
  document.querySelector<HTMLElement>('.tour-pop [data-tour="back"]')!.click()
  expect(side).not.toBeNull()
  expect(document.querySelector('iframe.tour-ex-panes')).toBeNull()
  // on the Report again, Escape that nothing in the panes took closes the tour, and leaves the sidebar open
  start()
  await until(shown('Report'))
  told.escape?.()
  expect(tour.running()).toBe(false)
  expect(side).not.toBeNull()
})
