// @vitest-environment jsdom
// A chat reply's citation of a card is the card's chip, its glyph and its name, as the chat's step rows draw the cards
// a step made, and a click on it opens the card (src/components/RefChip.tsx CardChipCites, src/chat/Rows.tsx); never
// the terminal's `[ card:<name> ]` and never the card's glyph alone. A card's own text keeps the glyph, a cited number
// stays the link's text, and a citation that failed is red with ×. Matt 2026-10-17: "chat citations render with
// brackets and not as a chip". No ✓ marks a verified state anywhere: the report's card list shows none for a card the
// page already holds (src/report/Sidebar.tsx), and the Citation marks setting names none
// (src/shell/SettingsPopover.tsx).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import { CardChipCites, CardQuestions, GlyphCites, RefChip, cardCiteLabel } from '../../src/components/RefChip.tsx'
import { bus } from '../../src/lib/bus.ts'
import { cutQuestion, registerCells } from '../../src/lib/cellName.ts'
import type { Cell, ChatRecord, Group } from '../../src/lib/types.ts'
import { useChecks } from '../../src/report/Checks.tsx'
import { Sidebar } from '../../src/report/Sidebar.tsx'
import { FEATURE_ROWS } from '../../src/shell/SettingsPopover.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

let errors: string[] = []

beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  // a chip may look up its card's name; nothing answers
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function reply(text: string): Promise<HTMLElement> {
  const rows = foldRecords([{ type: 'text', delta: text }, { type: 'done', ts: '2026-10-16T21:40:00Z', session_id: 's' }] as unknown as ChatRecord[])
  const el = await mount(
    <ThreadsContext.Provider value={{ labels: new Map() }}>
      <Rows rows={rows} ws="w" streaming={false} />
    </ThreadsContext.Provider>,
  )
  await settle()
  return el
}

const cites = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.chat-text .refchip')]
const names = (el: HTMLElement) => cites(el).map((c) => c.querySelector('.chip-text')?.textContent ?? null)

describe("a chat reply's citation of a card", () => {
  test("is the card's chip with its glyph and name, as a step row draws the card, never brackets or the glyph alone", async () => {
    registerCells([{ id: 'c0ffee00', title: 'Which wikis have the most revisions?', slug: 'wikis-most-revisions' }])
    const el = await reply('Most records are messages [[card:page-saves-wiki]]. The wikis differ [[card:c0ffee00]]; an older card [[card:ab12cd34]]. It printed this [[card:page-saves-wiki@out0#L1-L3]].')
    // a card the chat knows is named by its question (bug hunt G11), one it does not know yet by its id
    expect(names(el)).toEqual(['page-saves-wiki', 'Which wikis have the most revisions?', 'card', 'page-saves-wiki · lines 1–3'])
    const step = await mount(
      <CardQuestions.Provider value={true}>
        <RefChip ref="card:page-saves-wiki" compact workspace="w" />
      </CardQuestions.Provider>,
    )
    const stepChip = step.querySelector<HTMLElement>('[data-ref]')!
    const shared = (c: HTMLElement) => [...c.classList].filter((k) => k !== 'refchip-citation').sort()
    // a whole card's is the accent chip a step row draws; its printed lines' the evidence chip, as lines of data are
    for (const c of cites(el).slice(0, 3)) expect(shared(c)).toEqual(shared(stepChip))
    expect(cites(el)[3].classList.contains('chip-tone-evidence')).toBe(true)
    for (const c of cites(el)) {
      expect(c.classList.contains('chip')).toBe(true)
      expect(c.classList.contains('refchip-citation')).toBe(true)
      expect(c.querySelector('.chip-ico')?.innerHTML).toBe(stepChip.querySelector('.chip-ico')?.innerHTML)
      expect(c.textContent).not.toContain('[')
      expect(c.getAttribute('aria-label')).toBeNull()
    }
    expect(cites(el)[0].getAttribute('data-ref')).toBe('card:page-saves-wiki')
    // a cited number stays the link's text
    const valued = await reply('There are [[3|card:page-saves-wiki#agents/total]] agents.')
    const value = valued.querySelector<HTMLElement>('.chat-text .refchip')!
    expect(value.classList.contains('refchip-value')).toBe(true)
    expect(value.classList.contains('chip')).toBe(false)
    expect(value.textContent).toBe('3')
    expect(errors).toEqual([])
  })

  test('a click on it opens the card', async () => {
    const el = await reply('See [[card:page-saves-wiki]].')
    const opened: string[] = []
    const off = bus.on('openRef', (e) => void opened.push(e.ref))
    await act(async () => cites(el)[0].click())
    await settle()
    off()
    expect(opened).toEqual(['card:page-saves-wiki'])
  })

  test('names the card once its name is known, and is red with × when it failed', async () => {
    const el = await mount(
      <CardChipCites.Provider value={true}>
        <RefChip ref="card:deadbeef" workspace="w" cite />
      </CardChipCites.Provider>,
    )
    expect(el.textContent).toBe('card')
    await act(async () => registerCells([{ id: 'deadbeef', title: 'Runs per day', slug: 'runs-per-day' }]))
    expect(el.textContent).toBe('runs-per-day')
    const failed = await mount(
      <CardChipCites.Provider value={true}>
        <RefChip ref="card:page-saves-wiki" workspace="w" cite broken />
      </CardChipCites.Provider>,
    )
    const chip = failed.querySelector<HTMLElement>('.chip.broken')!
    expect(chip.textContent).toBe('page-saves-wiki')
    expect(chip.querySelector('.chip-ico')?.innerHTML).not.toBe('')
  })

  test("in a card's own text stays the card's glyph alone, its name in the hover", async () => {
    const el = await mount(
      <GlyphCites.Provider value={true}>
        <RefChip ref="card:page-saves-wiki" workspace="w" cite />
      </GlyphCites.Provider>,
    )
    const chip = el.querySelector<HTMLElement>('[data-ref]')!
    expect(chip.textContent).toBe('')
    expect(chip.classList.contains('refchip-icon')).toBe(true)
  })

  test("names a card by its question in the chat, cut at a word, and by its short name elsewhere (bug hunt G11)", async () => {
    registerCells([
      { id: 'tea-orders-month', title: 'How many tea orders came in each month?', slug: 'tea-orders-month' },
      { id: 'kettle-faults-shop', title: 'Which kettle faults did each repair shop report in the first quarter of the year?', slug: 'kettle-faults-shop' },
    ])
    const el = await reply('Orders rose in spring [[card:tea-orders-month]]. Faults cluster in two shops [[card:kettle-faults-shop]].')
    expect(names(el)).toEqual(['How many tea orders came in each month?', 'Which kettle faults did each repair…'])
    for (const c of cites(el)) expect(c.classList.contains('chip-sans')).toBe(true)
    // a step row's chip of the card it made, in the chat
    const step = await mount(
      <CardQuestions.Provider value={true}>
        <RefChip ref="card:tea-orders-month" compact workspace="w" />
      </CardQuestions.Provider>,
    )
    expect(step.querySelector('.chip-text')?.textContent).toBe('How many tea orders came in each month?')
    // outside the chat a chip keeps the card's short name
    const canvas = await mount(<RefChip ref="card:tea-orders-month" compact workspace="w" />)
    expect(canvas.querySelector('.chip-text')?.textContent).toBe('tea-orders-month')
    expect(cutQuestion('Which kettle faults did each repair shop report in the first quarter of the year?')).toBe('Which kettle faults did each repair…')
    expect(cutQuestion('  How   many   orders?  ')).toBe('How many orders?')
  })

  test("names a card by its id until its name is known, an older card's random id never", () => {
    expect(cardCiteLabel('card:prs-merged-week-12')).toBe('prs-merged-week-12')
    expect(cardCiteLabel('cell:prs-merged-week-12')).toBe('prs-merged-week-12')
    expect(cardCiteLabel('card:prs-merged-week-12@out0#L4')).toBe('prs-merged-week-12 · line 4')
    expect(cardCiteLabel('card:0badf00d')).toBe('card')
  })
})

describe('no ✓ for a verified state', () => {
  test("the report's card list marks no card the page already holds", async () => {
    const cells = [
      { id: 'how-many-prs', notebook: 'g1', title: 'How many PRs merged?', takeaway: '', kind: 'code', outputs: [] },
      { id: 'runs-per-day', notebook: 'g1', title: 'Runs per day', takeaway: '', kind: 'code', outputs: [] },
    ] as unknown as Cell[]
    const groups = [{ id: 'g1', title: 'Work' }] as unknown as Group[]
    const Side = () => <Sidebar ws="w" cells={cells} groups={groups} onInsert={() => undefined} onHide={() => undefined} over={false} doc="report" checks={useChecks('w')} comments={[]} />
    const el = await mount(<Side />)
    await settle()
    const rows = [...el.querySelectorAll<HTMLElement>('.wu-card-row')]
    expect(rows.map((r) => r.dataset.card)).toEqual(['how-many-prs', 'runs-per-day'])
    for (const r of rows) expect(r.textContent).not.toContain('✓')
    expect(el.querySelector('.wu-card-used')).toBeNull()
  })

  test('the Citation marks setting names no ✓', () => {
    const marks = FEATURE_ROWS.find((r) => r.key === 'citationMarks')!
    expect(marks.note).not.toContain('✓')
    expect(marks.note).toContain('×')
  })
})
