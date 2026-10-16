// @vitest-environment jsdom
// The ask key (src/lib/platform.ts): the key held with a click to ask about what it points at, which Settings picks
// (thimble's config `askKey`): ⌘-click by default, or ⌥-click; off a Mac, Ctrl-click or Alt-click. The other key
// places a card freely on the canvas. The choice is kept in browser storage too, so a page opened again knows it
// before the settings load; ⌘↵, a shortcut, stays on ⌘ (Ctrl) whichever key asks. The tour names the key picked, and a
// view's frame is told it with the ⌘ pointer's `cmd` message.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { askKeyLabel, freeKeyHeld, getAskKey, isModKey, isPointKey, modKeyHeld, onAskKey, pointKeyHeld, setAskKey, useAskKey } from '../../src/lib/platform.ts'
import { mount, unmountAll } from './mount.tsx'

const ev = (k: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) => ({ metaKey: false, ctrlKey: false, altKey: false, ...k })

afterEach(() => {
  unmountAll()
  setAskKey('meta')
  vi.resetModules()
})

describe('the keys', () => {
  test('⌘ (Ctrl off a Mac) asks by default, and ⌥ (Alt) places a card freely', () => {
    setAskKey(null)
    expect(getAskKey()).toBe('meta')
    expect(pointKeyHeld(ev({ metaKey: true }), true)).toBe(true)
    expect(pointKeyHeld(ev({ altKey: true }), true)).toBe(false)
    expect(pointKeyHeld(ev({ ctrlKey: true }), false)).toBe(true)
    expect(pointKeyHeld(ev({ ctrlKey: true }), true)).toBe(false) // Ctrl-click on a Mac is the context menu
    expect(isPointKey('Meta', true)).toBe(true)
    expect(isPointKey('Alt', true)).toBe(false)
    expect(isPointKey('Control', false)).toBe(true)
    expect(freeKeyHeld(ev({ altKey: true }), true)).toBe(true)
    expect(freeKeyHeld(ev({ metaKey: true }), true)).toBe(false)
    expect([askKeyLabel(true), askKeyLabel(false)]).toEqual(['⌘', 'Ctrl'])
  })

  test('with ⌥ picked, ⌥ (Alt) asks and ⌘ (Ctrl) places a card freely', () => {
    setAskKey('alt')
    expect(getAskKey()).toBe('alt')
    expect(pointKeyHeld(ev({ altKey: true }), true)).toBe(true)
    expect(pointKeyHeld(ev({ metaKey: true }), true)).toBe(false)
    expect(pointKeyHeld(ev({ altKey: true }), false)).toBe(true)
    expect(pointKeyHeld(ev({ ctrlKey: true }), false)).toBe(false)
    expect(isPointKey('Alt', true)).toBe(true)
    expect(isPointKey('Meta', true)).toBe(false)
    expect(isPointKey('Control', false)).toBe(false)
    expect(freeKeyHeld(ev({ metaKey: true }), true)).toBe(true)
    expect(freeKeyHeld(ev({ ctrlKey: true }), false)).toBe(true)
    expect(freeKeyHeld(ev({ altKey: true }), true)).toBe(false)
    expect([askKeyLabel(true), askKeyLabel(false)]).toEqual(['⌥', 'Alt'])
  })

  test("⌘↵'s key is the shortcuts' whichever key asks", () => {
    setAskKey('alt')
    expect(modKeyHeld(ev({ metaKey: true }), true)).toBe(true)
    expect(modKeyHeld(ev({ ctrlKey: true }), false)).toBe(true)
    expect(isModKey('Meta', true)).toBe(true)
    expect(isModKey('Alt', true)).toBe(false)
  })
})

describe('the choice', () => {
  test('is heard by whoever listens and read by a component, and anything but "alt" is ⌘', async () => {
    const heard: string[] = []
    const off = onAskKey(() => heard.push(getAskKey()))
    function Shown() {
      return <span className="shown">{useAskKey()}</span>
    }
    const el = await mount(<Shown />)
    expect(el.textContent).toBe('meta')
    await act(async () => setAskKey('alt'))
    expect(el.textContent).toBe('alt')
    await act(async () => setAskKey('alt'))
    await act(async () => setAskKey('shift'))
    expect(el.textContent).toBe('meta')
    off()
    expect(heard).toEqual(['alt', 'meta'])
  })

  test('a page opened again knows it from browser storage before the settings load', async () => {
    setAskKey('alt')
    vi.resetModules()
    const fresh = await import('../../src/lib/platform.ts')
    expect(fresh.getAskKey()).toBe('alt')
    fresh.setAskKey('meta')
    vi.resetModules()
    expect((await import('../../src/lib/platform.ts')).getAskKey()).toBe('meta')
  })

  test('the tour names the key picked', async () => {
    const started: { title?: string }[][] = []
    vi.doMock('../../src/tour/engine', () => ({ createTour: () => ({ start: (steps: { title?: string }[]) => started.push(steps) }) }))
    const platform = await import('../../src/lib/platform.ts')
    const { runTour } = await import('../../src/tour/run.ts')
    platform.setAskKey('alt')
    runTour({ welcome: false, chat: true })
    platform.setAskKey('meta')
    runTour({ welcome: false, chat: true })
    vi.doUnmock('../../src/tour/engine')
    const asks = started.map((steps) => steps.find((s) => /-click to ask$/.test(s.title ?? ''))?.title)
    // jsdom reports no Mac: Alt and Ctrl
    expect(asks).toEqual(['Alt-click to ask', 'Ctrl-click to ask'])
  })
})
