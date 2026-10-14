// @vitest-environment jsdom
// The top bar's Manual-mode chip (src/shell/ManualChip.tsx): it shows only while main's meta says main runs in Manual
// mode (`attached.manual`, set from the mode main's hooks report), says how to switch or who turned auto mode off, opens
// its sheet by itself once per session in this browser, and its × hides it for the workspace in this browser.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AUTO_COMMAND, HIDDEN_KEY, HIDE_TIP, MANUAL_CHIP, MANUAL_TEXT, ManualChip, TOLD_KEY, manualHint } from '../../src/shell/ManualChip.tsx'
import { TIP_DELAY_MS } from '../../src/components/Tooltip.tsx'
import type { Attached } from '../../src/lib/types.ts'
import { storageKey } from '../../src/lib/workspace.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const WS = 'mini'
const at = (manual?: Attached['manual'], session = 's1'): Pick<Attached, 'session' | 'manual'> => ({ session, ...(manual ? { manual } : {}) })
const chip = () => document.querySelector<HTMLElement>('.manual-chip')
const sheet = () => document.querySelector<HTMLElement>('.manual-sheet')
const click = async (el: Element) => {
  await act(async () => void (el as HTMLElement).click())
  await settle()
}

beforeEach(() => {
  window.localStorage.clear()
  // jsdom has no ResizeObserver, which the popover watches its size with
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the Manual-mode chip', () => {
  test('shows only while main reports Manual mode, and says how to switch, or who turned auto mode off', async () => {
    expect(manualHint(null)).toBe(null)
    expect(manualHint(at())).toBe(null)
    expect(manualHint({ manual: 'bogus' as Attached['manual'] })).toBe(null)
    await mount(<ManualChip ws={WS} attached={at()} />)
    expect(chip()).toBe(null)
    unmountAll()
    await mount(<ManualChip ws={WS} attached={at('switch')} />)
    expect(chip()?.textContent).toContain(MANUAL_CHIP)
    expect(MANUAL_TEXT.switch).toContain('shift+tab in your terminal')
    expect(MANUAL_TEXT.switch).toContain(AUTO_COMMAND)
    expect(sheet()?.textContent).toBe(MANUAL_TEXT.switch)
    expect(sheet()?.querySelector('code')?.textContent).toBe(AUTO_COMMAND)
    expect(MANUAL_TEXT.org).not.toContain('shift+tab')
    expect(MANUAL_TEXT.settings).not.toContain('shift+tab')
  })

  test('its sheet opens by itself once per session in this browser, and on a click; its tooltip says the same', async () => {
    await mount(<ManualChip ws={WS} attached={at('org')} />)
    expect(sheet()?.textContent).toBe(MANUAL_TEXT.org)
    expect(JSON.parse(window.localStorage.getItem(storageKey(WS, TOLD_KEY)) ?? 'null')).toBe('s1')
    await click(chip()!.querySelector('.manual-chip-open')!)
    expect(sheet()).toBe(null)
    unmountAll()
    await mount(<ManualChip ws={WS} attached={at('org')} />)
    expect(chip()).not.toBe(null)
    expect(sheet()).toBe(null)
    await click(chip()!.querySelector('.manual-chip-open')!)
    expect(sheet()?.textContent).toBe(MANUAL_TEXT.org)
    await click(chip()!.querySelector('.manual-chip-open')!)
    vi.useFakeTimers()
    await act(async () => void chip()!.querySelector('.manual-chip-open')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })))
    await act(async () => void vi.advanceTimersByTime(TIP_DELAY_MS + 50))
    vi.useRealTimers()
    expect(document.querySelector('.tip')?.textContent).toBe(MANUAL_TEXT.org)
    unmountAll()
    await mount(<ManualChip ws={WS} attached={at('org', 's2')} />)
    expect(sheet()?.textContent).toBe(MANUAL_TEXT.org)
  })

  test('its × hides it for this workspace in this browser; another workspace still shows it', async () => {
    await mount(<ManualChip ws={WS} attached={at('switch')} />)
    const hide = chip()!.querySelector<HTMLElement>('.manual-chip-hide')!
    expect(hide.getAttribute('aria-label')).toBe(HIDE_TIP)
    await click(hide)
    expect(chip()).toBe(null)
    expect(sheet()).toBe(null)
    expect(JSON.parse(window.localStorage.getItem(storageKey(WS, HIDDEN_KEY)) ?? 'null')).toBe(true)
    unmountAll()
    await mount(<ManualChip ws={WS} attached={at('switch', 's3')} />)
    expect(chip()).toBe(null)
    await mount(<ManualChip ws="other" attached={at('switch')} />)
    expect(chip()).not.toBe(null)
  })
})
