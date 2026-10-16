// @vitest-environment jsdom
// A chat reply's citation of a card reads `[ card:<name> ]`, as the terminal draws it (plugin/hooks/term/lib.ts
// chipWords), never the card's glyph alone (src/components/RefChip.tsx CardWordCites, src/chat/Rows.tsx); a card's own
// text keeps the glyph. Like every citation it is purple and underlined, and red with × when it failed. No ✓ marks a
// verified state anywhere: the report's card list shows none for a card the page already holds (src/report/Sidebar.tsx),
// and the Citation marks setting names none (src/shell/SettingsPopover.tsx).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import { CardWordCites, GlyphCites, RefChip, cardChipWords } from '../../src/components/RefChip.tsx'
import { registerCells } from '../../src/lib/cellName.ts'
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

const words = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.chat-text .refchip')].map((c) => c.textContent)

describe("a chat reply's citation of a card", () => {
  test('reads `[ card:<name> ]` by the name the card is cited by, as the terminal draws it, never its glyph alone', async () => {
    registerCells([{ id: 'c0ffee00', title: 'Which wikis have the most revisions?', slug: 'wikis-most-revisions' }])
    const el = await reply('Most records are messages [[card:how-many-prs]]. The wikis differ [[card:c0ffee00]]; an older card [[card:ab12cd34]]. It printed this [[card:how-many-prs@out0#L1-L3]].')
    expect(words(el)).toEqual(['[ card:how-many-prs ]', '[ card:wikis-most-revisions ]', '[ card ]', '[ card output lines 1-3 ]'])
    for (const c of el.querySelectorAll<HTMLElement>('.chat-text .refchip')) {
      // a citation in words: purple and underlined as every citation (refchip.css), no chip glyph, no hidden name
      expect(c.classList.contains('refchip-words')).toBe(true)
      expect(c.classList.contains('refchip-citation')).toBe(true)
      expect(c.classList.contains('refchip-icon')).toBe(false)
      expect(c.querySelector('svg')).toBeNull()
      expect(c.getAttribute('aria-label')).toBeNull()
    }
    expect(el.querySelector('.chat-text .refchip')?.getAttribute('data-ref')).toBe('card:how-many-prs')
    // a cited number stays the link's text
    const valued = await reply('There are [[3|card:how-many-prs#agents/total]] agents.')
    expect(valued.querySelector('.chat-text .refchip-value')?.textContent).toBe('3')
    expect(errors).toEqual([])
  })

  test("names the card once its name is known, and is red with × when it failed", async () => {
    const el = await mount(
      <CardWordCites.Provider value={true}>
        <RefChip ref="card:deadbeef" workspace="w" cite />
      </CardWordCites.Provider>,
    )
    expect(el.textContent).toBe('[ card ]')
    await act(async () => registerCells([{ id: 'deadbeef', title: 'Runs per day', slug: 'runs-per-day' }]))
    expect(el.textContent).toBe('[ card:runs-per-day ]')
    const failed = await mount(
      <CardWordCites.Provider value={true}>
        <RefChip ref="card:how-many-prs" workspace="w" cite broken />
      </CardWordCites.Provider>,
    )
    expect(failed.querySelector('.refchip-words.broken + .refchip-x')?.textContent?.trim()).toBe('×')
    expect(failed.querySelector('.refchip-words')?.textContent).toBe('[ card:how-many-prs ]')
  })

  test("in a card's own text stays the card's glyph alone, its name in the hover", async () => {
    const el = await mount(
      <GlyphCites.Provider value={true}>
        <RefChip ref="card:how-many-prs" workspace="w" cite />
      </GlyphCites.Provider>,
    )
    const chip = el.querySelector<HTMLElement>('[data-ref]')!
    expect(chip.textContent).toBe('')
    expect(chip.classList.contains('refchip-icon')).toBe(true)
    expect(chip.classList.contains('refchip-words')).toBe(false)
  })

  test('says what the terminal says for each ref of a card, and nothing for any other ref', () => {
    expect(cardChipWords('card:how-many-prs#wiki/dse')).toBe('[ card:how-many-prs ]')
    expect(cardChipWords('cell:prs-merged-week-12')).toBe('[ card:prs-merged-week-12 ]')
    expect(cardChipWords('card:how-many-prs@out0#L4')).toBe('[ card output line 4 ]')
    expect(cardChipWords('card:0badf00d')).toBe('[ card ]')
    expect(cardChipWords('events.jsonl#L12')).toBeNull()
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
