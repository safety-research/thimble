// @vitest-environment jsdom
// A reply's marks drawn by what the citation check found (marks/Mark.tsx): verified, or failed with a red × after the
// words, as the terminal draws it, and a click opens the evidence in the citation's label (for a value code computed,
// the code and its output under the head). The check's repairs show in
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
  // a verified mark's label shows the output of the code Claude ran, the words marked in it, and at its head's right
  // its state, all it says of the check
  const words = el.querySelectorAll<HTMLElement>('.mark .mark-words')
  await open(words[0])
  await settle()
  const pop = document.querySelector('.refchip-pop.mark-pop')
  expect(pop?.querySelector('.refchip-pop-head')?.textContent).toContain('code Claude ran')
  expect(pop?.querySelector('.refchip-pop-head .mark-pop-side .mark-pop-status')?.textContent).toBe('✓ verified')
  expect(pop?.querySelector('.refchip-lines .cite-cell')?.textContent).toBe('12')
  unmountAll()
  // a failed mark's label says × failed and no more; why is the word's title, for a pointer that rests on it
  const again = await mount(<ChatMarkdown text="[12](#) merged; [all](#) passed; [3](#) failed; [7](#) more." checks={checks} />)
  await open(again.querySelectorAll<HTMLElement>('.mark .mark-words')[2])
  await settle()
  const failed = document.querySelector('.mark-pop .mark-pop-status')
  expect(failed?.textContent).toBe('× failed')
  expect(failed?.getAttribute('title')).toBe('Not confirmed: no call printed it.')
  expect(document.querySelector('.mark-pop')?.textContent).toBe('× failed')
  unmountAll()
  // while its check runs, it says checking, with the spinner
  const running = await mount(<ChatMarkdown text="[12](#) merged; [all](#) passed; [3](#) failed; [7](#) more." checks={checks} />)
  await open(running.querySelectorAll<HTMLElement>('.mark .mark-words')[3])
  await settle()
  expect(document.querySelector('.mark-pop')?.textContent?.trim()).toBe('checking')
  expect(document.querySelector('.mark-pop .mark-pop-status .spinner')).not.toBeNull()
})

test("a computed mark's label shows the code right under its head, with no words of the check's on how the code got the value", async () => {
  const output = 'rows 40\nmerged 12'
  const at = output.indexOf('12')
  const how = 'Counted the lines of prs.jsonl whose merged field is true, one line per pull request.'
  const code = 'import json\nprs = [json.loads(l) for l in open("prs.jsonl")]\nprint(f"rows {len(prs)}")\nprint(f"merged {sum(p[\'merged\'] for p in prs)}")'
  // evidence a check kept with its words on how the code got the value, as an earlier build stored it
  const kept = { kind: 'computed' as const, code, output, highlight: [[at, at + 2]] as [number, number][], by: 'checker', method: how }
  const el = await mount(<ChatMarkdown text="[12](#) merged." checks={[item(0, '12', { evidence: kept })]} />)
  await open(el.querySelector<HTMLElement>('.mark-words')!)
  await settle()
  const head = document.querySelector('.mark-pop .mark-ev .refchip-pop-head')
  expect(head?.nextElementSibling?.textContent).toBe('code · 4 lines')
  expect(document.querySelector('.mark-pop')?.textContent).not.toContain(how)
})

test("a card's value cited in the older form draws as verified only in a takeaway, whose link pass checked it", async () => {
  const looks = (el: HTMLElement) => [...el.querySelectorAll('.mark')].map((m) => [m.getAttribute('data-mark-look'), m.textContent])
  // bc03: a reply cited line 2 of a card's output as 6 of 24, where the line says 4 of 24, and no check read it. Its
  // label says so over the place it names
  const reply = await mount(<ChatMarkdown text="Config B failed [[6 of 24|card:efd46173@out0#L2]] task runs." />)
  expect(looks(reply)).toEqual([['pending', '6 of 24']])
  await open(reply.querySelector<HTMLElement>('.mark-words')!)
  expect(document.querySelector('.mark-pop .mark-ev .refchip-pop-head .mark-pop-status')?.textContent?.trim()).toBe('not checked yet')
  expect(document.querySelector('.mark-pop .mark-ev .refchip-pop-chip')).not.toBeNull()
  unmountAll()
  // a takeaway's link pass keeps such a citation only where its place shows the value (backend cite.resolve)
  const takeaway = await mount(<ChatMarkdown text="Config B failed [[4 of 24|card:efd46173@out0#L2]] task runs." linked />)
  expect(looks(takeaway)).toEqual([['verified', '4 of 24']])
})

test("the check's repairs: a corrected mark shows its new words and says verified, and a failed one is repaired from its label's head", async () => {
  const checks = [
    item(0, '2.5 to 3.7', { status: 'corrected', shown: '0.5 to 1.7', was: '2.5 to 3.7', sentence: 'Opus took [2.5 to 3.7] hours on [40] runs.', rewrite: 'Opus took [0.5 to 1.7] hours, over [40] runs.' }),
    item(1, '40', {}),
    item(2, '15 of 40', { status: 'corrected', shown: '12 of 40', was: '15 of 40' }),
  ]
  const el = await mount(<ChatMarkdown text="Opus took [2.5 to 3.7](#) hours on [40](#) runs. Then [15 of 40](#) merged." checks={checks} />)
  expect(el.textContent).toBe('Opus took 0.5 to 1.7 hours, over 40 runs. Then 12 of 40 merged.')
  await open(el.querySelector<HTMLElement>('.mark-words')!)
  await settle()
  // a rewritten sentence reads anew in the text: its label says verified, as any verified mark's, and nothing of the
  // correction
  expect(document.querySelector('.mark-pop')?.textContent).toBe('✓ verified')
  unmountAll()
  const plain = await mount(<ChatMarkdown text="Then [15 of 40](#) merged." checks={[item(0, '15 of 40', { status: 'corrected', shown: '12 of 40', was: '15 of 40' })]} />)
  await open(plain.querySelector<HTMLElement>('.mark-words')!)
  await settle()
  expect(document.querySelector('.mark-pop')?.textContent).toBe('✓ verified')
  unmountAll()

  const { marksApi } = await import('../../src/lib/api.ts')
  const sent: unknown[] = []
  const was = marksApi.repair
  marksApi.repair = async (_c, body) => (sent.push(body), { ok: true })
  try {
    const failed = await mount(<ChatMarkdown text="[243 against 104](#) issues" checks={[item(0, '243 against 104', { status: 'failed', failedBy: 'evidence', reason: 'The card shows 243, not 104.', turn: 'bbbbbbbb' })]} />)
    await open(failed.querySelector<HTMLElement>('.mark-words')!)
    await settle()
    // Repair beside × failed, at the head's right, and no word of why
    expect(document.querySelector('.mark-pop .mark-pop-side')?.textContent).toBe('× failedRepair')
    expect(document.querySelector('.mark-pop')?.textContent).not.toContain('243, not 104')
    await act(async () => document.querySelector<HTMLButtonElement>('.mark-pop .mark-pop-side .mark-pop-repair')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(sent).toEqual([{ turn: 'bbbbbbbb', n: 1 }])
  } finally {
    marksApi.repair = was
  }
})
