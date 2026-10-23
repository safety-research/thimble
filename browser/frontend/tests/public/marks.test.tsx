// @vitest-environment jsdom
// A reply's marks drawn by what the check found (marks/Mark.tsx), as a card's citations are drawn: two looks, verified
// (a correction shows its new words and looks verified) and failed (a wrong mark, one the check could not confirm, one
// no check could run: a red × after the words, as the terminal draws it), and a click opens the evidence in the citation's label.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { bus } from '../../src/lib/bus.ts'
import { MarksFooter } from '../../src/marks/MarksFooter.tsx'
import type { MarkItem } from '../../src/marks/marks.ts'
import { withMarkHrefs } from '../../src/marks/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const item = (k: number, words: string, rest: Partial<MarkItem>): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, ...rest })

test('a mark keeps its place among the marks of its text, brackets and code spans in its words included', () => {
  expect(withMarkHrefs('[12](#) of [the [x] flag](#) and `[no](#)` [y](z)')).toBe('[12](#mark-0) of [the [x] flag](#mark-1) and `[no](#)` [y](z)')
})

test('each mark draws as its check says, verified or failed, and a click opens its evidence', async () => {
  const checks = [
    item(0, '12', {}),
    item(1, '15 of 40', { status: 'corrected', shown: '12 of 40', was: '15 of 40', reason: 'agent-07 merged 12' }),
    item(2, 'all', { status: 'failed', failedBy: 'check', reason: 'b also failed' }),
    item(3, '3', { status: 'failed', failedBy: 'evidence', reason: 'Not confirmed: no call printed it.' }),
    item(4, '7', { status: 'checking' }),
  ]
  const el = await mount(<ChatMarkdown text="[12](#) runs; [15 of 40](#) merged; [all](#) passed; [3](#) failed; [7](#) more." checks={checks} />)
  const looks = [...el.querySelectorAll('.mark')].map((m) => [m.getAttribute('data-mark-look'), m.textContent])
  expect(looks).toEqual([['verified', '12'], ['verified', '12 of 40'], ['failed', 'all×'], ['failed', '3×'], ['checking', '7']])
  // a failed mark's label says why in one line
  const failed = el.querySelectorAll<HTMLElement>('.mark .mark-words')[3]
  await act(async () => failed.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  expect(document.querySelector('.mark-pop .mark-pop-why')?.textContent).toBe('Not confirmed: no call printed it.')
})

test("a mark's label shows its evidence as a citation's label does: the output lines around the words, the words highlighted", async () => {
  const output = ['rows 40', 'merged 12', 'open 28'].join('\n')
  const at = output.indexOf('12')
  const checks = [item(0, '12', { evidence: { kind: 'computed', code: 'print(df.merged.sum())', output, highlight: [[at, at + 2]], by: 'main' } })]
  const el = await mount(<ChatMarkdown text="[12](#) merged" checks={checks} />)
  await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  const pop = document.querySelector('.refchip-pop.mark-pop')
  expect(pop?.querySelector('.refchip-pop-head')?.textContent).toContain('code Claude ran')
  expect(pop?.querySelector('.refchip-lines .cite-cell')?.textContent).toBe('12')
  expect(pop?.querySelector('.mark-pop-why')).toBeNull()
})

test("a place in a mark's label opens its file and the label closes at once, hovered or pinned", async () => {
  const ev = { kind: 'quote' as const, file: 'runs/a.jsonl', line: 5880, lines: [{ n: 5880, text: '11 passed, 819 deselected', highlight: [0, 25] as [number, number] }] }
  const el = await mount(<ChatMarkdown text="[11 passed, 819 deselected](#) on the branch" checks={[item(0, '11 passed, 819 deselected', { evidence: ev })]} />)
  const opened: unknown[] = []
  const off = bus.on('openRef', (e) => opened.push(e))
  try {
    await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    const chip = document.querySelector<HTMLElement>('.mark-pop .refchip-pop-chip')
    expect(chip?.textContent).toBe('runs/a.jsonl:5880')
    await act(async () => chip!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened).toEqual([{ ref: 'runs/a.jsonl#L5880' }])
    expect(document.querySelector('.mark-pop')).toBeNull()
  } finally {
    off()
  }
})

test('while the reply streams its marks wait, whatever an earlier check said', async () => {
  const el = await mount(<ChatMarkdown text="[12](#) runs" streaming checks={[item(0, '12', { status: 'failed' })]} />)
  expect(el.querySelector('.mark')?.getAttribute('data-mark-look')).toBe('pending')
})

test("a turn's marks go to its own text rows in order, and its reply gets the footer", async () => {
  const { foldRecords } = await import('../../src/chat/model.ts')
  const rows = foldRecords([
    { type: 'user', text: 'q1' },
    { type: 'text', delta: 'Old [a](#).' },
    { type: 'done', turn: 'aaaaaaaa' },
    { type: 'text', delta: 'New [b](#) and ' },
    { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    { type: 'text', delta: '[c](#).' },
    { type: 'done', turn: 'bbbbbbbb' },
    { type: 'marks', turn: 'bbbbbbbb', items: [item(1, 'c', { n: 2, status: 'corrected', shown: 'C' }), item(0, 'b', { n: 1 })] },
  ])
  const texts = rows.filter((r) => r.kind === 'text') as { text: string; checks?: MarkItem[]; turnMarks?: MarkItem[] }[]
  expect(texts.map((r) => r.text)).toEqual(['Old [a](#).', 'New [b](#) and ', '[c](#).'])
  expect(texts[0].checks).toBeUndefined()
  expect(texts[1].checks?.map((m) => m.words)).toEqual(['b'])
  expect(texts[2].checks?.map((m) => m.words)).toEqual(['c'])
  expect(texts[2].turnMarks?.length).toBe(2)
})

test("the check's notes on the sentences around the marks are not shown: neither under the reply nor in a mark's card", async () => {
  const note = 'Deletions did not only begin after the edits stopped.'
  const checks = [item(0, '12', { note }), item(1, 'all', { status: 'failed', failedBy: 'check', reason: 'b also failed', note })]
  const foot = await mount(<MarksFooter items={checks} />)
  expect(foot.textContent).toContain('1')
  expect(foot.textContent).not.toContain(note)
  expect(foot.querySelector('.marks-foot-note')).toBeNull()
  // a footer with nothing but notes is no footer
  const none = await mount(<MarksFooter items={[item(0, '12', { note })]} />)
  expect(none.textContent).toBe('')
  // the failed citation has its ×, and its label says nothing of the note
  const el = await mount(<ChatMarkdown text="[12](#) runs; [all](#) passed." checks={checks} />)
  expect([...el.querySelectorAll('.mark')].map((m) => m.textContent)).toEqual(['12', 'all×'])
  await act(async () => el.querySelectorAll<HTMLElement>('.mark .mark-words')[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  const pop = document.querySelector('.mark-pop')
  expect(pop?.textContent).toContain('b also failed')
  expect(pop?.textContent).not.toContain(note)
  expect(el.textContent).not.toContain(note)
})

test('a corrected verdict shows the corrected words in the reply, a rewritten sentence in place of its own, and what it was in the label', async () => {
  const checks = [
    item(0, '2.5 to 3.7', { status: 'corrected', shown: '0.5 to 1.7', was: '2.5 to 3.7', sentence: 'Opus took [2.5 to 3.7] hours on [40] runs.', rewrite: 'Opus took [0.5 to 1.7] hours, over [40] runs.' }),
    item(1, '40', {}),
    item(2, '15 of 40', { status: 'corrected', shown: '12 of 40', was: '15 of 40' }),
    item(3, 'merged 12 (all of them)', { status: 'corrected', shown: 'merged 12', was: 'merged 12 (all of them)', narrowed: true }),
  ]
  const el = await mount(<ChatMarkdown text="Opus took [2.5 to 3.7](#) hours on [40](#) runs. Then [15 of 40](#) merged. It [merged 12 (all of them)](#) today." checks={checks} />)
  expect(el.textContent).toBe('Opus took 0.5 to 1.7 hours, over 40 runs. Then 12 of 40 merged. It merged 12 (all of them) today.')
  expect([...el.querySelectorAll('.mark-words')].map((m) => m.textContent)).toEqual(['0.5 to 1.7', '40', '12 of 40', 'merged 12'])
  await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  expect(document.querySelector('.mark-pop .mark-pop-was')?.textContent).toBe('sentence rewritten; was Opus took 2.5 to 3.7 hours on 40 runs.')
})

test('a failed mark can be repaired from its label, as x repairs it in the terminal', async () => {
  const { marksApi } = await import('../../src/lib/api.ts')
  const sent: unknown[] = []
  const was = marksApi.repair
  marksApi.repair = async (_c, body) => (sent.push(body), { ok: true })
  try {
    const el = await mount(<ChatMarkdown text="[243 against 104](#) issues" checks={[item(0, '243 against 104', { status: 'failed', failedBy: 'evidence', reason: 'The card shows 243, not 104.', turn: 'bbbbbbbb' })]} />)
    await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    const button = document.querySelector<HTMLButtonElement>('.mark-pop .mark-pop-repair')
    expect(button?.textContent).toContain('Repair')
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(sent).toEqual([{ turn: 'bbbbbbbb', n: 1 }])
  } finally {
    marksApi.repair = was
  }
})

test('words with two values cite two cells: one table, both cells marked', async () => {
  const table = { corner: 'run', cols: ['issues closed'], rows: [{ label: 'opus emergent', values: ['243'] }, { label: 'opus managed', values: ['104'] }], at: { r: 0, c: 0 }, also: [{ r: 1, c: 0 }] }
  const ev = { kind: 'card' as const, card: 'c7d2e4', title: 'Issues', ref: 'card:c7d2e4#issues%20closed/opus%20emergent', value: '243', table }
  const el = await mount(<ChatMarkdown text="[243 against 104](#) issues" checks={[item(0, '243 against 104', { evidence: ev })]} />)
  await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  expect([...document.querySelectorAll('.mark-pop .cite-cell')].map((c) => c.textContent)).toEqual(['243', '104'])
})

test("a card's evidence shows the card as it is now when it changed after the check, or says the place is gone", async () => {
  const { api } = await import('../../src/lib/api.ts')
  const table = { corner: 'run', cols: ['of_40_open'], rows: [{ label: 'run-a', values: ['12'] }], at: { r: 0, c: 0 } }
  const ev = { kind: 'card' as const, card: 'c1a2b3', title: 'Old title', ref: 'card:c1a2b3#of_40_open/run-a', value: '12', table }
  const was = api.resolveRef
  const html = (col: string, v: string) => ({ excerpt: '', meta: { title: 'New title', table_html: `<table><thead><tr><th>run</th><th>${col}</th></tr></thead><tbody><tr><th>run-a</th><td>${v}</td></tr></tbody></table>` } })
  const open = async (answer: unknown) => {
    api.resolveRef = (async () => answer) as unknown as typeof api.resolveRef
    unmountAll()
    const el = await mount(<ChatMarkdown text="[12](#) open" checks={[item(0, '12', { evidence: ev })]} />)
    await act(async () => el.querySelector<HTMLElement>('.mark-words')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(document.querySelector('.mark-pop .refchip-pop-chip')?.textContent).toBe('New title')
    return { note: document.querySelector('.mark-pop .mark-ev-changed')?.textContent ?? '', cell: document.querySelector('.mark-pop .cite-cell')?.textContent }
  }
  try {
    // the card still shows the same: the check's copy, no note
    expect(await open(html('of_40_open', '12'))).toEqual({ note: '', cell: '12' })
    // the card was run again and shows another value there: the card now, with a note
    expect(await open(html('of_40_open', '14'))).toEqual({ note: 'The card changed after the check. It shows this now:', cell: '14' })
    // the card was rewritten and the place is gone: what the check read, with a note
    expect(await open(html('still_open', '12'))).toEqual({ note: 'The card changed after the check. The check read this:', cell: '12' })
  } finally {
    api.resolveRef = was
  }
})
