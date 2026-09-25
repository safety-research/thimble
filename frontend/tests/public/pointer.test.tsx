// @vitest-environment jsdom
// The pointer's modifier key (src/lib/platform.ts, src/pointer/CmdPointer.tsx). On a Mac ⌘ with a click on an anchored
// element opens the ask box beside it. Off a Mac, where the desktop keeps the Super key, Ctrl with a click does the
// same, and on a Mac Ctrl with a click (the context menu's gesture) does nothing. A plain click never opens the box.
// The box says "Ask about this…" while it is empty, and opens beside the element pointed at, a view's frame's included
// (src/pointer/PointerBox.tsx boxPlace).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { isMacPlatform, isPointKey, pointKeyHeld, shortcutLabel } from '../../src/lib/platform.ts'
import { bus } from '../../src/lib/bus.ts'
import { CmdPointer } from '../../src/pointer/CmdPointer.tsx'
import { BESIDE_DROP, GAP_BESIDE, boxPlace } from '../../src/pointer/PointerBox.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

describe('the platform key', () => {
  test('⌘ alone on a Mac; Ctrl or the Windows or Super key elsewhere', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('iPad')).toBe(true)
    expect(isMacPlatform('Linux x86_64')).toBe(false)
    expect(isMacPlatform('Win32')).toBe(false)
    const ctrl = { metaKey: false, ctrlKey: true }
    const cmd = { metaKey: true, ctrlKey: false }
    expect(pointKeyHeld(ctrl, true)).toBe(false)
    expect(pointKeyHeld(cmd, true)).toBe(true)
    expect(pointKeyHeld(ctrl, false)).toBe(true)
    expect(pointKeyHeld(cmd, false)).toBe(true)
    expect(isPointKey('Control', true)).toBe(false)
    expect(isPointKey('Control', false)).toBe(true)
    expect(isPointKey('Meta', true)).toBe(true)
    expect(shortcutLabel('G', true)).toBe('⌘G')
    expect(shortcutLabel('G', false)).toBe('Ctrl+G')
  })
})

/** The pointer mounted beside a card-like element that carries an anchor, on the platform `platform` names. */
async function pointerOn(platform: string): Promise<HTMLElement> {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform)
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (${platform})`)
  const el = await mount(
    <div>
      <CmdPointer ws="w" />
      <div data-anchor="card:abcd1234" data-anchor-text="Reviews per agent">
        Reviews per agent
      </div>
    </div>,
  )
  await settle()
  return el
}

const clickOn = async (el: Element, init: MouseEventInit) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...init }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, ...init }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...init }))
  })
  await settle()
}

const box = () => document.querySelector('.pointer-box[role="dialog"]')

describe('a click with the pointer key', () => {
  test('off a Mac, Ctrl with a click on an anchored element opens the ask box', async () => {
    const el = await pointerOn('Linux x86_64')
    const card = el.querySelector('[data-anchor]')!
    await clickOn(card, {})
    expect(box()).toBeNull()
    await clickOn(card, { ctrlKey: true })
    expect(box()).not.toBeNull()
    expect(box()?.getAttribute('aria-label')).toBe('Ask about this')
    expect(box()?.querySelector('textarea')?.getAttribute('placeholder')).toBe('Ask about this…')
  })

  test("a point from a view's frame opens the box beside the element it names, never over it", async () => {
    await pointerOn('Linux x86_64')
    const frame = document.createElement('iframe')
    await act(async () => bus.emit('pointAt', { anchor: 'view:review-threads', text: 'open closed', element: 'legend', rect: new DOMRect(100, 100, 200, 100), frame, view: 'review-threads' }))
    await settle()
    const el = box() as HTMLElement
    expect(el.querySelector('textarea')?.getAttribute('placeholder')).toBe('Ask about this…')
    // GAP_BESIDE right of the element's right edge, BESIDE_DROP below its top
    expect(el.style.left).toBe(`${300 + GAP_BESIDE}px`)
    expect(el.style.top).toBe(`${100 + BESIDE_DROP}px`)
    expect(boxPlace({ left: 100, top: 100, right: 300, bottom: 200 }, 236, 40, 1024, 768, { under: false })).toEqual({ left: 312, top: 108, under: false })
    // no room to the right: to its left; room on neither side: under it
    expect(boxPlace({ left: 800, top: 100, right: 1000, bottom: 200 }, 236, 40, 1024, 768, { under: false }).left).toBe(800 - GAP_BESIDE - 236)
    expect(boxPlace({ left: 20, top: 100, right: 1000, bottom: 200 }, 236, 40, 1024, 768, { under: false })).toEqual({ left: 20, top: 208, under: true })
  })

  test('on a Mac, ⌘ with a click opens it and Ctrl with a click does not', async () => {
    const el = await pointerOn('MacIntel')
    const card = el.querySelector('[data-anchor]')!
    await clickOn(card, { ctrlKey: true })
    expect(box()).toBeNull()
    await clickOn(card, { metaKey: true })
    expect(box()).not.toBeNull()
  })

  test('off a Mac, holding Ctrl alone puts the page in the pointer state, and Ctrl with another key lets go', async () => {
    await pointerOn('Linux x86_64')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    })
    expect(document.body.hasAttribute('data-cmd')).toBe(true)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    })
    expect(document.body.hasAttribute('data-cmd')).toBe(false)
  })
})
