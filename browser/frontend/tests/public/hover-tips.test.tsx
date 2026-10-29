// @vitest-environment jsdom
// The one tooltip for marks that name a value (src/components/Tooltip.tsx HoverTips, drawn once by the shell, by the
// rules of markTips): the mark under the pointer with `data-tip` (a record's labels and their values, a label's cell
// beside a record) shows its text under the pointer after a moment, as a control's tip does, at once when the pointer has
// just left a tip; the pointer leaving it, a press, a scroll or Escape takes the tip away. None shows while a button is
// held (a selection or a drag over the records) or while the ask key is held, and a tip taken away by a press or Escape
// stays away from its mark until the pointer reaches another, which waits its moment. Where it stands is
// placeAtPointer's.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HoverTips, placeAtPointer, TIP_DELAY_MS, TIP_WARM_MS } from '../../src/components/Tooltip.tsx'
import { mount, unmountAll } from './mount.tsx'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

const tips = () => [...document.querySelectorAll<HTMLElement>('.tip')]
/** The pointer moved onto `el`, at (x, y), with `buttons` held (none by default). */
const point = (el: Element, x = 120, y = 60, buttons = 0) => act(async () => void el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse', buttons })))
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

test('while the ask key is held (the ⌘ pointer on), no name shows', async () => {
  const [tested, talked] = await page()
  await point(tested)
  await wait(TIP_DELAY_MS)
  expect(tips()).toHaveLength(1)
  document.body.setAttribute('data-cmd', '1')
  try {
    await point(talked, 120, 90)
    await wait(TIP_DELAY_MS + 50)
    expect(tips()).toEqual([])
  } finally {
    document.body.removeAttribute('data-cmd')
  }
})

test('the name stands just under the pointer, from its left, and over it where there is no room below', () => {
  expect(placeAtPointer(100, 50, 200, 24, 1440, 900)).toEqual({ left: 100, top: 70 })
  // kept inside the window at the right and at the bottom
  expect(placeAtPointer(1400, 50, 200, 24, 1440, 900)).toEqual({ left: 1232, top: 70 })
  expect(placeAtPointer(100, 880, 200, 24, 1440, 900)).toEqual({ left: 100, top: 850 })
})
