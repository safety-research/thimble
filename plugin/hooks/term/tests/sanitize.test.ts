// Every data-derived string the terminal draws goes through clean() (SPEC-v2 S8): a terminal's escape sequences (an OSC
// 8 link, a color), C0 and C1 controls, the bidi controls and marks, the zero-width characters and U+FEFF are left out:
// in the coverage line, a check's name and comment, and a failure's toast. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { clean } from '../lib'
import { answerCommentOf } from '../term'
import { CWD, aTurn, call, corpus, reads, shown, startSession, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }
const BAD = 'a\u001b]8;;https://x.example\u0007link\u001b]8;;\u0007 \u001b[31mred\u001b[0m\u0007\u0085 b‮evil‬ c⁦d⁩ z​w‍j﻿k؜.'

test('clean strips ESC sequences, OSC 8, C0 and C1 controls, bidi, zero-width and U+FEFF', () => {
  expect(clean(BAD)).toBe('alink red bevil cd zwjk.')
  expect(clean('plain words, 4,579 pages')).toBe('plain words, 4,579 pages')
})

test("a check's name, about and comment are cleaned as read", () => {
  const c = answerCommentOf({ id: 'c1', row: 'r1', quote: 'q', check_name: 'Imp‮ortant', about: 'a​b', text: `x${BAD}`, details: '\u001b[1md', color: 12, start: 0, end: 1 })!
  expect(c.checkName).toBe('Important')
  expect(c.about).toBe('ab')
  expect(c.text).toBe('xalink red bevil cd zwjk.')
  expect(c.details).toBe('d')
  // a color outside 1-8 is held to the check palette's places
  expect(c.color).toBe(8)
})

test('the coverage line and a failure toast draw no control, bidi or zero-width character', SLOW, async ($, on) => {
  const w = world(on)
  w.coverageLine = `saw 1 of 3 files‮​\u001b[31m`
  corpus(w, ['events.jsonl'])
  reads(w)
  await startSession($, w)
  await aTurn($, w, 'r1', 'It holds events.', async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  })
  const ui = await $.ui.mount({ plugin: 'thimble', component: 'AssistantMessage', requestId: 'r1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'It holds events.', isFirstOfReply: true } } as never)
  const text = shown(await ui.drawn())
  expect(text).toContain('▸ saw 1 of 3 files')
  expect(text).not.toMatch(/[\u001b‮​]/)
  await ui.unmount()
})

test("activate:failed's toast says the reason cleaned", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.activate = { ok: false, error: { code: 'IO', message: 'disk ‮full\u001b[0m', fix: 'free some space' } }
  await startSession($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  expect(w.toasts).toContain('thimble could not open this folder: disk full')
})
