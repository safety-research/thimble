// @vitest-environment jsdom
// A reply's marks drawn by what the citation check found (marks/Mark.tsx): verified, or failed with a red × after the
// words, as the terminal draws it, and a click opens the evidence in the citation's label. The check's repairs show in
// the reply: a corrected mark shows its new words, a rewritten sentence stands in place of its own, and a failed mark
// can be repaired from its label, as x repairs it in the terminal.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import type { MarkItem } from '../../src/marks/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const item = (k: number, words: string, rest: Partial<MarkItem>): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, ...rest })
const open = (words: Element) => act(async () => void words.dispatchEvent(new MouseEvent('click', { bubbles: true })))

test('each mark draws as its check says, verified or failed, and a click opens its evidence', async () => {
  const output = ['rows 40', 'merged 12', 'open 28'].join('\n')
  const at = output.indexOf('12')
  const checks = [
    item(0, '12', { evidence: { kind: 'computed', code: 'print(df.merged.sum())', output, highlight: [[at, at + 2]], by: 'main' } }),
    item(1, 'all', { status: 'failed', failedBy: 'check', reason: 'b also failed' }),
    item(2, '3', { status: 'failed', failedBy: 'evidence', reason: 'Not confirmed: no call printed it.' }),
    item(3, '7', { status: 'checking' }),
  ]
  const el = await mount(<ChatMarkdown text="[12](#) merged; [all](#) passed; [3](#) failed; [7](#) more." checks={checks} />)
  expect([...el.querySelectorAll('.mark')].map((m) => [m.getAttribute('data-mark-look'), m.textContent])).toEqual([
    ['verified', '12'],
    ['failed', 'all×'],
    ['failed', '3×'],
    ['checking', '7'],
  ])
  // a verified mark's label shows the output of the code Claude ran, the words marked in it
  const words = el.querySelectorAll<HTMLElement>('.mark .mark-words')
  await open(words[0])
  await settle()
  const pop = document.querySelector('.refchip-pop.mark-pop')
  expect(pop?.querySelector('.refchip-pop-head')?.textContent).toContain('code Claude ran')
  expect(pop?.querySelector('.refchip-lines .cite-cell')?.textContent).toBe('12')
  unmountAll()
  // a failed mark's label says why
  const again = await mount(<ChatMarkdown text="[12](#) merged; [all](#) passed; [3](#) failed; [7](#) more." checks={checks} />)
  await open(again.querySelectorAll<HTMLElement>('.mark .mark-words')[2])
  await settle()
  expect(document.querySelector('.mark-pop .mark-pop-why')?.textContent).toBe('Not confirmed: no call printed it.')
})

test("the check's repairs: a corrected mark shows its new words and what it was, and a failed one is repaired from its label", async () => {
  const checks = [
    item(0, '2.5 to 3.7', { status: 'corrected', shown: '0.5 to 1.7', was: '2.5 to 3.7', sentence: 'Opus took [2.5 to 3.7] hours on [40] runs.', rewrite: 'Opus took [0.5 to 1.7] hours, over [40] runs.' }),
    item(1, '40', {}),
    item(2, '15 of 40', { status: 'corrected', shown: '12 of 40', was: '15 of 40' }),
  ]
  const el = await mount(<ChatMarkdown text="Opus took [2.5 to 3.7](#) hours on [40](#) runs. Then [15 of 40](#) merged." checks={checks} />)
  expect(el.textContent).toBe('Opus took 0.5 to 1.7 hours, over 40 runs. Then 12 of 40 merged.')
  await open(el.querySelector<HTMLElement>('.mark-words')!)
  await settle()
  expect(document.querySelector('.mark-pop .mark-pop-was')?.textContent).toBe('sentence rewritten; was Opus took 2.5 to 3.7 hours on 40 runs.')
  unmountAll()

  const { marksApi } = await import('../../src/lib/api.ts')
  const sent: unknown[] = []
  const was = marksApi.repair
  marksApi.repair = async (_c, body) => (sent.push(body), { ok: true })
  try {
    const failed = await mount(<ChatMarkdown text="[243 against 104](#) issues" checks={[item(0, '243 against 104', { status: 'failed', failedBy: 'evidence', reason: 'The card shows 243, not 104.', turn: 'bbbbbbbb' })]} />)
    await open(failed.querySelector<HTMLElement>('.mark-words')!)
    await settle()
    await act(async () => document.querySelector<HTMLButtonElement>('.mark-pop .mark-pop-repair')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(sent).toEqual([{ turn: 'bbbbbbbb', n: 1 }])
  } finally {
    marksApi.repair = was
  }
})
