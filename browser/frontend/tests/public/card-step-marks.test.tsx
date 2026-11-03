// @vitest-environment jsdom
// The line a card's edit makes in the chat while main works (src/chat/model.ts toolSummary, plainStep; the head and the
// step of src/chat/Rows.tsx ToolGroupCard): an edit that names the card by its takeaway alone shows the takeaway in the
// words the chat draws of it, each citation's value and each mark's words, never a mark as typed (`[337 times](#)`).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { foldRecords, groupTools, plainStep, type ToolGroup, type ToolRow } from '../../src/chat/model.ts'
import { ToolGroupCard } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const EDIT = 'mcp__plugin_thimble_thimble__edit_card'
const TAKEAWAY = 'The [[33|card:c1@out0#L1]] agents ran the suite [337 times](#), and [238](#) runs passed all [14 tests](#).'
const WORDS = 'The 33 agents ran the suite 337 times, and 238 runs passed all 14 tests.'

// the call as main makes it: its result has not come yet
const edit = (input: Record<string, unknown>): ChatRecord[] => [{ type: 'tool_use', ts: '2026-10-30T19:39:00Z', id: 't1', name: EDIT, input }]

describe("an edit of a card's takeaway, while main works", () => {
  test("the card's head and its step name it in the takeaway's words, without its marks", async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const group = groupTools(foldRecords(edit({ card: 'card:c1', takeaway: TAKEAWAY }))).find((r): r is ToolGroup => r.kind === 'tools')!
    const el = await mount(<ToolGroupCard group={group} ws="w" pending />)
    expect(el.querySelector('.toolcard-meta')!.textContent).toBe(WORDS)
    await act(async () => el.querySelector<HTMLElement>('.toolcard-head')!.click())
    expect(el.querySelector('.toolcard-step-text')!.textContent).toBe(`edit_card · ${WORDS}`)
  })
  test('the plain step of a task or a subagent names it the same way', () => {
    const row = foldRecords(edit({ card: 'card:c1', takeaway: TAKEAWAY }))[0] as ToolRow
    expect(plainStep(row)).toBe(`Edited card · ${WORDS}`)
    // a mark's words keep their brackets, and a link to anything but `#` is no mark
    const own = foldRecords(edit({ card: 'card:c1', takeaway: 'Set [the [x] flag](#) as [the docs](https://example.org) say.' }))[0] as ToolRow
    expect(plainStep(own)).toBe('Edited card · Set the [x] flag as [the docs](https://example.org) say.')
  })
})
