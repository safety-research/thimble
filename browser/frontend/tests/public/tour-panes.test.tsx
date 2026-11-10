// @vitest-environment jsdom
// The tour's Files and Labels steps (src/tour/steps.ts) lay the example panes' frame (src/example) over the page's own
// Files pane, with an opening in the tour's block, so the analyst uses the panes there; the Labels step opens the
// page's own Labels sidebar for the example's to lie over, and its top bar button takes a click too. Its demo starts
// from the plain transcript, and one stopped early leaves the step colored with the sidebar open. Leaving the steps puts
// the sidebar back as the analyst had it, and the frame goes. The page's own panes are never touched. The page here is
// a stand-in with the boxes thimble lays out; the frame's panes are a stand-in that records what the tour asks.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { PANES_KEY, type Box, type ExamplePanes, type PanesListeners } from '../../src/example/panes.ts'
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

let tour: Tour
let files: HTMLElement
let sideBtn: HTMLElement
let side: HTMLElement | null = null
const asked: string[] = []
let placed: { files: Box; side: Box | null } | null = null
let told: PanesListeners = {}
let frameSeen: MutationObserver

beforeEach(() => {
  asked.length = 0
  placed = null
  side = null
  // the page: one Files pane, and the top bar's Labels button, which opens the sidebar on the right and so makes the
  // Files pane narrower, as the shell does
  files = document.createElement('section')
  files.className = 'shell-panel'
  files.dataset.panel = 'files'
  files.innerHTML = '<div class="files-tab">the analyst’s files</div>'
  boxed(files, () => (side ? [340, 68, 656, 820] : [340, 68, 1088, 820]))
  sideBtn = document.createElement('button')
  sideBtn.className = 'shell-side-btn'
  sideBtn.dataset.side = 'labels'
  boxed(sideBtn, () => [1030, 34, 80, 28])
  sideBtn.addEventListener('click', () => {
    if (side) {
      side.remove()
      side = null
      return
    }
    side = document.createElement('aside')
    side.className = 'lside'
    side.dataset.section = 'labels'
    boxed(side, () => [1008, 68, 420, 820])
    document.body.append(side)
  })
  document.body.append(files, sideBtn)
  // the tour's frame and the panes' paper under it are laid out by their style
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (!(this instanceof HTMLIFrameElement) && !this.classList.contains('tour-ex-paper')) return Element.prototype.getBoundingClientRect.call(this)
      const s = this.style
      return rect(s.display === 'none' ? [0, 0, 0, 0] : [parseFloat(s.left) || 0, parseFloat(s.top) || 0, parseFloat(s.width) || 0, parseFloat(s.height) || 0])
    },
  })
  // the example's panes in the frame, which record what the tour asks of them
  const part = (name: string) => {
    const el = document.createElement('button')
    boxed(el, () => [500, 160, 120, 24])
    el.addEventListener('click', () => asked.push(`click ${name}`))
    return el
  }
  const parts = { 'color-by': part('color-by'), 'color-by-label': part('color-by-label') }
  const panes: ExamplePanes = {
    place: (f, s) => void (placed = { files: f, side: s }),
    ready: () => true,
    reset: () => void asked.push('reset'),
    color: () => void asked.push('color'),
    plain: () => void asked.push('plain'),
    part: (name) => parts[name],
    close: async () => void asked.push('close'),
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

test('the Files step lays the example panes over the Files pane, with an opening for them, and touches no pane of the page', async () => {
  // the steps without the chat's, as with the chat column folded: Files is the first
  tour.start(tourSteps('⌘', false))
  await until(shown('Files'))
  const frame = document.querySelector<HTMLIFrameElement>('.tour-ex iframe.tour-ex-panes')!
  expect(frame.getAttribute('src')).toMatch(/example\.html$/)
  expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual(['340px', '68px', '1088px', '820px'])
  expect(placed).toEqual({ files: { x: 0, y: 0, width: 1088, height: 820 }, side: null })
  // the block is open over the frame alone
  expect(clip()).toContain('340px 68px, 340px 888px, 1428px 888px, 1428px 68px')
  expect(clip()).not.toContain('1030px')
  expect(files.innerHTML).toBe('<div class="files-tab">the analyst’s files</div>')
})

test('the Labels step opens the page’s sidebar under the example’s, takes a click on its button, and leaving puts it back', async () => {
  tour.start(tourSteps('⌘', false), { at: 1 })
  await until(shown('Labels'))
  // the demo starts from the plain transcript; the analyst's own input in the panes stops it, which leaves the step
  // colored, with the sidebar open
  await until(() => asked.includes('reset'))
  told.input?.()
  await until(() => asked.includes('color') && !!side)
  await until(() => placed?.side != null)
  expect(placed).toEqual({ files: { x: 0, y: 0, width: 656, height: 820 }, side: { x: 668, y: 0, width: 420, height: 820 } })
  const frame = document.querySelector<HTMLIFrameElement>('iframe.tour-ex-panes')!
  expect([frame.style.left, frame.style.width]).toEqual(['340px', '1088px'])
  // an opening over the frame, and one over the top bar's Labels button
  await until(() => clip().includes('1030px 34px'))
  expect(clip()).toContain('340px 68px, 340px 888px, 1428px 888px, 1428px 68px')
  expect(tour.geometry()!.holes).toHaveLength(3)
  // the panes' own × closes the page's sidebar too
  told.side?.(false)
  expect(side).toBeNull()
  told.side?.(true)
  expect(side).not.toBeNull()
  // on to the next step: the transcript plain again, the sidebar closed as the analyst had it, and the frame gone
  document.querySelector<HTMLElement>('.tour-pop [data-tour="next"]')!.click()
  expect(asked).toContain('plain')
  expect(side).toBeNull()
  expect(document.querySelector('iframe.tour-ex-panes')).toBeNull()
  expect(files.innerHTML).toBe('<div class="files-tab">the analyst’s files</div>')
})

test("Escape that the panes did not take closes the tour, and the tour's end puts the sidebar back", async () => {
  sideBtn.click()
  expect(side).not.toBeNull()
  // the analyst had the sidebar open: the Files step shows the example's over it
  tour.start(tourSteps('⌘', false))
  await until(shown('Files'))
  await until(() => placed?.side != null)
  told.escape?.()
  expect(tour.running()).toBe(false)
  expect(side).not.toBeNull()
  expect(document.querySelector('iframe.tour-ex-panes')).toBeNull()
})
