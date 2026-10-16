// The coverage line under an answer that read data (SPEC-v2 3.9): one dim row `▸ <line>` after the footer (right under
// the answer when there is no footer), only for turns with facts, none with "Coverage" off; in fullscreen a press opens
// the panel's Coverage view; the session's summary read again when the coverage folder changes. `claude plugin test
// plugin`.
import { expect, test } from 'claude-code/testing'

import { CWD, WS, aTurn, call, corpus, reads, shown, startSession, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }
const MESSAGE = (requestId: string, text: string, fullscreen = false) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40, isFullscreen: fullscreen }, props: { text, isFirstOfReply: true } }) as never

test('a turn that read data ends with one dim coverage line after its footer; a turn that read none has no line', SLOW, async ($, on) => {
  const w = world(on)
  corpus(w, ['events.jsonl'])
  reads(w)
  await startSession($, w)
  const answer = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages.'
  await aTurn($, w, 'r1', answer, async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  })
  const ui = await $.ui.mount(MESSAGE('r1', answer))
  const json = JSON.stringify(await ui.drawn())
  expect(shown(await ui.drawn())).toContain('▸ saw 1 of 3 files')
  // after the footer, dim, at the reply's text column
  expect(json.indexOf('"key":"footer-r1"')).toBeGreaterThan(-1)
  expect(json.indexOf('"key":"coverage-r1"')).toBeGreaterThan(json.indexOf('"key":"footer-r1"'))
  expect(json).toMatch(/"key":"coverage-r1","marginLeft":2,"flexDirection":"row"\},"children":\[\{"type":"Text","props":\{"dimColor":true/)
  await ui.unmount()
  // a turn that read nothing: no line
  await aTurn($, w, 'r2', 'Nothing else to read.')
  const other = await $.ui.mount(MESSAGE('r2', 'Nothing else to read.'))
  expect(shown(await other.drawn())).not.toContain('▸ ')
  await other.unmount()
})

test('with no footer the line stands right under the answer, one blank row above it; in fullscreen it is a press that opens Coverage', SLOW, async ($, on) => {
  const w = world(on)
  corpus(w, ['events.jsonl'])
  reads(w)
  await startSession($, w)
  await aTurn($, w, 'r1', 'It holds events.', async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  })
  const ui = await $.ui.mount(MESSAGE('r1', 'It holds events.', true))
  const json = JSON.stringify(await ui.drawn())
  expect(json).toContain('"key":"coverage-r1","marginLeft":2,"marginTop":1')
  expect(json).not.toContain('"key":"footer-r1"')
  await ui.press({ key: 'coverage-open-r1' })
  await w.clock.settle()
  expect(w.panes.at(-1)).toMatchObject({ id: 'thimble', title: 'Coverage' })
  await ui.unmount()
})

test('"Coverage" off: no facts are kept or sent and no line is drawn', { ...SLOW, options: { coverage: false } }, async ($, on) => {
  const w = world(on)
  w.features.coverage = false
  corpus(w, ['events.jsonl'])
  reads(w)
  await startSession($, w)
  await aTurn($, w, 'r1', 'It holds events.', async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  })
  expect(w.coverage.length).toBe(0)
  const ui = await $.ui.mount(MESSAGE('r1', 'It holds events.'))
  expect(shown(await ui.drawn())).not.toContain('▸ ')
  await ui.unmount()
})

test("the session's coverage summary is read again when the coverage folder changes (a record count that ended)", SLOW, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  const before = w.calls.filter(c => c[1] === 'state' && c[2] === 'coverage').length
  w.stamps.set(`${WS}/coverage/s1.jsonl`, 5)
  await w.clock.advance(1100)
  const runs = w.calls.filter(c => c[1] === 'state' && c[2] === 'coverage')
  expect(runs.length).toBe(before + 1)
  expect(runs.at(-1)).toContain('--summary')
  expect(runs.at(-1)).toContain('s1')
})
