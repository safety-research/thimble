// Every data-derived string the terminal draws goes through clean() (SPEC-v2 S8): a terminal's escape sequences (an OSC
// 8 link, a color), C0 and C1 controls, the bidi controls and marks, the zero-width characters and U+FEFF are left out:
// in a check's name and comment, and in a notice's row above the prompt. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { clean } from '../lib'
import { answerCommentOf } from '../term'
import { shown, startSession, world } from './fixtures'

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

test("a notice's words and a view proposal's name and description above the prompt draw no control, bidi or zero-width character", SLOW, async ($, on) => {
  const w = world(on)
  w.states.home = {
    ...w.states.home,
    notices: [{ id: 'n1', key: 'agent:view:x', kind: 'agent', text: `The build failed: ${BAD}`, agent: 'View build: x', chat: '', at: '2026-10-17T00:00:00Z', acts: [] }],
    offer: { slug: 'pages', name: 'Pa\u202ege\u200bs', description: BAD, task: 'Find the pages.', claims: [] },
  } as never
  await startSession($, w)
  const ui = await $.ui.mount({ plugin: 'thimble', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 150, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {}, bodyColumns: 150 } } as never)
  const text = shown(await ui.drawn())
  expect(text).toContain('The build failed: alink red bevil cd zwjk.')
  expect(text).toContain('Pages  alink red bevil cd zwjk.')
  expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u200b-\u200f\u2066-\u2069\ufeff]/)
  await ui.unmount()
})
