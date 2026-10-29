// @vitest-environment jsdom
// The one tooltip for marks that name a value (src/components/Tooltip.tsx HoverTips, drawn once by the shell, by the
// rules of markTips): the mark under the pointer with `data-tip` (a record's labels and their values, a label's cell
// beside a record) shows its text under the pointer after a moment, as a control's tip does, at once when the pointer has
// just left a tip; the pointer leaving it or the page, a press, the ask key, a scroll or Escape takes the tip away. None
// shows while a button is held (a selection or a drag over the records) or while the ask key is held (the key Settings
// picks), the pointer still or moving: the key going down takes a tip away at once, and a tip waiting its moment with it.
// A tip taken away by a press, the ask key or Escape stays away from its mark until the pointer reaches another, which
// waits its moment. Where it stands is placeAtPointer's.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HoverTips, placeAtPointer, TIP_DELAY_MS, TIP_WARM_MS } from '../../src/components/Tooltip.tsx'
import { setAskKey } from '../../src/lib/platform.ts'
import { mount, unmountAll } from './mount.tsx'

// each test's clock starts a minute past the last one's, as a page's clock only goes on: a tip a test before took away
// never went "a moment ago"
let now = Date.now()
beforeEach(() => void vi.useFakeTimers({ now: (now += 60_000) }))
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

const tips = () => [...document.querySelectorAll<HTMLElement>('.tip')]
/** The modifier keys down with an event. */
type Mods = { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }
/** The pointer moved onto `el`, at (x, y), with `buttons` held (none by default) and the modifier keys `mods` down. */
const point = (el: Element, x = 120, y = 60, buttons = 0, mods: Mods = {}) => act(async () => void el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse', buttons, ...mods })))
/** The key `key` going down or up in the page, with the modifier keys `mods` down after it. */
const key = (type: 'keydown' | 'keyup', key: string, mods: Mods = {}) => act(async () => void document.body.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, ...mods })))
/** The ask key Settings picks by default, off a Mac as this page runs: ⌘ (the Windows or Super key) or Ctrl. */
const ASK = [
  { key: 'Meta', mods: { metaKey: true } },
  { key: 'Control', mods: { ctrlKey: true } },
] as const
/** A press of the main button on `el`. */
const press = (el: Element) => act(async () => void el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 60, pointerType: 'mouse', button: 0, buttons: 1 })))
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms))

/** A page with the page's one HoverTips, two records that name their label's value and one that names none. */
async function page() {
  const el = await mount(
    <>
      <HoverTips />
      <div className="reader-record" data-tip="what the step does: runs tests">
        <span className="words">12 passed, 66 deselected in 0.44s</span>
      </div>
      <div className="reader-record" data-tip={'what the step does: talks to other agents\n“REVIEW WANTED #118”'}>
        words
      </div>
      <div className="reader-record">words</div>
    </>,
  )
  return [...el.querySelectorAll('.reader-record')]
}

test('a mark names its value under the pointer after a moment, from a word inside it too, and the pointer leaving it takes the name away', async () => {
  const [tested, , plain] = await page()
  await point(tested.querySelector('.words')!)
  expect(tips()).toEqual([])
  await wait(TIP_DELAY_MS)
  expect(tips().map((t) => t.textContent)).toEqual(['what the step does: runs tests'])
  expect(tips()[0].getAttribute('role')).toBe('tooltip')
  // moving within the mark keeps it; onto a record that names nothing, it goes
  await point(tested, 140, 64)
  expect(tips()).toHaveLength(1)
  await point(plain)
  expect(tips()).toEqual([])
})

test('the next mark along shows its name at once, every line of it', async () => {
  const [tested, talked] = await page()
  await point(tested)
  await wait(TIP_DELAY_MS)
  await point(talked, 120, 90)
  expect(tips().map((t) => t.textContent)).toEqual(['what the step does: talks to other agents\n“REVIEW WANTED #118”'])
  expect(tips()[0].classList.contains('tip-lines')).toBe(true)
  // a while after the last one went, the next waits its moment again
  await point(document.body)
  await wait(TIP_WARM_MS + 50)
  await point(tested)
  expect(tips()).toEqual([])
  await wait(TIP_DELAY_MS)
  expect(tips()).toHaveLength(1)
})

test('a press, a scroll or Escape takes the name away', async () => {
  const [tested] = await page()
  for (const away of [
    () => tested.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })),
    () => window.dispatchEvent(new Event('scroll')),
    () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  ]) {
    await point(document.body)
    await wait(TIP_WARM_MS + 50)
    await point(tested)
    await wait(TIP_DELAY_MS)
    expect(tips()).toHaveLength(1)
    await act(async () => void away())
    expect(tips()).toEqual([])
  }
})

test('the pointer going out of the page takes the name away, and the mark it comes back to waits its moment; going out of an element into another does not', async () => {
  const [tested] = await page()
  await point(document.body)
  await wait(TIP_WARM_MS + 50)
  await point(tested)
  await wait(TIP_DELAY_MS)
  // out of the mark's words into the mark itself: an element to go to
  await act(async () => void tested.querySelector('.words')!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: tested })))
  expect(tips()).toHaveLength(1)
  // out of the page: no element to go to
  await act(async () => void tested.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' })))
  expect(tips()).toEqual([])
  await point(tested)
  expect(tips()).toEqual([])
  await wait(TIP_DELAY_MS)
  expect(tips()).toHaveLength(1)
})

test('a held button shows no name: across the marks while it is held, nor on the mark it was let go over, and the next mark waits its moment', async () => {
  const [tested, talked, plain] = await page()
  // the pointer rested on a mark, its name showing, then a press there and a drag across the records
  await point(document.body)
  await wait(TIP_WARM_MS + 50)
  await point(tested)
  await wait(TIP_DELAY_MS)
  expect(tips()).toHaveLength(1)
  await press(tested)
  expect(tips()).toEqual([])
  for (const [el, y] of [[tested, 64], [talked, 90], [plain, 120], [talked, 92]] as const) {
    await point(el, 140, y, 1)
    await wait(TIP_DELAY_MS + 50)
    expect(tips(), `held over ${el.textContent}`).toEqual([])
  }
  // let go over a mark: it shows none while the pointer stays on it
  await point(talked, 150, 94)
  await wait(TIP_DELAY_MS + 50)
  expect(tips()).toEqual([])
  // the next mark waits its moment: the press made nothing show at once
  await point(tested, 150, 60)
  expect(tips()).toEqual([])
  await wait(TIP_DELAY_MS)
  expect(tips().map((t) => t.textContent)).toEqual(['what the step does: runs tests'])
})

test('a press takes the name away from its mark until the pointer reaches another, which waits its moment; Escape too', async () => {
  const [tested, talked] = await page()
  for (const away of [() => press(tested), () => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))]) {
    await point(document.body)
    await wait(TIP_WARM_MS + 50)
    await point(tested)
    await wait(TIP_DELAY_MS)
    expect(tips()).toHaveLength(1)
    await away()
    expect(tips()).toEqual([])
    // moving on within the mark brings nothing back
    await point(tested, 160, 70)
    await wait(TIP_DELAY_MS + 50)
    expect(tips()).toEqual([])
    await point(talked, 160, 90)
    expect(tips()).toEqual([])
    await wait(TIP_DELAY_MS)
    expect(tips()).toHaveLength(1)
  }
})

test('while the ask key is held (the ⌘ pointer on), no name shows across the marks, nor on the mark it is let go over', async () => {
  const [tested, talked, plain] = await page()
  for (const ask of ASK) {
    await point(document.body)
    await wait(TIP_WARM_MS + 50)
    await point(tested)
    await wait(TIP_DELAY_MS)
    expect(tips(), ask.key).toHaveLength(1)
    await key('keydown', ask.key, ask.mods)
    for (const [el, y] of [[talked, 90], [plain, 120], [tested, 62], [talked, 92]] as const) {
      await point(el, 120, y, 0, ask.mods)
      await wait(TIP_DELAY_MS + 50)
      expect(tips(), `${ask.key} held over ${el.textContent}`).toEqual([])
    }
    await key('keyup', ask.key)
    await point(talked, 124, 94)
    await wait(TIP_DELAY_MS + 50)
    expect(tips(), `${ask.key} let go over a mark`).toEqual([])
  }
  // the key held as the pointer moves, though its key-down reached a frame and not the page
  await point(document.body)
  await wait(TIP_WARM_MS + 50)
  await point(tested, 120, 60, 0, { metaKey: true })
  await wait(TIP_DELAY_MS + 50)
  expect(tips(), 'the key held with no key-down').toEqual([])
})

test('the ask key going down takes the name away at once, the pointer still; let go, its mark shows none until the pointer reaches another, which waits its moment', async () => {
  const [tested, talked] = await page()
  for (const ask of ASK) {
    await point(document.body)
    await wait(TIP_WARM_MS + 50)
    await point(tested)
    await wait(TIP_DELAY_MS)
    expect(tips(), ask.key).toHaveLength(1)
    await key('keydown', ask.key, ask.mods)
    expect(tips(), `${ask.key} down`).toEqual([])
    await wait(TIP_DELAY_MS + 50)
    expect(tips(), `${ask.key} held`).toEqual([])
    await key('keyup', ask.key)
    await wait(TIP_DELAY_MS + 50)
    expect(tips(), `${ask.key} let go`).toEqual([])
    await point(tested, 150, 64)
    await wait(TIP_DELAY_MS + 50)
    expect(tips(), `${ask.key} let go, the pointer moving on its mark`).toEqual([])
    await point(talked, 150, 90)
    expect(tips()).toEqual([])
    await wait(TIP_DELAY_MS)
    expect(tips().map((t) => t.textContent)).toEqual([talked.getAttribute('data-tip')])
  }
})

test('the ask key pressed as the pointer stops on a mark: the name waiting its moment shows neither while the key is held nor once it is let go', async () => {
  const [tested] = await page()
  for (const ask of ASK) {
    await point(document.body)
    await wait(TIP_WARM_MS + 50)
    await point(tested)
    await wait(TIP_DELAY_MS / 2)
    await key('keydown', ask.key, ask.mods)
    await wait(TIP_DELAY_MS * 3)
    expect(tips(), `${ask.key} held`).toEqual([])
    await key('keyup', ask.key)
    await wait(TIP_DELAY_MS + 50)
    expect(tips(), `${ask.key} let go`).toEqual([])
  }
})

test('the ask key is the one Settings picks: with ⌥ picked, ⌥ takes the name away and ⌘ does not', async () => {
  const [tested, talked] = await page()
  setAskKey('alt')
  try {
    await point(tested)
    await wait(TIP_DELAY_MS)
    await key('keydown', 'Meta', { metaKey: true })
    await point(tested, 124, 62, 0, { metaKey: true })
    expect(tips().map((t) => t.textContent), '⌘ is not the ask key').toEqual([tested.getAttribute('data-tip')])
    await key('keyup', 'Meta')
    await key('keydown', 'Alt', { altKey: true })
    expect(tips(), '⌥ down').toEqual([])
    await point(talked, 120, 90, 0, { altKey: true })
    await wait(TIP_DELAY_MS + 50)
    expect(tips(), '⌥ held').toEqual([])
    await key('keyup', 'Alt')
  } finally {
    setAskKey('meta')
  }
})

test('on a Mac the ask key is ⌘ alone: Ctrl, whose click opens the context menu there, leaves the name', async () => {
  const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')
  Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true })
  try {
    const [tested] = await page()
    await point(tested)
    await wait(TIP_DELAY_MS)
    await key('keydown', 'Control', { ctrlKey: true })
    await point(tested, 124, 62, 0, { ctrlKey: true })
    expect(tips().map((t) => t.textContent), 'Ctrl held').toEqual([tested.getAttribute('data-tip')])
    await key('keyup', 'Control')
    await key('keydown', 'Meta', { metaKey: true })
    expect(tips(), '⌘ down').toEqual([])
    await key('keyup', 'Meta')
  } finally {
    if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform)
  }
})

test('the name stands just under the pointer, from its left, and over it where there is no room below', () => {
  expect(placeAtPointer(100, 50, 200, 24, 1440, 900)).toEqual({ left: 100, top: 70 })
  // kept inside the window at the right and at the bottom
  expect(placeAtPointer(1400, 50, 200, 24, 1440, 900)).toEqual({ left: 1232, top: 70 })
  expect(placeAtPointer(100, 880, 200, 24, 1440, 900)).toEqual({ left: 100, top: 850 })
})
