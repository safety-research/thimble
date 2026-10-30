// @vitest-environment jsdom
// The chip of a line of a card's printed output names it as a line of the card's output, as the tour's example card
// does (src/tour/examples.json pops): on the card, `card output line 8`; elsewhere, after the card's name
// (src/lib/refs.ts cardPartLabel, src/components/RefChip.tsx chipLabel). A click on it shows the line in the card's output
// (cite-open.test.tsx). The label an underlined value of such a line opens is headed the same way, the card's title
// where the chip names the card (src/marks/Mark.tsx CardEvidence).
import { act } from 'react'
import { beforeAll, afterEach, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { chipLabel, compactLabel, spanWhere } from '../../src/components/RefChip.tsx'
import { api } from '../../src/lib/api.ts'
import { registerCells } from '../../src/lib/cellName.ts'
import { refLabel } from '../../src/lib/refs.ts'
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

test("a card's citation of a line of its printed output names it as a line of the card's output", async () => {
  // the card's takeaway, drawn in the card (its citations' home), cites a line and two lines of its printed output
  const el = await mount(
    <div data-cite-home="ab12cd34">
      <ChatMarkdown text="The rollback began at 08:28 [[card:ab12cd34@out0#L8]] and ended at 08:41 [[card:ab12cd34@out0#L8-L9]]." />
    </div>,
  )
  await settle()
  const chips = [...el.querySelectorAll<HTMLElement>('[data-ref]')]
  expect(chips.map((c) => c.dataset.ref)).toEqual(['card:ab12cd34@out0#L8', 'card:ab12cd34@out0#L8-L9'])
  expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['card output line 8', 'card output lines 8–9'])
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

test("outside its card the chip names the card, then the line of its output", () => {
  expect(chipLabel('card:ab12cd34@out0#L8')).toBe('payments-release · card output line 8')
  expect(chipLabel('card:ab12cd34@out1#L8-L9', 'another1')).toBe('payments-release · card output lines 8–9')
})

test("every other place that names a line of a card's output names it as the chip does: a ref's short label, a chip in the editor and the hover's place", () => {
  for (const out of [0, 1]) {
    expect(refLabel(`card:ab12cd34@out${out}#L8`)).toBe('card output line 8')
    expect(compactLabel(`card:ab12cd34@out${out}#L8-L9`)).toBe('payments-release · card output lines 8–9')
    expect(spanWhere(`card:ab12cd34@out${out}#L8`)).toBe('card output line 8')
  }
})

/** The card as the server reads it for a line of its printed output: its title, the lines around the cited one. */
const CITED_LINE = '2026-05-16 08:04  Database full; scaler starts adding replicas'
const CARD = {
  excerpt: ['2026-05-16 07:52  First outage ticket', '2026-05-16 08:02  INC-312 opens', CITED_LINE, '2026-05-16 08:15  Paged engineer acknowledges'].join('\n'),
  meta: { title: 'When did the payments release go out?', span: { text: CITED_LINE } },
}

/** The head of the label that the underlined value of `text` (`[[value|ref]]`) opens on a click, drawn in the card
 * `home` (its takeaway), or outside every card (a chat reply) when `home` is null. */
async function markHead(text: string, home: string | null): Promise<string | null | undefined> {
  const was = api.resolveRef
  api.resolveRef = (async () => CARD) as unknown as typeof api.resolveRef
  try {
    unmountAll()
    const md = <ChatMarkdown text={text} />
    const el = await mount(home ? <div data-cite-home={home}>{md}</div> : md)
    await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    return document.querySelector('.mark-pop .refchip-pop-head .chip-text')?.textContent
  } finally {
    api.resolveRef = was
  }
}

test("a real card's underlined value of a line of its printed output heads its label as the chip names the line", async () => {
  const ref = 'card:ab12cd34@out0#L8'
  // on the card: the line of its output, as the chip on the card names it
  const own = await markHead(`The database filled at [[08:04|${ref}]].`, 'ab12cd34')
  expect(own).toBe('card output line 8')
  expect(own).toBe(chipLabel(ref, 'ab12cd34'))
  // outside it: the card's title where the chip names the card, then the line
  expect(await markHead(`The database filled at [[08:04|${ref}]].`, null)).toBe('When did the payments release go out? · card output line 8')
  expect(await markHead(`The outage ran [[08:04 to 08:15|card:ab12cd34@out0#L8-L9]].`, null)).toBe('When did the payments release go out? · card output lines 8–9')
})

test("a real card's underlined value names a line as the tour's demo names it", async () => {
  for (const [ref, markup] of Object.entries(snaps.pops as Record<string, string>)) {
    const d = document.createElement('div')
    d.innerHTML = markup
    const home = ref.slice('card:'.length, ref.indexOf('@'))
    expect(await markHead(`The database filled at [[08:04|${ref}]].`, home), ref).toBe(d.querySelector('.refchip-pop-head .chip-text')?.textContent)
  }
})
