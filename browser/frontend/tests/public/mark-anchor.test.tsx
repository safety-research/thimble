// @vitest-environment jsdom
// The ⌘ pointer's anchor on a citation's words (src/marks/Mark.tsx), as a card's citation carries it (components/RefChip):
// the card place a card's value cites, else the ref of the text the words stand in, with the words as the anchor's
// text, so a ⌘-click asks about the citation (pointer/anchors.ts nearestAnchor) and not about the whole reply. The words
// are a control, where the pointer finds no text: without an anchor of their own, a ⌘-click took the reply, its whole
// text the thread's. Where the chips of a text carry no anchor (a plan's step), neither do its marks.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
import { foldRecords } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import type { MarkItem } from '../../src/marks/marks.ts'
import { nearestAnchor } from '../../src/pointer/anchors.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeEach(() => {
  // a chip or a label may look a card up; nothing answers
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const table = { corner: 'agent', cols: ['merged', 'total'], rows: [{ label: 'agent-07', values: ['12', '40'] }], at: { r: 0, c: 0 } }
const item = (k: number, words: string, rest: Partial<MarkItem>): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, ...rest })
const ITEMS = [
  item(0, '40', { evidence: { kind: 'computed', code: 'print(len(runs))', output: 'runs 40', highlight: [[5, 7]], by: 'main' } }),
  item(1, '12', { evidence: { kind: 'card', card: 'k3f9a1', title: 'Merged pull requests by agent', ref: 'card:k3f9a1#merged/agent-07', value: '12', table } }),
  item(2, 'the log says', { evidence: { kind: 'quote', file: 'runs/a.jsonl', line: 5, lines: [{ n: 5, text: 'the log says so', highlight: [0, 12] }] } }),
  item(3, '15 of 40', { status: 'corrected', shown: '12 of 40', was: '15 of 40' }),
]
const REPLY = 'Of the [40](#) runs, [12](#) merged, as [the log says](#); [15 of 40](#) were late, and [[3|card:abcd1234#agents/total]] agents reviewed.'

/** Each citation's words and what a ⌘-click on them asks about: the anchor and its text. */
const asked = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.mark-words')].map((w) => [w.textContent, nearestAnchor(w)?.anchor, nearestAnchor(w)?.text])

test("a citation's words in a reply ask about the card place a card's value cites, else about the reply, with the words the analyst reads", async () => {
  const records = [
    { type: 'user', text: 'How many runs merged?' },
    { type: 'text', delta: REPLY },
    { type: 'done', turn: 'aaaaaaaa' },
    { type: 'marks', turn: 'aaaaaaaa', items: ITEMS },
  ] as unknown as ChatRecord[]
  const el = await mount(<Rows rows={foldRecords(records)} ws="w" chat="main" />)
  await settle()
  const reply = el.querySelector('.chat-text')!.getAttribute('data-anchor')
  expect(reply).toBe('chat:main#1')
  expect(asked(el)).toEqual([
    ['40', reply, '40'],
    ['12', 'card:k3f9a1#merged/agent-07', '12'],
    ['the log says', reply, 'the log says'],
    ['12 of 40', reply, '12 of 40'],
    ['3', 'card:abcd1234#agents/total', '3'],
  ])
})

test("in a card's takeaway the words ask about the card, checked or not, and where the chips carry no anchor, as in a plan's step, the words carry none", async () => {
  // the third mark has no check yet: its words are read from the page
  const takeaway = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set(), anchor: true }}>
      <div className="bcell-take" data-anchor="card:c1" data-anchor-text="Of the 40 runs, 12 merged, 7 late.">
        <ChatMarkdown text="Of the [40](#) runs, [12](#) merged, [7](#) late." checks={ITEMS.slice(0, 2)} />
      </div>
    </ChipContext.Provider>,
  )
  expect(asked(takeaway)).toEqual([
    ['40', 'card:c1', '40'],
    ['12', 'card:k3f9a1#merged/agent-07', '12'],
    ['7', 'card:c1', '7'],
  ])
  const step = await mount(
    <ChipContext.Provider value={{ workspace: 'w', broken: new Set() }}>
      <div className="plan-step" data-anchor="card:p1#step-2" data-anchor-text="Count the merged runs">
        <ChatMarkdown text="Of the [40](#) runs, [12](#) merged." checks={ITEMS.slice(0, 2)} />
      </div>
    </ChipContext.Provider>,
  )
  expect(step.querySelector('.mark-words[data-anchor]')).toBeNull()
  expect(asked(step).map(([, anchor]) => anchor)).toEqual(['card:p1#step-2', 'card:p1#step-2'])
})
