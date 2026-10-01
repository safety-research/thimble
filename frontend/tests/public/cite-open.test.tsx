// @vitest-environment jsdom
// A click on a citation opens what it cites, and so does a click on the chip that heads its hover label
// (src/components/RefChip.tsx). A citation of lines of a card's printed output finds them where the output is drawn: each
// line carries the output line it stands for (src/components/Outputs.tsx OutputText), counted as the refs count them
// past a bounded stream's marker, and the reveal marks them (src/lib/tableCell.ts revealLines).
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { lineOmitted, Output, OutputText, storedLineNumber } from '../../src/components/Outputs.tsx'
import { RefChip } from '../../src/components/RefChip.tsx'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import { CITED_FLASH, revealLines } from '../../src/lib/tableCell.ts'
import type { MimeBundle, OutputTruncation, ResolvedRef } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  // the hover label places itself as it resizes; jsdom has no ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

// a bounded stream of 12 lines that kept 3 from the start and 2 from the end (backend notebook._bound_stream)
const BOUNDED: OutputTruncation = { total_lines: 12, kept_head: 3, kept_tail: 2, path: 'notebooks/outputs/c1-0.txt' }
const lineNumbers = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-line]')].map((s) => Number(s.dataset.line))

describe('the lines of a printed output', () => {
  test('are numbered as the refs number them, past a bounded stream\'s marker from the end of the complete text', () => {
    expect([0, 1, 2].map((i) => storedLineNumber(i))).toEqual([1, 2, 3])
    expect([0, 1, 2, 3, 4, 5].map((i) => storedLineNumber(i, BOUNDED))).toEqual([1, 2, 3, null, 11, 12])
    expect([3, 4, 10, 11, 12].map((n) => lineOmitted(BOUNDED, n))).toEqual([false, true, true, false, false])
    expect(lineOmitted(null, 7)).toBe(false)
  })

  test('read as printed, each in a span that names its line; a capped output numbers only what it shows', async () => {
    const el = await mount(<pre>{<OutputText text={'a\nb\nc\n'} />}</pre>)
    expect(el.textContent).toBe('a\nb\nc\n')
    expect(lineNumbers(el)).toEqual([1, 2, 3])
    const capped = await mount(<pre>{<OutputText text={'a\nb\nc\nd'} max={2} />}</pre>)
    expect(capped.textContent).toBe('a\nb\n…')
    expect(lineNumbers(capped)).toEqual([1, 2])
    const kept = await mount(<pre>{<OutputText text={'h1\nh2\nh3\n… 7 lines omitted; full output kept …\nt11\nt12\n'} truncated={BOUNDED} />}</pre>)
    expect(lineNumbers(kept)).toEqual([1, 2, 3, 11, 12])
    expect(kept.querySelector('[data-line="11"]')?.textContent).toBe('t11')
  })

  test('a citation of them marks the cited lines where the output is drawn, and finds nothing where it is not', async () => {
    const stream = { 'text/plain': 'step 1\nstep 2\nstep 3\nstep 4\n', _stream: 'stdout' } as MimeBundle
    const el = await mount(<Output bundle={stream} maxLines={24} />)
    const first = revealLines(el, 2, 3, el)
    expect(first?.textContent).toBe('step 2')
    expect([...el.querySelectorAll(`.${CITED_FLASH}`)].map((s) => s.textContent)).toEqual(['step 2', 'step 3'])
    expect(revealLines(el, 9, undefined, el)).toBeNull()
  })
})

describe('the chip that heads a citation\'s hover label', () => {
  /** The citation `ref` shown as `value`, hovered (focused) until its label opens; the label's head chip. */
  async function hovered(ref: string, value: string): Promise<HTMLElement> {
    const el = await mount(<RefChip ref={ref} value={value} workspace="ws" cite />)
    const cite = el.querySelector<HTMLElement>('.refchip')!
    await act(async () => {
      cite.focus()
      await new Promise((r) => setTimeout(r, 200))
    })
    const chip = document.body.querySelector<HTMLElement>('.refchip-pop .refchip-pop-chip')
    expect(chip).not.toBeNull()
    return chip!
  }
  const opened = () => {
    const refs: string[] = []
    const off = bus.on('openRef', (e) => void refs.push(e.ref))
    return { refs, off }
  }

  test('opens the lines of a card\'s output it names, as the citation does', async () => {
    vi.spyOn(api, 'cellNames').mockResolvedValue([])
    const ref = 'card:c1@out0#L2'
    vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref, kind: 'cell', excerpt: 'agents (51)\nagents (46)\nrooms (16)', meta: { span: { out: 0, line: 2, text: 'agents (46)' } } } as unknown as ResolvedRef)
    const chip = await hovered(ref, '46')
    expect(document.body.querySelector('.refchip-lines')?.textContent).toContain('agents (46)')
    expect(chip.tagName).toBe('BUTTON')
    const seen = opened()
    await act(async () => chip.click())
    seen.off()
    expect(seen.refs).toEqual([ref])
    expect(document.body.querySelector('.refchip-pop')).toBeNull()
  })

  test('opens a record of a file, a report and a view, as their citations do', async () => {
    vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: 'logs/a.jsonl#L4', kind: 'record', excerpt: 'the record' } as unknown as ResolvedRef)
    for (const ref of ['logs/a.jsonl#L4', 'report:findings', 'view:pdf']) {
      const chip = await hovered(ref, 'this')
      const seen = opened()
      await act(async () => chip.click())
      seen.off()
      expect(seen.refs, ref).toEqual([ref])
      unmountAll()
    }
  })
})
