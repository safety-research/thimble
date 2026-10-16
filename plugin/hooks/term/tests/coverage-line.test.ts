// The coverage line under an answer that read data (SPEC-v2 3.9): one dim row `▸ <line>` after the footer, only for
// turns with facts; with "Coverage" off no facts are kept or sent and no line is drawn. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { CWD, aTurn, call, corpus, reads, shown, startSession, world } from './fixtures'

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
