// An idle session costs about nothing: a session Claude Code's background service runs (a pre-warmed spare, a
// background job), which no person's terminal shows at its start, starts no thimble process until a person's first
// prompt; and in a session thimble is on in, the hooks module's own files (module.json, its heartbeat) are no change
// the refresh loop reads anything again for. A tester's idle pre-warmed session read `thimble state agents` and
// `thimble state home` again at every heartbeat of the module, two Python processes every 2 s. `claude plugin test
// plugin`.
import { expect, test } from 'claude-code/testing'

import { CLI, CWD, GUIDE, SID, WS, corpus, reads, startSession, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }

test("a session of Claude Code's background service starts nothing until a person's first prompt, which turns thimble on with the guide", SLOW, async ($, on) => {
  const w = world(on, { active: false, env: { CLAUDE_CODE_SESSION_KIND: 'bg' } })
  reads(w)
  corpus(w, ['events.jsonl'])
  await startSession($, w)
  await w.clock.advance(10_000)
  await w.clock.settle()
  expect(w.activations).toEqual([])
  expect(w.calls).toEqual([])
  // a task's notification is no person
  await $.prompt.submit({ text: 'a background task ended', origin: { kind: 'task-notification' }, wait: false } as never)
  expect(w.activations).toEqual([])
  const p = (await $.prompt.submit({ text: 'what is in this folder?', origin: { kind: 'composer' }, wait: false } as never)) as { context?: string[] }
  expect(w.activations).toEqual([[CLI, 'activate', '--cwd', CWD, '--session', SID, '--via', 'start', '--mod', '--json']])
  expect(p.context).toEqual([GUIDE])
})

test("the hooks module's writes of module.json and its heartbeat read nothing again; a change of subagents.json reads the agents", SLOW, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  await w.clock.advance(3000)
  await w.clock.settle()
  const stateReads = () => w.calls.filter(c => c[1] === 'state')
  const before = stateReads().length
  for (let beat = 2; beat < 8; beat++) {
    w.stamps.set(`${WS}/trusted/module.json`, beat)
    w.stamps.set(`${WS}/trusted/module-beat.json`, beat)
    await w.clock.advance(2000)
    await w.clock.settle()
  }
  expect(stateReads().length).toBe(before)
  w.stamps.set(`${WS}/trusted/subagents.json`, 9)
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(stateReads().slice(before).map(c => c[2])).toContain('agents')
})
