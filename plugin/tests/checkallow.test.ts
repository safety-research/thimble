// thimble's answer at tool.check (marks/register.ts, marks/checker.ts allowsCheck). Once the person let thimble start
// its checks of citations (g, or x on a failed citation), thimble answers Claude Code's own ask on a checker's spawn of
// its own with allow; a deny, an ask a rule, a hook, a setting or another plugin made, Claude's own call of a subagent,
// another plugin's call and thimble's other forks stay as Claude Code decides. The OK also covers its checker forks'
// Python, a Bash call that runs one script with python3 or python, never main's or another agent's. Where don't ask mode
// refuses that Python (it starts the fork), the citations the check could not judge wait, and the line offers g. Where
// Claude Code refused a check's read of a file asking nobody, x gives the person's OK for that file alone. Neither OK
// answers an ask Claude Code puts to someone. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { failLineNow } from '../bar/notice'
import { spawnFork } from '../core/forks'
import { AGAIN_DESCRIPTION, autoRepair, checkKey, endCheck, launchRepair, noteRow, REPAIR_DESCRIPTION, repairOf, repairOk, startCheck, TOUR_DESCRIPTION, waitingCheck } from '../marks/checker'
import { registerMarks } from '../marks/register'
import { newReply, rowMarks } from '../marks/store'
import { setOptions } from '../settings/features.mjs'
import { tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const THIMBLE = { plugin: 'thimble', tier: 'user' }
const ENGINE = { plugin: 'engine', tier: 'core' }

/** The marks module's tool.check hooks over Claude Code's verdict, in a session where the person gave the OK
 *  (`allowed`) or not. */
function setup(allowed: boolean) {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    const reg: Any = { catch: () => reg }
    return reg
  }
  registerMarks(on, {} as never)
  const state = new Map<string, unknown>([[JSON.stringify({ plugin: 'thimble', key: 'checksAllowed' }), allowed ? true : null]])
  const $: Any = {
    state: { get: async (k: Any) => ({ value: state.get(JSON.stringify(k)), version: 0 }), set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true, version: 1 } } },
  }
  /** The verdict on a spawn whose Agent call `input` was raised by `origin`, over Claude Code's own (`verdict`). */
  const check = (input: Any, verdict: Any, origin: Any = THIMBLE): Promise<Any> => {
    const chain = hooks['tool.check'] ?? []
    const run = (i: number, e: Any): Any => (i < chain.length ? chain[i]($, e, Object.assign((x: Any) => run(i + 1, x), { origin, called: false })) : verdict)
    return run(0, { tool: 'Agent', tool_use_id: 'toolu_plugin_1', input })
  }
  return { check }
}

const spawn = (description: string, subagent_type: string | undefined = 'fork') => ({ prompt: 'Check the citations of your last reply.', description, ...(subagent_type ? { subagent_type } : {}) })
/** Claude Code's own ask on a subagent it has no rule for, as a tool.check hook reads it: no plugin, rule or hook. */
const ASK = { decision: 'ask', reason: "Claude requested permissions to use Agent, but you haven't granted it yet." }

test("with the person's OK, thimble answers Claude Code's own ask on its checks with allow, and on nothing else: never over the person's rules, a setting or another plugin's ask, nor on another's call; with no OK, on none", async () => {
  const { check } = setup(true)
  for (const d of ['checking citations', 'checking a citation', REPAIR_DESCRIPTION, AGAIN_DESCRIPTION]) {
    const v = await check(spawn(d), ASK)
    expect(v.decision).toBe('allow')
    expect(String(v.reason)).toContain('allowed this session')
  }
  const ours = spawn('checking citations')
  // a deny rule, and an ask a rule, a classic hook, a setting or another plugin made, stand
  expect((await check(ours, { decision: 'deny', reason: "Agent type 'fork' has been denied", rule: 'Agent(fork)' })).decision).toBe('deny')
  expect((await check(ours, { decision: 'ask', rule: 'Agent' })).decision).toBe('ask')
  expect((await check(ours, { decision: 'ask', hook: 'PreToolUse' })).decision).toBe('ask')
  expect((await check(ours, { decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' })).decision).toBe('ask')
  expect((await check(ours, { decision: 'ask', reason: 'made-up-guard holds new agents', plugin: 'made-up-guard' })).decision).toBe('ask')
  // Claude's own call of a subagent, worded as a check; another plugin's; thimble's other forks; another agent type
  expect((await check(ours, ASK, ENGINE)).decision).toBe('ask')
  expect((await check(ours, ASK, { plugin: 'made-up-helper', tier: 'user' })).decision).toBe('ask')
  for (const d of ['designing a card', 'a side thread', 'publishing a card']) expect((await check(spawn(d), ASK)).decision).toBe('ask')
  expect((await check(spawn('checking citations', 'general-purpose'), ASK)).decision).toBe('ask')
  // with no OK from the person, Claude Code's ask on thimble's checks stays Claude Code's to settle
  const none = setup(false)
  for (const d of ['checking citations', 'checking a citation', REPAIR_DESCRIPTION, AGAIN_DESCRIPTION]) expect((await none.check(spawn(d), ASK)).decision).toBe('ask')
})

/** Claude Code 2.1.307's refusal of a fork a plugin's hook spawned, where auto mode's classifier must judge it and runs
 *  on Anthropic's server, which judges only the calls in Claude's own replies. */
const AUTO = "The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don't require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used."
const REPLY = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#); the [slow mirror](#) was down for [3 nights](#).'

/** An engine with versioned state, the checker's text, and forks that Claude Code refuses with the words `refused` gives
 *  for the spawn, or starts; the validator gives `results` for a check's marks, and names no file the check could not
 *  read as one no evidence may cite. No made-up path is there when read. */
function engine(refused: (spawn: Any) => string | null | Promise<string | null>, results: (marks: Any[]) => Any[] = () => []) {
  const state = new Map<string, { value: unknown; version: number }>()
  const spawned: Any[] = []
  let now = 1000
  const validated = (req: Any) => ({ parsed: true, results: results(req.marks), ...(req.unread ? { outside: [] } : {}) })
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { cwd: async () => '/made-up/data', id: async () => 's-allow', messages: async () => [] },
    fs: {
      read: async (p: string) => { if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}'; throw new Error(`no file ${p}`) },
      write: async () => undefined,
      list: async () => [],
      exists: async () => false,
      stat: async (p: string) => { throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' }) },
    },
    process: {
      run: async (argv: string[], o?: { stdin?: string }) => tempRun(argv)
        ?? (argv.includes('validate') && o?.stdin ? { exitCode: 0, stdout: JSON.stringify(validated(JSON.parse(o.stdin))), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
    },
    agent: {
      spawn: async (a: Any) => { spawned.push(a); const deny = await refused(a); return deny ? { deny } : { model: 'claude-made-up', agentId: `agent-${spawned.length}` } },
      list: async () => [],
    },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown, o?: { ifVersion?: number }) => {
        const cur = state.get(JSON.stringify(k))
        if (o?.ifVersion !== undefined && o.ifVersion !== (cur?.version ?? 0)) return { isSet: false, version: cur?.version ?? 0 }
        const version = (cur?.version ?? 0) + 1
        state.set(JSON.stringify(k), { value, version })
        return { isSet: true, version }
      },
    },
    clock: { now: async () => (now += 100), after: () => ({ cancel() {} }), every: () => ({ cancel() {} }), sleep: async () => undefined },
    ui: { invalidate: () => undefined },
  }
  return { $, spawned }
}

/** A failed citation of row-1, whose check found it wrong. */
const FAILED = { n: 1, row: 'row-1', words: '40', start: 7, end: 14, sentence: REPLY, status: 'failed', failedBy: 'check', shown: '40', reason: 'The log counts 39 runs.' }
const failedReply = (items: Any[] = [FAILED]) => ({ key: 'row-1', turnId: 't-1', rows: ['row-1'], startedAt: 1000, settledAt: 1100, items }) as never
const itemOf = async ($: Any, n = 1) => (await rowMarks($, 'row-1'))!.items.find(m => m.n === n)!

/** A file outside the session's folders, which the made-up validator takes as evidence unless a test names it
 *  `outside`, and Claude Code's refusals of a check's read of it: in don't ask mode, the person's no to its dialog, a
 *  rule of theirs. */
const ELSEWHERE = '/made-up/elsewhere/runs.csv'
const READ_DONT_ASK = "Permission to use Read has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal. "
const READ_RULE = 'Permission to use Read has been denied by your rule Read(//made-up/elsewhere/**).'
/** A read Claude Code refused, as its tool.call answers it: an error, its words as the model reads them. */
const refusedRead = (said: string) => ({ result: said, isError: true, text: said })
/** The validator's results: the first three marks not confirmed, for want of ELSEWHERE, which their reason names; the
 *  others verified. */
const FIRST_THREE = (marks: Any[]) => marks.map(m => (m.n <= 3 ? { n: m.n, status: 'failed', failedBy: 'evidence', shown: m.words, reason: `${ELSEWHERE} holds the runs, but the check could not read it.` } : { n: m.n, status: 'verified', shown: m.words, reason: 'counted' }))

/** The marks module's hooks on `$`: `call(event, e, below)` runs the event's chain over Claude Code's answer `below`
 *  (a verdict, a result; a function gives it anew at each `next`, as Claude Code runs its core again), as Claude Code
 *  raises it for thimble's own fork, or for a call `origin` raised. */
function hooksOn($: Any) {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    const reg: Any = { catch: () => reg }
    return reg
  }
  registerMarks(on, {} as never)
  return (event: string, e: Any, below: Any, origin: Any = ENGINE): Promise<Any> => {
    const chain = hooks[event] ?? []
    const run = async (i: number, x: Any): Promise<Any> => (i < chain.length ? chain[i]($, x, Object.assign((y: Any) => run(i + 1, y), { origin, called: false })) : typeof below === 'function' ? below(x) : below)
    return run(0, e)
  }
}

/** A reply's check (its two forks: agent-1 for marks 1 to 3, agent-2 for 4 and 5) in which agent-1's read of ELSEWHERE
 *  ends as Claude Code answers it (`read`), then both end; the validator fails marks 1 to 3. */
async function checkThatReads($: Any, call: Any, read: Any): Promise<void> {
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await call('tool.call', { tool: 'Read', file_path: ELSEWHERE, agentId: 'agent-1', tool_use_id: 'toolu_r1' }, read)
  // a file that is not there is no refusal of a permission
  await call('tool.call', { tool: 'Read', file_path: '/made-up/data/gone.csv', agentId: 'agent-1', tool_use_id: 'toolu_r2' }, refusedRead('File does not exist.'))
  for (const agentId of ['agent-1', 'agent-2']) await endCheck($, { agentId, reason: 'answer', answer: '```json\n[]\n```' })
}

test("a check that could not read a file, which Claude Code refused asking nobody: each citation it leaves failed names the file, none is repaired by itself, and x's OK for it makes thimble answer allow on its checks' reads of that file, and of nothing else", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    const { $, spawned } = engine(() => null, FIRST_THREE)
    const call = hooksOn($)
    await checkThatReads($, call, refusedRead(READ_DONT_ASK))
    expect(spawned.length).toBe(2)
    const items = (await rowMarks($, 'row-1'))!.items
    expect(items.map(m => m.status)).toEqual(['failed', 'failed', 'failed', 'verified', 'verified'])
    const unread = [{ tool: 'Read', file: ELSEWHERE, fix: 'ok' }]
    expect(items.map(m => m.unread)).toEqual([unread, unread, unread, undefined, undefined])
    // none is repaired by itself: what refused the read would refuse the repair's
    await autoRepair($, 'agent-1')
    expect(spawned.length).toBe(2)
    // a check's read of the file, as Claude Code asks about it
    const read = (agentId: string | null, file = ELSEWHERE, v: Any = ASK) => call('tool.check', { tool: 'Read', input: { file_path: file }, tool_use_id: 'toolu_r3', ...(agentId ? { agentId } : {}) }, v)
    expect((await read('agent-1')).decision).toBe('ask')
    // x: the OK for the file, so thimble answers allow on its checks' reads of it
    const ok = (await repairOk($, items[0]!))!
    await ok.give()
    expect(await read('agent-1')).toMatchObject({ decision: 'allow' })
    expect((await read('agent-2')).decision).toBe('allow')
    // of nothing else: another file, main's own read, another agent's; a deny, and an ask a rule made, stand
    expect((await read('agent-1', '/made-up/elsewhere/other.csv')).decision).toBe('ask')
    expect((await read(null)).decision).toBe('ask')
    expect((await read('agent-someone')).decision).toBe('ask')
    expect((await read('agent-1', ELSEWHERE, { decision: 'deny', reason: READ_RULE, rule: 'Read(//made-up/elsewhere/**)' })).decision).toBe('deny')
    expect((await read('agent-1', ELSEWHERE, { decision: 'ask', rule: 'Read(//made-up/elsewhere/**)' })).decision).toBe('ask')
    // nor an ask Claude Code puts to someone (its event names the approver: the person, a host), which stays theirs
    for (const approver of ['person', 'host']) expect((await call('tool.check', { tool: 'Read', input: { file_path: ELSEWHERE }, tool_use_id: 'toolu_r4', agentId: 'agent-1', approver }, ASK)).decision).toBe('ask')
    // a word after x takes the OK back
    await ok.undo()
    expect((await read('agent-1')).decision).toBe('ask')
    // the repair x starts checks the citation again: its earlier result goes, the file with it
    await ok.give()
    expect(await launchRepair($, (await repairOf($, 'row-1', 1)) as Any, { until: 0, cancelled: false })).toBe('')
    expect(spawned.length).toBe(3)
    expect((await itemOf($)).status).toBe('checking')
    expect((await itemOf($)).unread).toBeUndefined()
  } finally {
    setOptions({})
  }
})

/** A checker's Python, as checker.md asks for it: one script from a here-document, after a `cd` at most. */
const SCRIPT = "cd /made-up/data && python3 - <<'PY'\nimport csv\nprint(sum(1 for r in csv.DictReader(open('runs.csv')) if r['status'] == 'failed'))\nPY"

test("x's OK covers its checker forks' Python too: thimble answers allow on Claude Code's own ask on a checker's Bash call that runs one script with python3 or python, and on nothing else (main's call, another agent's, another fork's of thimble's, a call that runs no Python or runs it otherwise), never over a deny or an ask a rule, a hook, a setting or another plugin made; a word typed after x takes it back", async () => {
  let refuse = true
  const { $, spawned } = engine(() => (refuse ? AUTO : null))
  const call = hooksOn($)
  await newReply($, failedReply())
  // x's repair, refused where auto mode's classifier gives no verdict: then x gives the OK g gives, and the repair runs
  expect(await launchRepair($, (await repairOf($, 'row-1', 1)) as Any, { until: 0, cancelled: false })).toBe('')
  refuse = false
  const ok = (await repairOk($, await itemOf($)))!
  await ok.give()
  expect(await launchRepair($, (await repairOf($, 'row-1', 1)) as Any, { until: 0, cancelled: false })).toBe('')
  const checker = `agent-${spawned.length}`
  const designer = (await spawnFork($, { kind: 'designer', prompt: 'Draw a card of the runs.', description: 'designing a card' })).agentId!
  /** Claude Code's verdict `v` on a Bash call of `agentId`'s (main's when null), as thimble's hooks answer it. */
  const bash = async (command: string, agentId: string | null = checker, v: Any = ASK) => (await call('tool.check', { tool: 'Bash', input: { command }, tool_use_id: 'toolu_b1', ...(agentId ? { agentId } : {}) }, v)).decision
  expect(await bash(SCRIPT)).toBe('allow')
  expect(await bash("python - <<'PY'\nprint(40)\nPY")).toBe('allow')
  // main's call, another agent's, another fork's of thimble's
  expect(await bash(SCRIPT, null)).toBe('ask')
  expect(await bash(SCRIPT, 'agent-someone')).toBe('ask')
  expect(await bash(SCRIPT, designer)).toBe('ask')
  // a call that runs no Python, or runs it otherwise than as one script with python3 or python
  expect(await bash('ls /made-up/data')).toBe('ask')
  expect(await bash("python3 -c 'print(40)'")).toBe('ask')
  expect(await bash("/made-up/bin/python3 - <<'PY'\nprint(40)\nPY")).toBe('ask')
  expect(await bash("python3 - <<'PY'\nprint(40)\nPY\nrm -r /made-up/data")).toBe('ask')
  // a deny, and an ask a rule, a hook, a setting or another plugin made, stand
  expect(await bash(SCRIPT, checker, { decision: 'deny', reason: 'Permission to use Bash with command python3 has been denied.', rule: 'Bash(python3:*)' })).toBe('deny')
  expect(await bash(SCRIPT, checker, { decision: 'ask', rule: 'Bash(python3:*)' })).toBe('ask')
  expect(await bash(SCRIPT, checker, { decision: 'ask', hook: 'PreToolUse' })).toBe('ask')
  expect(await bash(SCRIPT, checker, { decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' })).toBe('ask')
  expect(await bash(SCRIPT, checker, { decision: 'ask', plugin: 'made-up-guard' })).toBe('ask')
  // a word typed after x takes the OK back
  await ok.undo()
  expect(await bash(SCRIPT)).toBe('ask')
})

/** Claude Code's refusal of a call in don't ask mode, as its tool.call answers it. There it starts the checker's fork
 *  (its Agent tool asks for no permission outside auto mode) and refuses the fork's Python, which no rule allows. */
const BASH_DONT_ASK = "Permission to use Bash has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal. "
/** The line that says so, as the person reads it. */
const DONT_ASK_LINE = "Claude Code's don't ask mode refused thimble's check of citations. Press g to allow thimble's checks this session."
const settle = () => new Promise(r => setTimeout(r, 5))

test("where don't ask mode refuses the check's Python and not its fork, the citations the check could not judge wait, not checked, and none is repaired by itself; one line says what refused it and offers g, which gives the OK and starts their check again, whose Python thimble then answers allow; a later reply's check runs with no line", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    // the validator: the check could not confirm marks 1 and 2, found 3 wrong, and verified 4 and 5
    const { $, spawned } = engine(() => null, marks => marks.map(m => (m.n <= 2
      ? { n: m.n, status: 'failed', failedBy: 'evidence', shown: m.words, reason: 'No output shows it.' }
      : m.n === 3 ? { n: 3, status: 'failed', failedBy: 'check', shown: m.words, reason: 'The log names another check.' } : { n: m.n, status: 'verified', shown: m.words, reason: 'counted' })))
    const call = hooksOn($)
    /** A checker's Python as its call ends, as Claude Code answers it (`below`). */
    const python = (agentId: string, below: Any) => call('tool.call', { tool: 'Bash', command: SCRIPT, agentId, tool_use_id: `toolu_${agentId}` }, below)
    const statuses = async (row: string) => (await rowMarks($, row))!.items.map(m => m.status)
    await noteRow($, 'row-1', REPLY)
    await startCheck($, { turnId: 't-1', reason: 'answer' })
    // both forks start (agent-1 for marks 1 to 3, agent-2 for 4 and 5); agent-1's Python is refused, asking nobody
    expect(spawned.length).toBe(2)
    await python('agent-1', refusedRead(BASH_DONT_ASK))
    for (const agentId of ['agent-1', 'agent-2']) await endCheck($, { agentId, reason: 'answer', answer: '```json\n[]\n```' })
    expect(await statuses('row-1')).toEqual(['deferred', 'deferred', 'failed', 'verified', 'verified'])
    // none is repaired by itself: the same refusal would stop the repair's Python
    await autoRepair($, 'agent-1')
    expect(spawned.length).toBe(2)
    expect((await failLineNow($))?.text).toBe(DONT_ASK_LINE)
    // g: the person's OK, and the check of the citations that wait starts again
    const g = (await checkKey($, 'g', 0))!
    await g.now()
    await settle()
    await g.later()
    expect(spawned.length).toBe(3)
    expect(spawned[2]).toMatchObject({ subagentType: 'fork', description: AGAIN_DESCRIPTION })
    expect(spawned[2].prompt).toContain('1. [40]')
    expect(spawned[2].prompt).toContain('2. [12 of 40]')
    expect(spawned[2].prompt).not.toContain('3. [')
    expect(await statuses('row-1')).toEqual(['checking', 'checking', 'failed', 'verified', 'verified'])
    expect(await failLineNow($)).toBeNull()
    // its Python, which Claude Code asks nobody about: thimble answers allow, under the OK
    expect((await call('tool.check', { tool: 'Bash', input: { command: SCRIPT }, tool_use_id: 'toolu_b2', agentId: 'agent-3' }, ASK)).decision).toBe('allow')
    // a later reply's check: its Python runs under the OK; a script that ran and failed is no refusal, whatever its
    // output quotes; no line comes
    await noteRow($, 'row-2', REPLY)
    await startCheck($, { turnId: 't-2', reason: 'answer' })
    expect(spawned.length).toBe(5)
    expect((await call('tool.check', { tool: 'Bash', input: { command: SCRIPT }, tool_use_id: 'toolu_b3', agentId: 'agent-4' }, ASK)).decision).toBe('allow')
    await python('agent-4', { result: '', isError: true, text: `Exit code 1\n${BASH_DONT_ASK}` })
    await python('agent-5', { result: '12', text: '12' })
    for (const agentId of ['agent-4', 'agent-5']) await endCheck($, { agentId, reason: 'answer', answer: '```json\n[]\n```' })
    expect(await statuses('row-2')).toEqual(['failed', 'failed', 'failed', 'verified', 'verified'])
    expect(await failLineNow($)).toBeNull()
  } finally {
    setOptions({})
  }
})

test("the tour's check that c started, whose Python don't ask mode refused: its citations wait, and g checks them again with the words the tour's prompt ended with, since they may stand in an earlier reply than the last", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    // the validator: the check could confirm none of the marks
    const { $, spawned } = engine(() => null, marks => marks.map(m => ({ n: m.n, status: 'failed', failedBy: 'evidence', shown: m.words, reason: 'No output shows it.' })))
    const call = hooksOn($)
    // the tour holds its sample answer's check (tour/tour.ts tourHolds), and c starts it (waitingCheck)
    await noteRow($, 'row-1', 'Customers placed [36 orders](#) in March 2026. Most were loose-leaf tins, worth [$52](#). The shop refunded [7 orders](#).')
    await startCheck($, { turnId: 't-1', reason: 'answer' }, async () => true)
    expect(spawned.length).toBe(0)
    await (await waitingCheck($, 'row-1'))!({ until: 0, cancelled: false })
    expect(spawned.map(a => a.description)).toEqual([TOUR_DESCRIPTION])
    const note = String(spawned[0].prompt).split('\n\n').pop()!
    expect(note).toContain('earlier reply')
    // don't ask mode refuses its fork's Python, asking nobody
    await call('tool.call', { tool: 'Bash', command: SCRIPT, agentId: 'agent-1', tool_use_id: 'toolu_agent-1' }, refusedRead(BASH_DONT_ASK))
    await endCheck($, { agentId: 'agent-1', reason: 'answer', answer: '```json\n[]\n```' })
    expect((await rowMarks($, 'row-1'))!.items.map(m => m.status)).toEqual(['deferred', 'deferred', 'deferred'])
    expect((await failLineNow($))?.text).toBe(DONT_ASK_LINE)
    // g: the check of the citations that wait starts again, its prompt ending with the tour's words
    const g = (await checkKey($, 'g', 0))!
    await g.now()
    await settle()
    expect(spawned.slice(1).map(a => a.description)).toEqual([AGAIN_DESCRIPTION])
    expect(String(spawned[1].prompt).endsWith(`\n\n${note}`)).toBe(true)
  } finally {
    setOptions({})
  }
})
