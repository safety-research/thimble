// @vitest-environment jsdom
// The chip of a line of a card's printed output names what the line is a line of, as the tour's example card does
// (src/tour/examples.json pops): on the card, `printed output · line 8`; elsewhere, after the card's name
// (src/lib/refs.ts cardPartLabel, src/components/RefChip.tsx chipLabel).
import { beforeAll, afterEach, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { chipLabel } from '../../src/components/RefChip.tsx'
import { registerCells } from '../../src/lib/cellName.ts'
import snaps from '../../src/tour/examples.json'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  registerCells([{ id: 'ab12cd34', title: 'When did the payments release go out?', slug: 'payments-release' }])
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => unmountAll())

test("a card's citation of a line of its printed output names the printed output", async () => {
  // the card's takeaway, drawn in the card (its citations' home), cites a line and two lines of its printed output
  const el = await mount(
    <div data-cite-home="ab12cd34">
      <ChatMarkdown text="The rollback began at 08:28 [[card:ab12cd34@out0#L8]] and ended at 08:41 [[card:ab12cd34@out0#L8-L9]]." />
    </div>,
  )
  await settle()
  const chips = [...el.querySelectorAll<HTMLElement>('[data-ref]')]
  expect(chips.map((c) => c.dataset.ref)).toEqual(['card:ab12cd34@out0#L8', 'card:ab12cd34@out0#L8-L9'])
  expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['printed output · line 8', 'printed output · lines 8–9'])
})

test("the real chip names a line as the tour's demo names it", () => {
  const demo = Object.entries(snaps.pops as Record<string, string>)
  expect(demo.length).toBeGreaterThan(0)
  for (const [ref, markup] of demo) {
    const d = document.createElement('div')
    d.innerHTML = markup
    const home = ref.slice('card:'.length, ref.indexOf('@'))
    expect(chipLabel(ref, home), ref).toBe(d.querySelector('.refchip-pop-head .chip-text')?.textContent)
  }
})

test("outside its card the chip names the card, then the printed output's line", () => {
  expect(chipLabel('card:ab12cd34@out0#L8')).toBe('payments-release · printed output · line 8')
  expect(chipLabel('card:ab12cd34@out1#L8-L9', 'another1')).toBe('payments-release · printed output · lines 8–9')
})
