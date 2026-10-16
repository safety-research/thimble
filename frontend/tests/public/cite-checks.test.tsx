// @vitest-environment jsdom
// A citation looks the same on every surface while thimble checks it (src/lib/citeChecks.ts, src/components/RefChip.tsx):
// purple and underlined, a small spinner after it while it is checked, nothing once verified, red with × when it failed.
// A citation the check rewrote in place looks verified, and a click on it shows what Claude wrote, what the check made
// it and why, the chip that heads its label still opening the place. A card's takeaway reads its states from the card's
// links check, a document's sentence from its healing pass.
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CiteChecksContext, RefChip } from '../../src/components/RefChip.tsx'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import { cardChecks, checkOf, correctedValue, healChecks, mergeChecks, type CiteChecks } from '../../src/lib/citeChecks.ts'
import type { Cell, HealChange, ResolvedRef } from '../../src/lib/types.ts'
import { Prose } from '../../src/report/Prose.tsx'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
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

const ROW = 'card:c1#prs/merged'
const LINE = 'logs/a.jsonl#L4'

describe("a card's links check", () => {
  test('while it runs, every citation of the takeaway is checking', () => {
    const c = cardChecks({ links: { status: 'pending', checked: false, resolved: [{ value: '212', ref: ROW }] } })
    expect(checkOf(c, ROW, '212')?.state).toBe('checking')
    expect(checkOf(c, LINE)?.state).toBe('checking')
  })

  test('once it ends: linked is verified, re-pointed or rewritten is corrected with its revision, the rest failed', () => {
    const c = cardChecks({
      links: {
        status: 'ok',
        checked: true,
        resolved: [
          { value: '212', ref: ROW, tier: 2 },
          { value: '96', ref: 'card:c1#prs/closed', how: 'cell', from: 'card:c1#share/closed' },
        ],
        broken: [
          { value: '37', ref: 'card:c1#prs/open', why: 'the cited place shows 37', was: '35', corrected: true },
          { value: '44', ref: 'card:c1#prs/draft', why: 'the cited place shows 41' },
        ],
        quiet: [{ value: null, ref: 'NOTES.md', why: 'does not resolve' }],
        typed: [{ value: '12', ref: 'card:c1@out0#L3', why: 'typed in the code, line 3, not computed' }],
      },
    })
    expect(checkOf(c, ROW, '212')).toEqual({ state: 'ok' })
    expect(checkOf(c, 'cell:c1#prs/closed', '96')).toEqual({ state: 'corrected', history: [{ wrote: { value: '96', ref: 'card:c1#share/closed' }, now: { value: '96', ref: 'card:c1#prs/closed' }, why: 'the value is at another place in the cited card' }] })
    expect(checkOf(c, 'card:c1#prs/open', '37')?.history?.[0]).toEqual({ wrote: { value: '35', ref: 'card:c1#prs/open' }, now: { value: '37', ref: 'card:c1#prs/open' }, why: 'the cited place shows 37' })
    expect(checkOf(c, 'card:c1#prs/draft', '44')).toEqual({ state: 'failed', why: 'the cited place shows 41' })
    expect(checkOf(c, 'NOTES.md')).toEqual({ state: 'failed', why: 'does not resolve' })
    expect(checkOf(c, 'card:c1@out0#L3', '12')?.state).toBe('failed')
    // a citation the record does not list is drawn as verified
    expect(checkOf(c, LINE, '3')).toBeNull()
  })

  test('a check that could not finish fails what it did not link; no record is no state', () => {
    const c = cardChecks({ note: 'the links job timed out', links: { status: 'failed', checked: false, resolved: [{ value: '212', ref: ROW }] } })
    expect(checkOf(c, ROW, '212')?.state).toBe('ok')
    expect(checkOf(c, LINE, '3')).toEqual({ state: 'failed', why: 'the links job timed out' })
    expect(cardChecks(undefined)).toBeNull()
    expect(cardChecks({ links: null })).toBeNull()
  })
})

describe("a document sentence's healing pass", () => {
  test('re-pointed and rewritten values are corrected, contradicted and homeless ones failed, unwrapped ones gone', () => {
    const healed: HealChange[] = [
      { value: '96', ref: 'card:c1#share/closed', state: 'linked', how: 'cited', to: 'card:c2#prs/closed' },
      { value: '35 PRs', ref: 'card:c1#prs/open', state: 'contradicted', how: 'contradicted', to: 'card:c1#prs/open', source: '37', was: '35 PRs', corrected: true, why: 'the cited place shows 37' },
      { value: '44', ref: 'card:c1#prs/draft', state: 'contradicted', how: 'contradicted', to: 'card:c1#prs/draft', source: '41', why: 'the cited place shows 41' },
      { value: '9', ref: 'card:c9#x/y', state: 'quiet', how: 'no_home', why: 'no output shows this value' },
    ]
    const c = healChecks(healed)
    expect(checkOf(c, 'card:c2#prs/closed', '96')?.history?.[0].why).toBe('the value is in another card the text cites')
    expect(checkOf(c, 'card:c1#prs/open', '37 PRs')?.history?.[0]).toEqual({ wrote: { value: '35 PRs', ref: 'card:c1#prs/open' }, now: { value: '37 PRs', ref: 'card:c1#prs/open' }, why: 'the cited place shows 37' })
    expect(checkOf(c, 'card:c1#prs/draft', '44')?.state).toBe('failed')
    expect(checkOf(c, 'card:c9#x/y', '9')).toBeNull()
    expect(healChecks([])).toBeNull()
    expect(checkOf(mergeChecks([c, null]), 'card:c1#prs/draft', '44')?.state).toBe('failed')
  })

  test('a rewritten value takes the number its place shows, as the backend writes it', () => {
    expect(correctedValue('35', '37')).toBe('37')
    expect(correctedValue('35 PRs', '37')).toBe('37 PRs')
    expect(correctedValue('35%', '37')).toBeNull()
    expect(correctedValue('35 of 40', '37')).toBeNull()
  })
})

/** A citation drawn under `checks`; its element and what follows it. */
async function drawn(checks: CiteChecks | null, ref = LINE, value: string | null = '3') {
  const el = await mount(
    <CiteChecksContext.Provider value={checks}>
      <p>
        <RefChip ref={ref} value={value ?? undefined} workspace="ws" cite />
      </p>
    </CiteChecksContext.Provider>,
  )
  return { el, cite: el.querySelector<HTMLElement>('[data-ref]')! }
}
const one = (ref: string, value: string | undefined, c: CiteChecks['rest']): CiteChecks => ({ byKey: new Map([[`${value ?? ''}\u0000${ref}`, c!]]) })

describe('a citation as it is drawn', () => {
  test('verified or never checked: the link alone, with no mark after it', async () => {
    const { el, cite } = await drawn(null)
    expect(cite.classList.contains('refchip-value')).toBe(true)
    expect(cite.classList.contains('broken')).toBe(false)
    expect(el.querySelector('.refchip-mark')).toBeNull()
    expect(el.textContent).toBe('3')
  })

  test('while it is checked: a small spinner right after it, gone once it is verified', async () => {
    const { el, cite } = await drawn({ byKey: new Map(), rest: { state: 'checking' } })
    expect(cite.classList.contains('refchip-checking')).toBe(true)
    expect(cite.nextElementSibling?.classList.contains('spinner')).toBe(true)
    expect(el.querySelector('.refchip-x')).toBeNull()
    unmountAll()
    const done = await drawn(one(LINE, '3', { state: 'ok' }))
    expect(done.el.querySelector('.spinner')).toBeNull()
  })

  test('failed: red with × after it, and its hover says why', async () => {
    const { el, cite } = await drawn(one(LINE, '3', { state: 'failed', why: 'the cited place shows 4' }))
    expect(cite.classList.contains('broken')).toBe(true)
    expect(cite.nextElementSibling?.textContent).toBe('×')
    expect(el.querySelector('.spinner')).toBeNull()
    await act(async () => {
      cite.focus()
      await new Promise((r) => setTimeout(r, 200))
    })
    const pop = document.body.querySelector('.refchip-pop')
    expect(pop?.textContent).toContain('Unable to verify')
    expect(pop?.textContent).toContain('the cited place shows 4')
  })

  test('a bare citation that failed is the red chip with its × glyph, nothing after it', async () => {
    const { el, cite } = await drawn(one('NOTES.md', undefined, { state: 'failed', why: 'does not resolve' }), 'NOTES.md', null)
    expect(cite.classList.contains('broken')).toBe(true)
    expect(cite.querySelector('svg.icon-x')).not.toBeNull()
    expect(el.querySelector('.refchip-mark')).toBeNull()
  })

  test('the checks are for citations only: a ref chip that lists what a step made shows none', async () => {
    const el = await mount(
      <CiteChecksContext.Provider value={{ byKey: new Map(), rest: { state: 'checking' } }}>
        <RefChip ref={LINE} workspace="ws" />
      </CiteChecksContext.Provider>,
    )
    expect(el.querySelector('.spinner')).toBeNull()
  })
})

describe('a citation the check rewrote in place', () => {
  const CORRECTED = one(LINE, '3', { state: 'corrected', history: [{ wrote: { value: '5', ref: LINE }, now: { value: '3', ref: LINE }, why: 'the cited place shows 3' }] })

  test('looks verified; its hover shows no revision', async () => {
    vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: LINE, kind: 'record', excerpt: 'the record' } as unknown as ResolvedRef)
    const { el, cite } = await drawn(CORRECTED)
    expect(cite.classList.contains('broken')).toBe(false)
    expect(el.querySelector('.refchip-mark')).toBeNull()
    await act(async () => {
      cite.focus()
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(document.body.querySelector('.refchip-pop')).not.toBeNull()
    expect(document.body.querySelector('.refchip-history')).toBeNull()
  })

  test('a click shows what Claude wrote, what the check made it and why, and stays; its head chip opens the place', async () => {
    vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: LINE, kind: 'record', excerpt: 'the record' } as unknown as ResolvedRef)
    const refs: string[] = []
    const off = bus.on('openRef', (e) => void refs.push(e.ref))
    const { cite } = await drawn(CORRECTED)
    await act(async () => {
      cite.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(refs).toEqual([])
    const history = document.body.querySelector<HTMLElement>('.refchip-pop .refchip-history')
    expect(history).not.toBeNull()
    const rows = [...history!.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
    expect(rows).toEqual([
      ['Claude wrote', '5 · logs › a.jsonl L4'],
      ['The check made it', '3 · logs › a.jsonl L4'],
      ['Why', 'the cited place shows 3'],
    ])
    // leaving the citation keeps the label a click opened
    await act(async () => {
      cite.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 250))
    })
    expect(document.body.querySelector('.refchip-history')).not.toBeNull()
    const head = document.body.querySelector<HTMLElement>('.refchip-pop .refchip-pop-chip')!
    await act(async () => head.click())
    off()
    expect(refs).toEqual([LINE])
    expect(document.body.querySelector('.refchip-pop')).toBeNull()
  })

  test('Escape closes the label a click opened', async () => {
    vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: LINE, kind: 'record', excerpt: 'the record' } as unknown as ResolvedRef)
    const { cite } = await drawn(CORRECTED)
    await act(async () => cite.click())
    expect(document.body.querySelector('.refchip-history')).not.toBeNull()
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.body.querySelector('.refchip-pop')).toBeNull()
  })
})

describe('the surfaces that carry the checks', () => {
  const take = `agent-03 merged [[12|${ROW}]] PRs.`
  const face = (verification: unknown) =>
    mount(
      <CardFace
        cell={{ id: 'c1', kind: 'note', title: 'Who merged most?', takeaway: take, created_by: 'model', ts: '2026-10-06T00:00:00Z', payload: { text: 'x' }, status: 'ok', verification } as unknown as Cell}
        width={400}
        label={{ concept: null, error: null, reload: async () => undefined, set: () => undefined }}
      />,
    )

  test("a card's takeaway: a spinner while its links check runs, red with × for a value its place contradicts", async () => {
    vi.spyOn(api, 'cellNames').mockResolvedValue([])
    const running = await face({ links: { status: 'pending', checked: false, resolved: [] } })
    expect(running.querySelector('.bcell-take .refchip-value + .spinner')).not.toBeNull()
    unmountAll()
    const failed = await face({ links: { status: 'ok', checked: true, broken: [{ value: '12', ref: ROW, why: 'the cited place shows 11' }] } })
    expect(failed.querySelector('.bcell-take .refchip-value.broken + .refchip-x')).not.toBeNull()
    unmountAll()
    const done = await face({ links: { status: 'ok', checked: true, resolved: [{ value: '12', ref: ROW }] } })
    expect(done.querySelector('.bcell-take .refchip-mark')).toBeNull()
  })

  test("a document's sentence: its own healing record", async () => {
    const el = await mount(
      <Prose
        ws="ws"
        slug="report"
        sentences={[
          { id: 's1', text: `Agents merged [[44|card:c1#prs/draft]] drafts.`, refs: [], tags: [], healed: [{ value: '44', ref: 'card:c1#prs/draft', state: 'contradicted', how: 'contradicted', to: 'card:c1#prs/draft', why: 'the cited place shows 41' }] },
          { id: 's2', text: `And [[44|card:c1#prs/draft]] again.`, refs: [], tags: [] },
        ]}
      />,
    )
    const [first, second] = [...el.querySelectorAll<HTMLElement>('[data-sid]')]
    expect(first.querySelector('.refchip-value.broken + .refchip-x')).not.toBeNull()
    expect(second.querySelector('.refchip-mark')).toBeNull()
  })
})
