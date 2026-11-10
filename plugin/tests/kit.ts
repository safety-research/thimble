// The hooks tests' test(): the kit's, with a time limit of ENGINE_MS for a test whose body takes the engine's `$`. A
// test whose body takes nothing (pure functions) keeps the kit's 5 s, and a test that sets its own timeoutMs keeps it.
//
// Why: the kit (claude plugin test) gives a test 5 s of wall-clock time unless the test sets its own limit. A test
// that takes `$` loads the whole plugin into a fresh seat at its first `$` call, which takes about 0.7 s of CPU (the
// hooks module's graph is evaluated and registered again in each seat; an empty hooks module loads in 15 ms), and
// 1.5 to 2 s for the first such test of a file, whose process compiles the graph first. All else such a test does is
// CPU work too, because its waits are on mock.clock or on hooks the test answers. So its time is its CPU time,
// stretched by the machine's load: 2 to 6 times longer with two or three runs of the tests on two CPUs, as on a CI
// runner shared with other jobs, which goes past 5 s. The 5 s limit then measured the machine, not the test. The
// slowest such test took 25 s with three runs on two CPUs, and 42 s with other jobs on those CPUs too; ENGINE_MS is
// 120 s, the limit of the node and pytest tests here.
//
// Why such a test cannot hang: mock.clock moves only when the test advances it (an advance throws once it fired
// 10,000 waits), the engine lets a hook go once it held a wait past its own budget of 10 s, and an effect the test did
// not answer throws (the kit's bottom hook), so no test waits on real time, a real process or the network. A test that
// awaits what never comes still fails, with its name, after ENGINE_MS. That budget of 10 s is real time, so a mock that
// stands for something that hangs holds each wait for a short part of the test only.
//
// On a Claude Code older than an event a test's hooks answer (NEWER_EVENTS: ui.place, which places the tour's rows), the
// test's hooks do not load: its first call on `$` throws that the event is not an event. thimble runs on such a Claude
// Code (kernel/doctor.py CLAUDE_CODE_MIN) without its tour, so there the test checks nothing and says so; CI runs it on
// a Claude Code that has the event too (.github/workflows/ci.yml).
import { test as kitTest, type TestBody, type TestOptions, type TestRest } from 'claude-code/testing'

export const ENGINE_MS = 120_000

/** Events newer than the oldest Claude Code thimble runs on, each with the first version that has it. */
export const NEWER_EVENTS: Record<string, string> = { 'ui.place': '2.1.314' }

/** The event of NEWER_EVENTS that kept the test's own hooks from loading on this Claude Code, or null. */
function newerEvent(err: unknown): string | null {
  const m = /\btest: hooks module did not load: .*?"([\w.]+)" is not an event/.exec(String(err))
  return m && m[1]! in NEWER_EVENTS ? m[1]! : null
}

export function test(name: string, ...rest: TestRest): void {
  const [options, body]: [TestOptions, TestBody] = rest.length === 1 ? [{}, rest[0]] : [rest[0], rest[1]]
  if (body.length === 0) kitTest(name, ...rest)
  else kitTest(name, { timeoutMs: ENGINE_MS, ...options }, async ($, on) => {
    try {
      return await body($, on)
    } catch (err) {
      const e = newerEvent(err)
      if (!e) throw err
      console.log(`checks nothing on this Claude Code, which has no ${e} (${NEWER_EVENTS[e]} has it): ${name}`)
    }
  })
}
