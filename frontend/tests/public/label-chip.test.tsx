// @vitest-environment jsdom
// A label's chip in the chat (src/chat/SurfaceChips.tsx LabelChip) is drawn as a view's chip, as a document's and a
// canvas group's chip are: the same outlined accent chip, with the label glyph, and a click that opens the label. A
// view's list of its labels keeps each label's row in the Labels pane (LabelRowChip), in the label's color.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DocChip, LabelChip, LabelRowChip } from '../../src/chat/SurfaceChips.tsx'
import { mount, unmountAll } from './mount.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('a label chip', () => {
  test("in the chat is a view's chip with the label glyph, as a document's chip is, and its click opens the label", async () => {
    const onClick = vi.fn()
    const el = await mount(
      <>
        <DocChip ws="mini" slug="report" />
        <LabelChip name="refusal" onClick={onClick} />
      </>,
    )
    const doc = el.querySelector('[data-doc="report"]')!
    const chip = el.querySelector<HTMLButtonElement>('button[data-label="refusal"]')!
    expect(chip.classList.contains('view-tab')).toBe(true)
    expect(doc.classList.contains('view-tab')).toBe(true)
    expect(chip.classList.contains('surface-chip')).toBe(false)
    expect(chip.querySelector('svg.icon-label.view-tab-ico')).not.toBeNull()
    expect(chip.querySelector('.view-tab-name')?.textContent).toBe('refusal')
    expect(chip.getAttribute('style')).toBeNull()
    await act(async () => chip.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  test("in a view's list of its labels keeps the label's row in the Labels pane, in its color", async () => {
    const el = await mount(<LabelRowChip ws="mini" name="refusal" />)
    const row = el.querySelector('[data-label="refusal"]')!
    expect(row.classList.contains('surface-chip')).toBe(true)
    expect(row.classList.contains('label-row-chip')).toBe(true)
    expect(row.classList.contains('view-tab')).toBe(false)
    expect(row.querySelector('.label-row-chip-box')).not.toBeNull()
    expect((row as HTMLElement).style.getPropertyValue('--c')).toBe('var(--label-none)')
  })
})
