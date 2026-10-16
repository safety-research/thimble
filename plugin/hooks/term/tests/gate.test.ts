// Before thimble is on (SPEC-v2 3.2 S0, 5.5 item 1, S6): the terminal UI loads in every session and stays quiet. A
// coding session draws nothing, starts no timer, runs no process, writes no file and sets no state; a data read turns
// nothing on where no person is at the terminal, or with "Turn on when Claude reads data" off. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { CWD, HOME, call, corpus, reads, shown, startSession, world } from './fixtures'

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const ABOVE = { plugin: 'thimble', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 130, scroll: { bodyRows: 10 }, view: {} } } as never

test('a coding session (src/a.py, package.json, a 2 MB src/big.json) draws nothing, starts no timer, runs no process, writes nothing', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { active: false })
  // a code tree: package.json at the folder's root
  w.stamps.set(`${CWD}/package.json`, 1)
  w.sizes.set(`${CWD}/src/big.json`, 2 * 1024 * 1024)
  w.sizes.set(`${CWD}/src/a.py`, 400)
  reads(w)
  let fetched = 0
  on('http.fetch', { url: /^/ }, ($, e, next) => {
    fetched++
    return next(e)
  })
  await startSession($, w)
  await call($, 'Read', { file_path: `${CWD}/src/a.py` })
  await call($, 'Read', { file_path: `${CWD}/package.json` })
  await call($, 'Read', { file_path: `${CWD}/src/big.json` })
  await call($, 'Bash', { command: 'cat src/big.json | head -n 3' })
  await call($, 'Edit', { file_path: `${CWD}/src/a.py`, old_string: 'a', new_string: 'b' })
  await w.clock.advance(5000)
  expect(w.calls).toEqual([])
  expect(w.writes).toEqual([])
  expect(fetched).toBe(0)
  expect(w.stateSets).toEqual([])
  expect(w.timers).toBe(0)
  expect(w.mcp).toEqual([])
  const ui = await $.ui.mount(MESSAGE('m1', 'The export holds [4579](card:ff73e071#pages/TOTAL) pages.'))
  expect(shown(await ui.drawn())).toBe('(the engine row)')
  await ui.unmount()
  const above = await $.ui.mount(ABOVE)
  expect(shown(await above.drawn())).toBe('(the engine row)')
  await above.unmount()
})

test('a data read turns nothing on where no person is at the terminal: not interactive, or another surface', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['events.jsonl'])
  await startSession($, w, { isInteractive: false })
  await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  expect(w.activations).toEqual([])
  await startSession($, w, { surface: 'desktop' })
  await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  expect(w.activations).toEqual([])
  await startSession($, w, { surface: null })
  await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  expect(w.activations).toEqual([])
  expect(w.calls).toEqual([])
})

test("\"Turn on when Claude reads data\" off in thimble's config.json stops activation before any process; an unpushed /config change wins", { timeoutMs: 30000 }, async ($, on) => {
  // off in the browser's Settings (config.json), on in /config and synced so: no activation
  const w = world(on, { active: false, store: { 'settings.synced': { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true } } })
  w.files.set(`${HOME}/config.json`, JSON.stringify({ features: { autoActivate: false } }))
  reads(w)
  corpus(w, ['events.jsonl', 'prs.csv'])
  await startSession($, w)
  await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  await call($, 'Read', { file_path: `${CWD}/prs.csv` })
  expect(w.calls).toEqual([])
  expect(w.activations).toEqual([])
})
