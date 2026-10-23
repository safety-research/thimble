// @vitest-environment jsdom
// A reply's marks drawn by what the check found (marks/Mark.tsx), as a card's citations are drawn: two looks, verified
// (a correction shows its new words and looks verified) and failed (a wrong mark, one the check could not confirm, one
// no check could run: a red × after the words, as the terminal draws it), and a click opens the evidence in the citation's label.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
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
