// Bug hunt L7: a browser thread's cards in the panel, the first time it opens there. Claude Code cuts every run of a
// drawing (or a press) it abandons, and the card's read came back `$.process.run(…) aborted`, which the card kept: each
// card drew as a red `× card 1 cannot be drawn: HooksError: …` row naming the install path. A cut read says nothing of
// the card: it is read again by the session's own lane, and the card draws.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cutShort, plainRunError } from '../term'
import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const pane = ($: E) =>
  $.ui.mount({ plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 64 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 60 }, view: {} } } as never) as unknown as Promise<M>

/** A thread asked in the browser (`tq`) whose answer embeds a card it made, which no turn of this session read. */
function browserThread(w: World): void {
  w.cells.q9card00 = { id: 'q9card00', notebook: 'g1', kind: 'table', title: 'How many saves did Zorblin make?', takeaway: 'Zorblin made 4 saves on the Quillpond page.', labels: [], created_by: 'chat:tq', ts: '2026-10-06T10:06:00+00:00', status: 'ok', outputs: [{ 'text/plain': 'editor  saves\nZorblin  4' }] }
  const meta = { id: 'tq', kind: 'thread', role: 'thread', title: 'who-saved-most', anchor: null, anchor_text: 'the saves', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 0, question: 'Who saved the Quillpond page most?', turn: 'answered' }
  w.states.threads = [w.states.threads[0]!, meta] as never
  const events = [
    { type: 'user', text: 'Who saved the Quillpond page most?', by: 'browser' },
    { type: 'tool_use', id: 'u1', name: 'mcp__plugin_thimble_thimble__add_card', input: { question: 'q' } },
    { type: 'tool_result', id: 'u1', summary: 'card:q9card00', cell_id: 'q9card00' },
    { type: 'text', delta: 'Zorblin saved it most [[card:q9card00]].', reply: true, by: 'browser' },
    { type: 'done', result: 'answered' },
  ]
  w.chats.tq = { meta, events, total: events.length }
}

test('bug hunt L7: a card whose first reads Claude Code cut short draws once read again, never as `× card 1 cannot be drawn: … aborted`', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  browserThread(w)
  // the first two reads of the card are cut, as Claude Code cuts the runs of a drawing it abandoned
  w.cutCards = { q9card00: 2 }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  let p = await pane($)
  await p.press({ key: 'thread-open-tq' })
  await w.clock.settle()
  const seen: string[] = []
  for (let i = 0; i < 4; i++) {
    await p.unmount()
    p = await pane($)
    seen.push(shown(await p.drawn()))
    await w.clock.advance(300)
  }
  await p.unmount()
  p = await pane($)
  const last = shown(await p.drawn())
  for (const s of [...seen, last]) {
    expect(s).not.toContain('cannot be drawn')
    expect(s).not.toContain('aborted')
  }
  expect(w.cutCards.q9card00).toBe(0)
  expect(last).toContain('Zorblin made 4 saves on the Quillpond page.')
  await p.unmount()
})

test('bug hunt L7: a run Claude Code cut short is told from a failed one; a failed read is said without `HooksError` or the command’s path', () => {
  expect(cutShort('HooksError: thimble: $.process.run(/opt/zz/plugin/bin/thimble) aborted')).toBe(true)
  expect(cutShort('HooksError: thimble: $.process.run: aborted')).toBe(true)
  expect(cutShort('no card q9card00')).toBe(false)
  expect(plainRunError('HooksError: thimble: $.process.run(/opt/zz/plugin/bin/thimble) timed out after 60000 ms')).toBe('thimble timed out after 60000 ms')
  expect(plainRunError('no card q9card00')).toBe('no card q9card00')
})
