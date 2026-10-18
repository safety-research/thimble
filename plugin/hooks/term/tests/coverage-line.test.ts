// Coverage at a turn's end (SPEC-v2 3.9): a turn that read data sends what its calls saw, once, and the session's
// summary it gets back is what the thimble line's `coverage` shows; no line stands under the answer (coverage lives in
// the thimble line: the owner's live test, 10-17). With "Coverage" off no facts are kept or sent. `claude plugin test
// plugin`.
import { expect, test } from 'claude-code/testing'

import { CWD, aTurn, call, corpus, reads, shown, startSession, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }
const MESSAGE = (requestId: string, text: string, fullscreen = false) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40, isFullscreen: fullscreen }, props: { text, isFirstOfReply: true } }) as never
const ABOVE = { plugin: 'thimble', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {}, bodyColumns: 140 } } as never

test('a turn that read data sends its facts once and the thimble line shows the coverage; no line stands under the answer', SLOW, async ($, on) => {
  const w = world(on)
  corpus(w, ['events.jsonl'])
  reads(w)
  await startSession($, w)
  const answer = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages.'
  await aTurn($, w, 'r1', answer, async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  })
  expect(w.coverage.length).toBe(1)
  // no `▸` line under the answer, in the main screen or in fullscreen
  for (const fullscreen of [false, true]) {
    const ui = await $.ui.mount(MESSAGE('r1', answer, fullscreen))
    expect(shown(await ui.drawn())).not.toContain('▸ ')
    expect(JSON.stringify(await ui.drawn())).not.toContain('"key":"coverage-r1"')
    await ui.unmount()
  }
  // the summary the turn got back is the thimble line's (no index yet: the files read)
  const band = await $.ui.mount(ABOVE)
  expect(shown(await band.find({ type: 'Box', key: 'above-summary' }))).toContain('coverage 1 of 3 files')
  await band.unmount()
})

test('"Coverage" off: no facts are kept or sent, and nothing stands under the answer', { ...SLOW, options: { coverage: false } }, async ($, on) => {
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

test('a blank row stands between Claude Code\'s working row and the thimble line while a turn runs, and none when idle', SLOW, async ($, on) => {
  const w = world(on)
  corpus(w, ['events.jsonl'])
  reads(w)
  await startSession($, w)
  await aTurn($, w, 'r1', 'It holds events.', async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  })
  const working = await $.ui.mount({ ...(ABOVE as object), props: { ...(ABOVE as { props: object }).props, isWorking: true } } as never)
  const gap = '{"type":"Text","children":[" "]},{"type":"Box","props":{"key":"above-summary"'
  expect(JSON.stringify(await working.drawn())).toContain(gap)
  await working.unmount()
  const idle = await $.ui.mount(ABOVE)
  expect(JSON.stringify(await idle.drawn())).not.toContain(gap)
  await idle.unmount()
})
