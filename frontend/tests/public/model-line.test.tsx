// @vitest-environment jsdom
// The model line at a composer's foot (src/chat/ModelLine.tsx): fast mode's bolt names itself in the shared tooltip on
// hover and on keyboard focus, wherever it is drawn, and a line of one of thimble's agents, which runs with no fast mode
// of its own, has none. The Start card's line is start-gate.test.tsx's.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FastBolt, ModelLine, fastTip, noFastTip } from '../../src/chat/ModelLine.tsx'
import { TIP_DELAY_MS } from '../../src/components/Tooltip.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const SETTINGS = { models: { orient: { model: 'claude-opus-5-5', effort: 'ultracode', fast: true }, dev: { model: 'claude-custom-9', effort: 'high' } } }

beforeEach(() => {
  invalidateSettings('mini')
  // jsdom has no ResizeObserver, which the menu's popover watches its size with
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(SETTINGS), { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const click = async (b: HTMLElement) => {
  await act(async () => b.click())
  await settle()
}
const tip = () => document.querySelector('.tip')?.textContent ?? null
/** The pointer resting on `el` for as long as a tip waits. */
const hover = async (el: Element) => {
  vi.useFakeTimers()
  await act(async () => void el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })))
  await act(async () => void vi.advanceTimersByTime(TIP_DELAY_MS + 50))
  vi.useRealTimers()
}

describe("fast mode's bolt", () => {
  test("names fast mode and its state in the tooltip on main's line, on hover and on keyboard focus", async () => {
    const el = await mount(<ModelLine model="claude-opus-5-5" effort="high" fast={false} onFast={() => {}} label="main" />)
    const bolt = el.querySelector<HTMLButtonElement>('.fast-bolt')!
    expect(bolt.getAttribute('aria-label')).toBe('Fast mode for main')
    await hover(bolt)
    expect(tip()).toBe('Fast mode: off')
    expect(bolt.getAttribute('aria-describedby')).toBe(document.querySelector('.tip')!.id)
  })

  test("is not drawn on the line of one of thimble's agents, which has no fast mode of its own", async () => {
    const el = await mount(<ModelLine model="claude-opus-5-5" effort="high" noFast label="the orientation" />)
    expect(el.querySelector('.fast-bolt')).toBeNull()
    expect(el.querySelector('button[aria-label="Effort for the orientation"]')).not.toBeNull()
  })

  test('says why where it cannot be switched, and shows on keyboard focus too', async () => {
    const el = await mount(<FastBolt on={false} label="Fast mode for main" why={noFastTip('claude-haiku-4-5-20251001')} onChange={() => {}} />)
    const bolt = el.querySelector<HTMLButtonElement>('.fast-bolt')!
    expect(bolt.getAttribute('aria-disabled')).toBe('true')
    bolt.matches = ((sel: string) => sel === ':focus-visible' || Element.prototype.matches.call(bolt, sel)) as typeof bolt.matches
    await act(async () => bolt.focus())
    expect(tip()).toBe('Fast mode: Haiku 4.5 has no fast mode')
  })

  test('its tip always opens with "Fast mode"', () => {
    expect(fastTip(true, null)).toBe('Fast mode: on')
    expect(fastTip(false, null)).toBe('Fast mode: off')
    expect(fastTip(true, 'No Claude Code session is attached to main')).toBe('Fast mode: No Claude Code session is attached to main')
  })
})
