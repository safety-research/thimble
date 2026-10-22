// @vitest-environment jsdom
// One citation mechanism: a mark whose evidence is a value a card shows opens the card's table with the cited cell
// marked, printed output that is a table opens as that table, a card's takeaway draws its marks as the check left them,
// and an old `[[value|card:…]]` citation reads as a verified mark with that place as its evidence.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { cardCitationMark, ChatMarkdown } from '../../src/chat/markdown.tsx'
import type { MarkItem } from '../../src/marks/marks.ts'
import { takeawayChecks } from '../../src/marks/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const table = { corner: 'agent', cols: ['merged', 'total'], rows: [{ label: 'agent-03', values: ['4', '10'] }, { label: 'agent-07', values: ['12', '40'] }], at: { r: 1, c: 0 } }
const item = (rest: Partial<MarkItem>): MarkItem => ({ n: 1, piece: 0, k: 0, words: '12', sentence: '', status: 'verified', shown: '12', ...rest })

async function open(el: HTMLElement) {
  await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  return document.querySelector<HTMLElement>('.refchip-pop.mark-pop')!
}

test("a card's value opens as the card's table: its title, the header, the cited cell marked", async () => {
  const checks = [item({ evidence: { kind: 'card', card: 'k3f9a1', title: 'Merged pull requests by agent', ref: 'card:k3f9a1#merged/agent-07', value: '12', table } })]
  const pop = await open(await mount(<ChatMarkdown text="agent-07 merged [12](#)" checks={checks} />))
  expect(pop.querySelector('.refchip-pop-head')?.textContent).toContain('Merged pull requests by agent')
  expect([...pop.querySelectorAll('thead th')].map((t) => t.textContent)).toContain('merged')
  expect(pop.querySelector('td.cite-cell')?.textContent).toBe('12')
})

test('printed output that is a table opens as that table, then the code', async () => {
  const checks = [item({ evidence: { kind: 'computed', code: 'print(df)', output: '          merged\nagent-07      12', highlight: [[30, 32]], by: 'checker', table: { ...table, at: { r: 1, c: 0 } } } })]
  const pop = await open(await mount(<ChatMarkdown text="[12](#) merged" checks={checks} />))
  expect(pop.querySelector('td.cite-cell')?.textContent).toBe('12')
  expect(pop.querySelector('.mark-ev-code')?.textContent).toBe('print(df)')
})

test("a takeaway's marks draw as the check left them for its text, and wait while it has not run on the text", () => {
  const items = [item({ k: 1, words: '40', status: 'failed' }), item({ k: 0 })]
  const cell = { takeaway: '[12](#) of [40](#)', takeaway_marks: { text: '[12](#) of [40](#)', items } }
  expect(takeawayChecks(cell).map((m) => m?.status)).toEqual(['verified', 'failed'])
  expect(takeawayChecks({ ...cell, takeaway: '[13](#) of [40](#)' })).toEqual([])
})

test('an old card citation reads as a verified mark whose evidence is its place; a broken one as failed', async () => {
  expect(cardCitationMark('card:k3f9a1#merged/agent-07', '12')).toMatchObject({ status: 'verified', evidence: { kind: 'card', card: 'k3f9a1', ref: 'card:k3f9a1#merged/agent-07' } })
  expect(cardCitationMark('card:k3f9a1@out0#L3', '12', 'gone')).toMatchObject({ status: 'failed', reason: 'gone' })
  expect(cardCitationMark('runs/a.jsonl#L3', '12')).toBeNull()
  const el = await mount(<ChatMarkdown text="agent-07 merged [[12|card:k3f9a1#merged/agent-07]] pull requests" />)
  expect(el.querySelector('.mark')?.getAttribute('data-mark-look')).toBe('verified')
  expect(el.querySelector('.mark-words')?.textContent).toBe('12')
})
