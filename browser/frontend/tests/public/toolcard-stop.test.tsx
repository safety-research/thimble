// @vitest-environment jsdom
// A running tool-call card's Stop (src/components/ToolCard.tsx): the spinner says it runs and Stop after it stays a
// plain clickable button; only while the stop request is in flight is it busy and ignores clicks.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolCard } from '../../src/components/ToolCard.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

describe('ToolCard stop', () => {
  test('a running card shows the spinner and a clickable Stop that does not toggle the card', async () => {
    const onStop = vi.fn()
    const onToggle = vi.fn()
    const el = await mount(<ToolCard title="Orientation" state="running" lead="brief" onToggle={onToggle} stop={{ onStop }} />)
    const head = el.querySelector('.toolcard-head')!
    expect(head.classList.contains('toolcard-head-stop')).toBe(true)
    expect(head.querySelector('.toolcard-end > .spinner')).not.toBeNull()
    const btn = head.querySelector<HTMLButtonElement>('button.toolcard-stop')!
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-busy')).toBeNull()
    expect(btn.querySelector('.spinner')).toBeNull()
    expect(btn.querySelector('.btn-ico')).not.toBeNull()
    btn.click()
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  test('while the stop request is in flight Stop is busy and ignores clicks', async () => {
    const onStop = vi.fn()
    const el = await mount(<ToolCard title="Orientation" state="running" stop={{ onStop, busy: true }} />)
    const btn = el.querySelector<HTMLButtonElement>('button.toolcard-stop')!
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    btn.click()
    expect(onStop).not.toHaveBeenCalled()
  })

  test('a card that is not running shows no Stop', async () => {
    const el = await mount(<ToolCard title="Orientation" state="done" stop={{ onStop: () => undefined }} />)
    expect(el.querySelector('.toolcard-stop')).toBeNull()
    expect(el.querySelector('.toolcard-head-stop')).toBeNull()
  })
})
