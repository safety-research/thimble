// @vitest-environment jsdom
// The views bar (src/files/ViewsBar.tsx) has no ⋯ menu of its own: across Files' top it ends with New view. In a pane's
// head (`compact`) the views that do not fit go in a ⋯ of their own, More views, which shows only then (viewsFit.ts
// fitViews), each view there a pick that closes it, with the dot while a new or updated view is among them.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ViewsBar, type BuiltView } from '../../src/files/ViewsBar.tsx'
import { fitViews } from '../../src/files/viewsFit.ts'
import { storageKey, writeStorage } from '../../src/lib/workspace.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const VIEWS: BuiltView[] = [
  { slug: 'night-runs', name: 'Night Runs' },
  { slug: 'stage-times', name: 'Stage Times' },
]
const MORE = 'More views'
/** the pane head's width, px; 0 is a bar not laid out */
let room = 0
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!

beforeEach(() => {
  room = 0
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
  // jsdom lays nothing out: in the bar's hidden copy each option is 100 px wide and each square button 24, and the
  // pane head has `room`
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('seg-opt-m') ? 100 : this.classList.contains('btn-square') ? 24 : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('is-compact') ? room : 0
    },
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

const more = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(`button[aria-label="${MORE}"]`)
const options = (el: HTMLElement) => [...el.querySelectorAll('.files-views .seg-opt')].map((o) => o.textContent)

describe('across the top of Files', () => {
  test('the bar ends with New view, and has no ⋯ menu', async () => {
    const el = await mount(<ViewsBar ws="w1" value="browser" onChange={() => undefined} views={VIEWS} />)
    await settle()
    const bar = el.querySelector('.files-views')!
    expect(bar.lastElementChild?.textContent).toBe('New view')
    expect(more(el)).toBeNull()
    expect(bar.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(options(el)).toEqual(['File browser', 'Night Runs', 'Stage Times'])
  })
})

describe("in a pane's head", () => {
  test('while every view fits there is no ⋯', async () => {
    // three options and New view's +
    room = 3 * 100 + 24
    const el = await mount(<ViewsBar ws="w2" value="browser" onChange={() => undefined} views={VIEWS} compact />)
    await settle()
    expect(options(el)).toEqual(['File browser', 'Night Runs', 'Stage Times'])
    expect(more(el)).toBeNull()
  })

  test('the views that do not fit go in More views, each a pick that closes it, with the dot for a new one', async () => {
    writeStorage(storageKey('w3', 'viewsReady'), ['stage-times'])
    const picked = vi.fn()
    // room for two options beside ⋯ and +
    room = 2 * 100 + 2 * 24
    const el = await mount(<ViewsBar ws="w3" value="browser" onChange={picked} views={VIEWS} compact />)
    await settle()
    expect(options(el)).toEqual(['File browser', 'Night Runs'])
    // ⋯ comes before New view's +, and carries the dot of the new view it holds
    const buttons = [...el.querySelectorAll<HTMLElement>('.files-views.is-compact button')].filter((b) => !b.closest('.seg'))
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([MORE, 'New view'])
    expect(el.querySelector('.files-views-more-dot')).not.toBeNull()
    await act(async () => more(el)!.click())
    await settle()
    const items = [...document.querySelectorAll<HTMLButtonElement>(`.popover[role="menu"][aria-label="${MORE}"] .menu-item`)]
    expect(items.map((b) => [b.querySelector('.menu-item-label')?.textContent, b.getAttribute('role')])).toEqual([['Stage Times', 'menuitemradio']])
    expect(items[0].querySelector('.menu-item-note')?.textContent).toBe('new')
    await act(async () => items[0].click())
    expect(picked).toHaveBeenCalledWith('v:stage-times')
    expect(document.querySelector(`.popover[role="menu"][aria-label="${MORE}"]`)).toBeNull()
  })
})

describe('what fits', () => {
  test('the ⋯ counts only when some option does not fit; the picked option keeps its place', () => {
    // 3 options of 100, a gap of 4, New view's + and ⋯ 24 each
    const widths = [100, 100, 100]
    expect(fitViews({ widths, room: 3 * 100 + 3 * 4 + 24, gap: 4, tail: 24, more: 24, active: 0 })).toEqual([0, 1, 2])
    expect(fitViews({ widths, room: 3 * 100 + 3 * 4 + 23, gap: 4, tail: 24, more: 24, active: 0 })).toEqual([0, 1])
    expect(fitViews({ widths, room: 2 * 100 + 3 * 4 + 48, gap: 4, tail: 24, more: 24, active: 2 })).toEqual([0, 2])
    // too narrow for even the picked option beside ⋯ and +: every option goes in the menu
    expect(fitViews({ widths, room: 100, gap: 4, tail: 24, more: 24, active: 1 })).toEqual([])
  })
})
