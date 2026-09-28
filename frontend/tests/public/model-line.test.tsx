// @vitest-environment jsdom
// The model line at a composer's foot (src/chat/ModelLine.tsx): on the Start card the orientation's model is a menu of
// the models the settings name and the current ones, as a role's is, and a pick is handed to the card's owner to save;
// the card has one form, which also offers Ultracode, the critique and the permission mode (terminal-first mode runs
// the orientation as a background session that takes them all). Fast mode's bolt names itself in the
// shared tooltip on hover and on keyboard focus, wherever it is drawn. Every request is answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FastBolt, fastTip, noFastTip } from '../../src/chat/ModelLine.tsx'
import { StartGate } from '../../src/chat/StartGate.tsx'
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

describe("the Start card's model", () => {
  test('is a menu of the models the settings name and the current ones, and a pick is handed on to be saved', async () => {
    const picked: string[] = []
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" onModel={(m) => picked.push(m)} fast={true} onFast={() => {}} />)
    await settle()
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model for the orientation"]')!
    expect(trigger.textContent).toBe('Opus 5.5')
    expect(el.querySelector('.model-line-model')).toBeNull()
    await click(trigger)
    const items = [...document.querySelectorAll<HTMLButtonElement>('.menu-item')]
    const notes = items.map((b) => b.querySelector('.menu-item-note')?.textContent)
    expect(notes.slice(0, 2)).toEqual(['claude-opus-5-5', 'claude-custom-9'])
    expect(notes).toContain('claude-haiku-4-5-20251001')
    expect(items.find((b) => b.classList.contains('checked'))?.querySelector('.menu-item-label')?.textContent).toBe('Opus 5.5')
    await click(items.find((b) => b.textContent?.includes('claude-haiku-4-5-20251001'))!)
    expect(picked).toEqual(['claude-haiku-4-5-20251001'])
  })

  test('sits beside an effort menu with Ultracode, and the options offer the critique and the permission mode', async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" onModel={() => {}} fast={false} onFast={() => {}} />)
    await settle()
    await click(el.querySelector<HTMLButtonElement>('button[aria-label="Effort for the orientation"]')!)
    expect([...document.querySelectorAll('.menu-item')].some((b) => /ultracode/i.test(b.textContent ?? ''))).toBe(true)
    await click(el.querySelector<HTMLButtonElement>('.chat-gate-options-toggle')!)
    expect(el.querySelector('.chat-gate-row[data-pass="critique"]')).not.toBeNull()
    expect(el.querySelector('.chat-gate-perms')).not.toBeNull()
  })
})

describe("fast mode's bolt", () => {
  test('names fast mode and its state in the tooltip on the Start card, on hover and on keyboard focus', async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" onModel={() => {}} fast={false} onFast={() => {}} />)
    const bolt = el.querySelector<HTMLButtonElement>('.fast-bolt')!
    expect(bolt.getAttribute('aria-label')).toBe('Fast mode for the orientation')
    await hover(bolt)
    expect(tip()).toBe('Fast mode: off')
    expect(bolt.getAttribute('aria-describedby')).toBe(document.querySelector('.tip')!.id)
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
