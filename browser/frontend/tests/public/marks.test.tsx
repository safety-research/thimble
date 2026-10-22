// @vitest-environment jsdom
// A reply's marks drawn by what the check found (marks/Mark.tsx), as the terminal draws them: a correction shows its
// new words, a wrong mark is red with ×, one the check could not confirm has ?, and a click opens the evidence.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import type { MarkItem } from '../../src/marks/marks.ts'
import { withMarkHrefs } from '../../src/marks/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const item = (k: number, words: string, rest: Partial<MarkItem>): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, ...rest })

test('a mark keeps its place among the marks of its text, brackets and code spans in its words included', () => {
  expect(withMarkHrefs('[12](#) of [the [x] flag](#) and `[no](#)` [y](z)')).toBe('[12](#mark-0) of [the [x] flag](#mark-1) and `[no](#)` [y](z)')
})

test('each mark draws as its check says, and a click opens its evidence', async () => {
  const checks = [
    item(0, '12', {}),
    item(1, '15 of 40', { status: 'corrected', shown: '12 of 40', was: '15 of 40', reason: 'agent-07 merged 12' }),
    item(2, 'all', { status: 'failed', failedBy: 'check', reason: 'b also failed' }),
    item(3, '3', { status: 'failed', failedBy: 'evidence', reason: 'Not confirmed: no call printed it.' }),
    item(4, '7', { status: 'checking' }),
  ]
  const el = await mount(<ChatMarkdown text="[12](#) runs; [15 of 40](#) merged; [all](#) passed; [3](#) failed; [7](#) more." checks={checks} />)
  const looks = [...el.querySelectorAll('.mark')].map((m) => [m.getAttribute('data-mark-look'), m.textContent])
  expect(looks).toEqual([['verified', '12'], ['corrected', '12 of 40'], ['failed', 'all ×'], ['unconfirmed', '3 ?'], ['checking', '7']])
  const corrected = el.querySelectorAll<HTMLElement>('.mark .mark-words')[1]
  await act(async () => corrected.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  const card = el.querySelector('.mark-card')
  expect(card?.textContent).toContain('corrected')
  expect(card?.textContent).toContain('was “15 of 40”')
  expect(card?.textContent).toContain('agent-07 merged 12')
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
