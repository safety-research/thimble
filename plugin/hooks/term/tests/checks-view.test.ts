// The Checks view (checksview.tsx, SPEC-v2 J7): d dismisses a comment (`thimble act answer-comment-resolve`) and steps
// on; m puts a draft in the prompt; the entry box asks a side thread about the passage; o opens the comment in the
// browser (`answer:<turn>#s<n>`). `claude plugin test plugin`.
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

test('the entry box asks a side thread about the passage, told the comment; the thread opens over the comment', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.answerComments = TWO()
  await start($, w)
  const m = await opened($, w)
  // a gives the box the keys (a press of the panel's own, no form opens)
  await m.press({ key: 'hk-checks-a' })
  await w.clock.settle()
  expect(words(await m.drawn())).not.toContain('New thread')
  await m.input({ key: 'ask-check-c1', text: 'Is that right?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({ anchor: 'answer:r1#s1', element: 'answer:r1#s1', message: 'Is that right?' })
  expect(String(w.acts.find(a => a.kind === 'thread')!.payload.anchor_text)).toContain("The Important details check's comment on this passage of the answer: The label could not read 899 revisions")
  expect(w.panes.at(-1)!.title).toBe('Threads')
  await m.unmount()
})
