// The Checks view (checksview.tsx, SPEC-v2 J7): one comment of a check on a passage of Claude's answer, its passage with
// the check's flag, the comment, the acts; `‹ 1 of 2 ›` and n p to step; d dismisses it (`thimble act
// answer-comment-resolve`) and steps on; m puts a draft in the prompt; a asks a side thread about the passage; o opens
// the comment in the browser (`answer:<turn>#s<n>`). With no open comment it lists the checks. `claude plugin test
// plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { promptDraft } from '../checksview'
import { CWD, comment, paneAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function opened($: E, w: PanelWorld): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: 'checks' } as never)
  await w.clock.settle()
  return (await $.ui.mount(paneAt(96))) as unknown as M
}

const TWO = () => [comment('c1'), comment('c2', { quote: 'One week of June holds most saves.', text: 'The other weeks are not in the export.', ref: 'answer:r1#s4' })]

test('one comment: its check in the title row with `‹ 1 of 2 ›`, when and what the check looks for, the passage with its flag, the comment, the acts', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.answerComments = TWO()
  await start($, w)
  const m = await opened($, w)
  const way = words(await m.find({ type: 'Box', key: 'way' }))
  expect(way).toContain('home › checks › Important details')
  expect(way).toContain('1 of 2')
  const text = words(await m.drawn())
  expect(text).toMatch(/on your answer at \d{1,2}:\d{2} [AP]M · it looks for what a reader would likely miss/)
  expect(text).toContain('⚑ ')
  expect(text).toContain('⚑ passageAfter 19 June there are 0 new messages to other agents on any page.')
  expect(text).toContain('commentThe label could not read 899 revisions whose text the dump hides.')
  expect(words(await m.find({ type: 'Box', key: 'checks-acts' }))).toBe('ask about itput in the promptdismissopen in the browser')
  // n steps to the second comment
  await m.press({ key: 'hk-checks-n' })
  await w.clock.settle()
  expect(words(await m.drawn())).toContain('One week of June holds most saves.')
  expect(words(await m.find({ type: 'Box', key: 'way' }))).toContain('2 of 2')
  await m.unmount()
})

test('d dismisses the comment through `thimble act answer-comment-resolve` and the view steps on; m puts a draft in the prompt; o opens the comment in the browser', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.answerComments = TWO()
  await start($, w)
  const m = await opened($, w)
  await m.press({ key: 'hk-checks-m' })
  await w.clock.settle()
  expect(w.filled.at(-1)).toBe(promptDraft(comment('c1')))
  expect(w.filled.at(-1)).toMatch(/^About "After 19 June there are 0 new messages to other agents on any page\." in your answer at \d{1,2}:\d{2} [AP]M, the Important details check says: "The label could not read 899 revisions whose text the dump hides\."$/)
  expect(w.submitted).toEqual([])
  await m.press({ key: 'hk-browser' })
  await w.clock.settle()
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', 'answer:r1#s1']))
  await m.press({ key: 'hk-checks-d' })
  await w.clock.settle()
  expect(w.acts.at(-1)).toEqual({ kind: 'answer-comment-resolve', payload: { comment: 'c1', reopen: false } })
  const after = words(await m.drawn())
  expect(after).toContain('One week of June holds most saves.')
  expect(after).not.toContain('After 19 June')
  expect(words(await m.find({ type: 'Box', key: 'way' }))).toContain('1 of 1')
  await m.unmount()
})

test('a asks a side thread about the passage, told the comment', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.answerComments = TWO()
  await start($, w)
  const m = await opened($, w)
  await m.press({ key: 'hk-checks-a' })
  await w.clock.settle()
  expect(w.panes.at(-1)!.title).toBe('Threads')
  const text = words(await m.drawn())
  expect(text).toContain('After 19 June there are 0 new messages')
  await m.unmount()
})

test('with no open comment the view lists the checks: each one\'s name, on or off, its open comments; o opens the Checks pane', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  const m = await opened($, w)
  const el = (await m.find({ type: 'Client', key: 'm:checks-list' })) as unknown as { props: { props: { lines: { s: string }[][] } } }
  const rows = el.props.props.lines.map(l => l.map(x => x.s).join('').replace(/\s+$/, ''))
  expect(rows).toEqual([expect.stringMatching(/^ {2}● Unverifiable +on$/), expect.stringMatching(/^ {2}● Verified +off$/), expect.stringMatching(/^ {2}● Judgment calls +on$/)])
  expect(words(await m.drawn())).toContain('no comment on an answer is open')
  await m.press({ key: 'way-browser' })
  await w.clock.settle()
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', 'checks']))
  await m.unmount()
})
