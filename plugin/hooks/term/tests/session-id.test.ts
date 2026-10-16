// The session id is read per call (SPEC-v2 3.21): an activation, the guide and the coverage facts name the
// conversation's id at the moment they run, never one read once at the start. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { CWD, aTurn, call, corpus, reads, startSession, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }

test('activation and the guide name the session id of the moment, and the coverage facts too', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  corpus(w, ['events.jsonl'])
  reads(w)
  await startSession($, w)
  // the id changed after the start (a fork of the conversation, a /resume): the next call reads it anew
  w.sid = 's9'
  await aTurn($, w, 'r1', 'It holds events.', async () => {
    await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  })
  expect(w.activations[0]).toContain('s9')
  expect(w.coverage[0]!.session).toBe('s9')
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  const guideRuns = w.calls.filter(c => c[1] === 'guide')
  for (const g of guideRuns) expect(g[g.indexOf('--session') + 1]).toBe('s9')
})
