// Why a run of the thimble command gave no result, in the person's words (core/why.js runWhy): Claude Code's error
// names its own call and the command's path, which the failure line never shows. The paths are made up.
//   node --test plugin/core/test/why.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runWhy } from '../why.js'

const CALL = 'thimble: $.process.run(/made-up/plugin/bin/thimble)'

test("a failed run says why in the person's words: stopped by Claude Code, past its time limit, or unable to start, never the call or the path; any other error as it was", () => {
  // a run Claude Code stopped says so, and when that happens, never the call or the path
  {
    const said = runWhy(new Error(`${CALL} aborted`))
    assert.equal(said, 'Claude Code stopped it before it finished, as it does when thimble reloads or the session ends')
    // as the failure line got it: the call's name on a line of its own
    assert.equal(runWhy(new Error(`thimble:\n$.process.run(/made-up/plugin/bin/thimble) aborted`)), said)
  }
  // a run past its time limit says the limit in minutes or seconds
  {
    assert.equal(runWhy(new Error(`${CALL} aborted: still running after 600000ms`)), 'it ran longer than 10 minutes, the most it may take, and was stopped')
    assert.equal(runWhy(new Error(`${CALL} aborted: still running after 90000ms`)), 'it ran longer than 90 seconds, the most it may take, and was stopped')
  }
  // a run that could not start says its reason without the call
  {
    assert.equal(runWhy(new Error(`${CALL} failed to start: ENOENT: no such file or directory`)), 'the thimble command could not start (ENOENT: no such file or directory)')
  }
  // any other error is kept as it was
  {
    assert.equal(runWhy(new Error('made-up: the disk is full')), 'made-up: the disk is full')
    assert.equal(runWhy('made-up words'), 'made-up words')
  }
})

