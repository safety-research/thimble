// @vitest-environment jsdom
// The ask hint (src/pointer/CmdPointer.tsx AskHint): a plain click on something one can ask about (a card, a record, a
// passage) shows, once in this browser, a small hint beside the pointer with the ask key Settings picks, and the click
// goes on as it would; a field one types in, a drag, and a click with the ask key show none. A tester: "Try to click
// on a thing to ask question, it pops something else open. remember i have to control click".
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ASK_HINT_KEY, CmdPointer } from '../../src/pointer/CmdPointer.tsx'
import { setAskKey } from '../../src/lib/platform.ts'
import { mount, unmountAll } from './mount.tsx'

const tip = () => document.querySelector('.ask-hint')?.textContent ?? null

beforeEach(() => localStorage.clear())
afterEach(() => {
  unmountAll()
  setAskKey('meta')
})

async function page() {
  const el = await mount(
    <>
      <CmdPointer ws="ws" />
      <div data-anchor="card:c1">
        <p className="card-text">Edits per day</p>
        <input className="card-field" />
      </div>
      <p className="loose">no anchor here</p>
    </>,
  )
  return el
}

/** A press and its click at (x, y) on `el`, released at (x + dx, y); whether the click's default went on. */
async function click(el: Element, opts: { dx?: number; ctrlKey?: boolean } = {}) {
  let prevented = false
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100, ctrlKey: opts.ctrlKey }))
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100, ctrlKey: opts.ctrlKey }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100 + (opts.dx ?? 0), clientY: 100, ctrlKey: opts.ctrlKey }))
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: 100 + (opts.dx ?? 0), clientY: 100, ctrlKey: opts.ctrlKey })
    el.dispatchEvent(ev)
    prevented = ev.defaultPrevented
  })
  return { prevented }
}

describe('a plain click on something one can ask about', () => {
  test('shows the hint with the ask key once, and the click goes on', async () => {
    const el = await page()
    const text = el.querySelector('.card-text')!
    expect((await click(text)).prevented).toBe(false)
    expect(tip()).toBe('Ctrl-click to ask about this')
    expect(localStorage.getItem(ASK_HINT_KEY)).toBe('1')
    // the next press lets it go, and it does not show again
    await click(text)
    expect(tip()).toBeNull()
  })

  test('names the ask key Settings picks', async () => {
    setAskKey('alt')
    const el = await page()
    await click(el.querySelector('.card-text')!)
    expect(tip()).toBe('Alt-click to ask about this')
  })

  test('shows nothing for a field, a place with no anchor, or a drag', async () => {
    const el = await page()
    await click(el.querySelector('.card-field')!)
    await click(el.querySelector('.loose')!)
    await click(el.querySelector('.card-text')!, { dx: 40 })
    expect(tip()).toBeNull()
    expect(localStorage.getItem(ASK_HINT_KEY)).toBeNull()
  })
})
