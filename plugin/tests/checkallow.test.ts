// thimble's answer at tool.check on a spawn (marks/register.ts, marks/checker.ts allowsCheck). Once the person let
// thimble start its checks of citations (g on the line of a check Claude Code refused where nobody was asked: auto
// mode's classifier gave no verdict, or don't ask mode), thimble answers Claude Code's own ask on a checker's spawn of
// its own with allow. A deny (a deny rule), an ask a rule, a classic hook, a setting or another plugin made, Claude's
// own call of a subagent however it is worded, another plugin's call, and thimble's other forks stay as Claude Code
// decides. An ask another plugin made reaches thimble's hook as Claude Code 2.1.307 settles it, naming that plugin: its
// own ask, and one only the person may answer (`decider: 'person'`) alike. x on a failed citation gives that OK too
// while Claude Code's refusal of the checks stands. A check that could not read a file, which Claude Code refused,
// leaves that file on the citations it fails whose check needed it (a check of one citation needed it; of several, the
// citations whose answer names the file); its other citations are repaired as any are. Where Claude Code asked nobody,
// x gives the person's OK for the file, and thimble answers Claude Code's own ask on its checks' reads of that file
// with allow, by the tool that was refused (a Read of it, or a Grep of it alone; a Grep of a folder, or a Glob, gets no
// OK); where the person said no to its ask, x gives none, and Claude Code asks again. A file no evidence may cite, as
// the validator says (outside every folder it takes a cited file from), goes on no citation: they keep the validator's
// reason, x gives no OK for it, and they are repaired as any are. The OK for thimble's checks also covers its checker
// forks' Python, which don't ask mode refuses: a Bash call that runs one script with python3 or python, as the browser
// workbench's checker may, never main's or another agent's. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { failLineNow } from '../bar/notice'
import { spawnFork } from '../core/forks'
import { AGAIN_DESCRIPTION, allowsCheck, autoRepair, checkKey, endCheck, launchRepair, noteRow, REPAIR_DESCRIPTION, repairOf, repairOk, startCheck, UNREVIEWED_LINE } from '../marks/checker'
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

test("with the person's OK, Claude Code's own ask on each kind of thimble's checks (a reply's, an opened citation's, x's repair, g's again) is answered allow", async () => {
  const { check } = setup(true)
  for (const d of ['checking citations', 'checking a citation', REPAIR_DESCRIPTION, AGAIN_DESCRIPTION]) {
    const v = await check(spawn(d), ASK)
    expect(v.decision).toBe('allow')
    expect(String(v.reason)).toContain('allowed this session')
  }
  // a fork, named as one or by Claude Code's default; Claude Code's ask with no reason
  expect((await check(spawn('checking citations', undefined), ASK)).decision).toBe('allow')
  expect((await check(spawn('checking citations'), { decision: 'ask' })).decision).toBe('allow')
})

test("thimble's allow never overrides the person's rules, a setting, another plugin's ask, nor answers another's call", async () => {
  const { check } = setup(true)
  const ours = spawn('checking citations')
  // a deny rule, and an ask a rule, a classic hook or a setting made
  expect((await check(ours, { decision: 'deny', reason: "Agent type 'fork' has been denied", rule: 'Agent(fork)' })).decision).toBe('deny')
  expect((await check(ours, { decision: 'ask', rule: 'Agent' })).decision).toBe('ask')
  expect((await check(ours, { decision: 'ask', hook: 'PreToolUse' })).decision).toBe('ask')
  expect((await check(ours, { decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' })).decision).toBe('ask')
  // an ask another plugin's hook made, as Claude Code settles it for the hooks above (the kit's test below): its own ask,
  // and one only the person may answer, each naming the plugin
  expect((await check(ours, { decision: 'ask', reason: 'made-up-guard holds new agents', plugin: 'made-up-guard' })).decision).toBe('ask')
  expect((await check(ours, { decision: 'ask', plugin: 'made-up-guard' })).decision).toBe('ask')
  // Claude Code's mark of a person-only ask before it names the plugin that made it: an empty name
  expect((await check(ours, { decision: 'ask', plugin: '' })).decision).toBe('ask')
  // an allow stays one
  expect((await check(ours, { decision: 'allow' })).decision).toBe('allow')
  // Claude's own call of a subagent, worded as a check; another plugin's; thimble's other forks; another agent type
  expect((await check(ours, ASK, ENGINE)).decision).toBe('ask')
  expect((await check(ours, ASK, { plugin: 'made-up-helper', tier: 'user' })).decision).toBe('ask')
  for (const d of ['designing a card', 'a side thread', 'publishing a card']) expect((await check(spawn(d), ASK)).decision).toBe('ask')
  expect((await check(spawn('checking citations', 'general-purpose'), ASK)).decision).toBe('ask')
})

test("with no OK from the person, Claude Code's ask on thimble's checks stays Claude Code's to settle", async () => {
  const { check } = setup(false)
  for (const d of ['checking citations', 'checking a citation', REPAIR_DESCRIPTION, AGAIN_DESCRIPTION]) expect((await check(spawn(d), ASK)).decision).toBe('ask')
})

/** Claude Code 2.1.307's refusal of a fork a plugin's hook spawned, where auto mode's classifier must judge it and runs
 *  on Anthropic's server, which judges only the calls in Claude's own replies. */
const AUTO = "The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don't require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used."
const REPLY = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#); the [slow mirror](#) was down for [3 nights](#).'

/** An engine with versioned state, the checker's text, and forks that Claude Code refuses with `refused`'s words, or
 *  starts; the validator gives `results` for a check's marks, and names as `outside` each file of `outside` that the
 *  check could not read (no evidence may cite it; none unless a test says so); `env`, more of the process's variables;
 *  `kinds`, what each made-up path is (a file or a folder; any other is not there), as it stands when read. */
function engine(refused: () => string | null, results: (marks: Any[]) => Any[] = () => [], env: Record<string, string> = {}, kinds: Record<string, 'file' | 'dir'> = {}, outside: string[] = []) {
  const state = new Map<string, { value: unknown; version: number }>()
  const spawned: Any[] = []
  let now = 1000
  const validated = (req: Any) => ({ parsed: true, results: results(req.marks), ...(req.unread ? { outside: req.unread.filter((f: string) => outside.includes(f)) } : {}) })
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp', ...env } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { cwd: async () => '/made-up/data', id: async () => 's-allow', messages: async () => [] },
    fs: {
      read: async (p: string) => { if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}'; throw new Error(`no file ${p}`) },
      write: async () => undefined,
      list: async () => [],
      exists: async () => false,
      stat: async (p: string) => {
        if (!kinds[p]) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' })
        return { kind: kinds[p], size: 0, mtimeMs: 0, isLink: false }
      },
    },
    process: {
      run: async (argv: string[], o?: { stdin?: string }) => tempRun(argv)
        ?? (argv.includes('validate') && o?.stdin ? { exitCode: 0, stdout: JSON.stringify(validated(JSON.parse(o.stdin))), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
    },
    agent: {
      spawn: async (a: Any) => { spawned.push(a); const deny = refused(); return deny ? { deny } : { model: 'claude-made-up', agentId: `agent-${spawned.length}` } },
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

/** What runs on after a key's answer: the forks it asked for, and what their start changes. */
const settled = () => new Promise(r => setTimeout(r, 20))

test("g on the line of a check auto mode's classifier gave no verdict on: the person's OK, so thimble answers allow on its checks, and the check the line is about starts again, every share at once, its citations checked; the line goes", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    let refuse = true
    const { $, spawned } = engine(() => (refuse ? AUTO : null))
    await noteRow($, 'row-1', REPLY)
    await startCheck($, { turnId: 't-1', reason: 'answer' })
    expect((await failLineNow($))?.text).toBe(UNREVIEWED_LINE)
    expect((await rowMarks($, 'row-1'))!.items.map(m => m.status)).toEqual(['deferred', 'deferred', 'deferred', 'deferred', 'deferred'])
    const verdict = () => allowsCheck($, { input: { description: AGAIN_DESCRIPTION, subagent_type: 'fork' } }, THIMBLE, ASK)
    expect(await verdict()).toBe(false)
    // another key, y among them (a fix's line takes it), is no key of this line's
    expect(await checkKey($, 'n', 0)).toBeNull()
    expect(await checkKey($, 'y', 0)).toBeNull()
    refuse = false
    const g = await checkKey($, 'g', 0)
    expect(g).not.toBeNull()
    await g!.now()
    await settled()
    expect(await verdict()).toBe(true)
    // the five citations again, in their two shares, each with its marks filled in
    expect(spawned.slice(1).map(a => [a.subagentType, a.description])).toEqual([['fork', AGAIN_DESCRIPTION], ['fork', AGAIN_DESCRIPTION]])
    const asked = spawned.slice(1).map(a => String(a.prompt)).join('\n')
    for (const words of ['[40]', '[12 of 40]', '[p95 latency check]', '[slow mirror]', '[3 nights]']) expect(asked).toContain(words)
    expect((await rowMarks($, 'row-1'))!.items.map(m => m.status)).toEqual(['checking', 'checking', 'checking', 'checking', 'checking'])
    expect(await failLineNow($)).toBeNull()
    expect(await checkKey($, 'g', 0)).toBeNull()
  } finally {
    setOptions({})
  }
})

test('g then a letter: the person typed a word, so thimble has no OK, and the line still offers g for the same check', async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    const { $ } = engine(() => AUTO)
    await noteRow($, 'row-1', REPLY)
    await startCheck($, { turnId: 't-1', reason: 'answer' })
    const g = await checkKey($, 'g', 0)
    await g!.now()
    await g!.undo()
    await settled()
    expect(await allowsCheck($, { input: { description: AGAIN_DESCRIPTION } }, THIMBLE, ASK)).toBe(false)
    expect((await failLineNow($))?.text).toBe(UNREVIEWED_LINE)
    expect(await checkKey($, 'g', 0)).not.toBeNull()
  } finally {
    setOptions({})
  }
})

test('x on a failed citation refused the same way: the line offers g, and g starts that repair again', async () => {
  let refuse = true
  const { $, spawned } = engine(() => (refuse ? AUTO : null))
  await newReply($, { key: 'row-1', turnId: 't-1', rows: ['row-1'], startedAt: 1000, settledAt: 1100, items: [
    { n: 1, row: 'row-1', words: '40', start: 7, end: 14, sentence: REPLY, status: 'failed', failedBy: 'check', shown: '40', reason: 'The log counts 39 runs.' },
  ] } as never)
  const r = await repairOf($, 'row-1', 1)
  expect(await launchRepair($, r as Any, { until: 0, cancelled: false })).toBe('')
  expect((await failLineNow($))?.text).toBe(UNREVIEWED_LINE)
  refuse = false
  await (await checkKey($, 'g', 0))!.now()
  await settled()
  expect(spawned.map(a => a.description)).toEqual([REPAIR_DESCRIPTION, REPAIR_DESCRIPTION])
  expect(String(spawned[1].prompt)).toContain('The analyst pressed x to repair citation 1.')
  expect((await rowMarks($, 'row-1'))!.items[0]!.status).toBe('checking')
  expect(await failLineNow($)).toBeNull()
})

/** Claude Code 2.1.307's refusal in don't ask mode, of a call no rule allows. */
const DONT_ASK = "Permission to use Agent has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal. "

test("x on a failed citation in don't ask mode: the line names the mode and offers g, and says nothing of x; g starts that repair", async () => {
  let refuse = true
  const { $, spawned } = engine(() => (refuse ? DONT_ASK : null))
  await newReply($, { key: 'row-1', turnId: 't-1', rows: ['row-1'], startedAt: 1000, settledAt: 1100, items: [
    { n: 1, row: 'row-1', words: '40', start: 7, end: 14, sentence: REPLY, status: 'failed', failedBy: 'check', shown: '40', reason: 'The log counts 39 runs.' },
  ] } as never)
  const r = await repairOf($, 'row-1', 1)
  expect(await launchRepair($, r as Any, { until: 0, cancelled: false })).toBe('')
  const line = await failLineNow($)
  expect(line).toMatchObject({ kind: 'notice', text: "Claude Code's don't ask mode refused thimble's check of citations. Press g to allow thimble's checks this session." })
  expect(line!.text).not.toContain('Press x')
  refuse = false
  await (await checkKey($, 'g', 0))!.now()
  await settled()
  expect(spawned.map(a => a.description)).toEqual([REPAIR_DESCRIPTION, REPAIR_DESCRIPTION])
  expect((await rowMarks($, 'row-1'))!.items[0]!.status).toBe('checking')
  expect(await allowsCheck($, { input: { description: REPAIR_DESCRIPTION, subagent_type: 'fork' } }, THIMBLE, ASK)).toBe(true)
})

/** A failed citation of row-1, whose check found it wrong. */
const FAILED = { n: 1, row: 'row-1', words: '40', start: 7, end: 14, sentence: REPLY, status: 'failed', failedBy: 'check', shown: '40', reason: 'The log counts 39 runs.' }
const failedReply = (items: Any[] = [FAILED]) => ({ key: 'row-1', turnId: 't-1', rows: ['row-1'], startedAt: 1000, settledAt: 1100, items }) as never
const itemOf = async ($: Any, n = 1) => (await rowMarks($, 'row-1'))!.items.find(m => m.n === n)!

test("x on a failed citation while don't ask mode's refusal of thimble's checks stands: x gives the OK g gives, so thimble answers allow on its checks, and a word after x takes it back; with no refusal x gives none", async () => {
  let refuse = true
  const { $ } = engine(() => (refuse ? DONT_ASK : null))
  await newReply($, failedReply())
  const verdict = () => allowsCheck($, { input: { description: REPAIR_DESCRIPTION, subagent_type: 'fork' } }, THIMBLE, ASK)
  // no refusal yet: x needs no OK, and gives none
  await (await repairOk($, await itemOf($)))!.give()
  expect(await verdict()).toBe(false)
  // x's repair, refused: the refusal stands, and x's OK is g's
  expect(await launchRepair($, (await repairOf($, 'row-1', 1)) as Any, { until: 0, cancelled: false })).toBe('')
  const ok = (await repairOk($, await itemOf($)))!
  await ok.give()
  expect(await verdict()).toBe(true)
  await ok.undo()
  expect(await verdict()).toBe(false)
  // given, the repair Claude Code then starts checks the citation again, and the line goes
  await ok.give()
  refuse = false
  expect(await launchRepair($, (await repairOf($, 'row-1', 1)) as Any, { until: 0, cancelled: false })).toBe('')
  expect((await itemOf($)).status).toBe('checking')
  expect(await failLineNow($)).toBeNull()
})

test("where no OK answers Claude Code's refusal of thimble's checks, x has nothing to give, so it is not offered: a refusal after the OK, and auto mode's no verdict in a remote Cowork session", async () => {
  // don't ask mode refuses a repair after the OK too
  const after = engine(() => DONT_ASK)
  await newReply(after.$, failedReply())
  await launchRepair(after.$, (await repairOf(after.$, 'row-1', 1)) as Any, { until: 0, cancelled: false })
  await (await repairOk(after.$, await itemOf(after.$)))!.give()
  expect(await launchRepair(after.$, (await repairOf(after.$, 'row-1', 1)) as Any, { until: 0, cancelled: false })).toBe('')
  expect((await failLineNow(after.$))?.text).toBe("Claude Code's don't ask mode refused thimble's check of citations. Outside don't ask mode, thimble can check them.")
  expect(await repairOk(after.$, await itemOf(after.$))).toBeNull()
  // in a remote Cowork session, Claude Code takes no plugin's allow on a subagent in auto mode
  const cowork = engine(() => AUTO, () => [], { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' })
  await newReply(cowork.$, failedReply())
  await launchRepair(cowork.$, (await repairOf(cowork.$, 'row-1', 1)) as Any, { until: 0, cancelled: false })
  expect(await repairOk(cowork.$, await itemOf(cowork.$))).toBeNull()
  // a citation that did not fail has nothing to repair
  expect(await repairOk(cowork.$, { ...FAILED, status: 'verified' } as never)).toBeNull()
})

/** A file outside the session's folders, which the made-up validator takes as evidence unless a test names it
 *  `outside`, and Claude Code's refusals of a check's read of it: in don't ask mode, the person's no to its dialog, a
 *  rule of theirs. */
const ELSEWHERE = '/made-up/elsewhere/runs.csv'
const READ_DONT_ASK = "Permission to use Read has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal. "
const READ_REJECTED = 'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.'
const READ_RULE = 'Permission to use Read has been denied by your rule Read(//made-up/elsewhere/**).'
/** A read Claude Code refused, as its tool.call answers it: an error, its words as the model reads them. */
const refusedRead = (said: string) => ({ result: said, isError: true, text: said })
/** The validator's results: the first three marks not confirmed, for want of ELSEWHERE, which their reason names; the
 *  others verified. */
const FIRST_THREE = (marks: Any[]) => marks.map(m => (m.n <= 3 ? { n: m.n, status: 'failed', failedBy: 'evidence', shown: m.words, reason: `${ELSEWHERE} holds the runs, but the check could not read it.` } : { n: m.n, status: 'verified', shown: m.words, reason: 'counted' }))

/** The marks module's hooks on `$`: `call(event, e, below)` runs the event's chain over Claude Code's answer `below`
 *  (a verdict, a result), as Claude Code raises it for thimble's own fork. */
function hooksOn($: Any) {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    const reg: Any = { catch: () => reg }
    return reg
  }
  registerMarks(on, {} as never)
  return (event: string, e: Any, below: Any): Promise<Any> => {
    const chain = hooks[event] ?? []
    const run = async (i: number, x: Any): Promise<Any> => (i < chain.length ? chain[i]($, x, Object.assign((y: Any) => run(i + 1, y), { origin: ENGINE, called: false })) : below)
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

test("a check that could not read a file because the person said no to Claude Code's ask: x gives no OK, so Claude Code asks them again as the repair reads it; one a rule of theirs refused: x is not offered", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    const asked = engine(() => null, FIRST_THREE)
    const call = hooksOn(asked.$)
    await checkThatReads(asked.$, call, refusedRead(READ_REJECTED))
    const item = await itemOf(asked.$)
    expect(item.unread).toEqual([{ tool: 'Read', file: ELSEWHERE, fix: 'ask' }])
    await autoRepair(asked.$, 'agent-1')
    expect(asked.spawned.length).toBe(2)
    await (await repairOk(asked.$, item))!.give()
    expect((await call('tool.check', { tool: 'Read', input: { file_path: ELSEWHERE }, tool_use_id: 'toolu_r3', agentId: 'agent-1' }, ASK)).decision).toBe('ask')
    const ruled = engine(() => null, FIRST_THREE)
    await checkThatReads(ruled.$, hooksOn(ruled.$), refusedRead(READ_RULE))
    expect((await itemOf(ruled.$)).unread).toEqual([{ tool: 'Read', file: ELSEWHERE, fix: null }])
    expect(await repairOk(ruled.$, await itemOf(ruled.$))).toBeNull()
  } finally {
    setOptions({})
  }
})

/** The folder that holds ELSEWHERE, and Claude Code's refusal in don't ask mode of a check's call of `tool`. */
const FOLDER = '/made-up/elsewhere'
const dontAsk = (tool: string) => refusedRead(READ_DONT_ASK.replace('use Read', `use ${tool}`))

/** x's repair of row-1's failed citation 1, a check of that citation alone (agent-1), whose `reads` (each a call as
 *  tool.call has it) Claude Code refuses in don't ask mode; the validator fails the citation again. Answers it as the
 *  check left it. */
async function repairThatReads($: Any, call: Any, reads: Any[]): Promise<Any> {
  await newReply($, failedReply())
  expect(await launchRepair($, (await repairOf($, 'row-1', 1)) as Any, { until: 0, cancelled: false })).toBe('')
  for (const [k, read] of reads.entries()) await call('tool.call', { ...read, agentId: 'agent-1', tool_use_id: `toolu_r${k}` }, dontAsk(read.tool))
  await endCheck($, { agentId: 'agent-1', reason: 'answer', answer: '```json\n[]\n```' })
  return itemOf($)
}

test("x's OK covers one file, read by the tool Claude Code refused: a refused Grep of a folder, a Glob, or a read by a relative path names no one file, so x gives no OK for it; a Grep of a regular file is allowed as a Grep of that file alone, and not once the path is a folder; a Read as a Read of it alone; a Glob never, nor its absolute pattern", async () => {
  const kinds: Record<string, 'file' | 'dir'> = { [FOLDER]: 'dir', [ELSEWHERE]: 'file' }
  /** Claude Code's ask on agent-1's call of `tool`, as thimble's hooks answer it. */
  const check = async (call: Any, tool: string, input: Any) => (await call('tool.check', { tool, input, tool_use_id: 'toolu_c1', agentId: 'agent-1' }, ASK)).decision
  const wide = engine(() => null, FIRST_THREE, {}, kinds)
  const onWide = hooksOn(wide.$)
  const item = await repairThatReads(wide.$, onWide, [
    { tool: 'Grep', pattern: 'failed', path: FOLDER },
    { tool: 'Glob', pattern: '/made-up/**/*.csv', path: FOLDER },
    { tool: 'Read', file_path: 'elsewhere/runs.csv' },
  ])
  expect(item.status).toBe('failed')
  expect(item.unread).toBeUndefined()
  await (await repairOk(wide.$, item))!.give()
  expect(await check(onWide, 'Grep', { pattern: 'failed', path: FOLDER })).toBe('ask')
  expect(await check(onWide, 'Glob', { pattern: '/made-up/**/*.csv', path: FOLDER })).toBe('ask')
  expect(await check(onWide, 'Read', { file_path: 'elsewhere/runs.csv' })).toBe('ask')
  // a Grep of one regular file
  const one = engine(() => null, FIRST_THREE, {}, kinds)
  const onOne = hooksOn(one.$)
  const grepped = await repairThatReads(one.$, onOne, [{ tool: 'Grep', pattern: 'failed', path: ELSEWHERE }])
  expect(grepped.unread).toEqual([{ tool: 'Grep', file: ELSEWHERE, fix: 'ok' }])
  await (await repairOk(one.$, grepped))!.give()
  expect(await check(onOne, 'Grep', { pattern: 'p95', path: ELSEWHERE, output_mode: 'content' })).toBe('allow')
  // not a Read of it, nor a Glob of its folder or with its path as the pattern
  expect(await check(onOne, 'Read', { file_path: ELSEWHERE })).toBe('ask')
  expect(await check(onOne, 'Glob', { pattern: 'runs.csv', path: FOLDER })).toBe('ask')
  expect(await check(onOne, 'Glob', { pattern: ELSEWHERE, path: ELSEWHERE })).toBe('ask')
  // the path is a folder now: a Grep of it reads each file in it
  kinds[ELSEWHERE] = 'dir'
  expect(await check(onOne, 'Grep', { pattern: 'p95', path: ELSEWHERE })).toBe('ask')
  // a Read of the file: a Read of it, not a Grep
  kinds[ELSEWHERE] = 'file'
  const read = engine(() => null, FIRST_THREE, {}, kinds)
  const onRead = hooksOn(read.$)
  const readOne = await repairThatReads(read.$, onRead, [{ tool: 'Read', file_path: ELSEWHERE }])
  expect(readOne.unread).toEqual([{ tool: 'Read', file: ELSEWHERE, fix: 'ok' }])
  await (await repairOk(read.$, readOne))!.give()
  expect(await check(onRead, 'Read', { file_path: ELSEWHERE, offset: 10 })).toBe('allow')
  expect(await check(onRead, 'Grep', { pattern: 'p95', path: ELSEWHERE })).toBe('ask')
})

/** A reply of four citations, which one check (agent-1) checks. */
const FOUR = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#); the [slow mirror](#) was down.'

test("a check of several citations that could not read a file leaves it only on the citations whose answer names it: the others are repaired at once, or x checks them, as before; a check of one citation needed each file it could not read", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    // the check could not confirm 1, 2 and 3, and left 4 out of its answer; it names the file for 1 by its path and
    // for 2 by its name, and for 3 only a file whose name ends as the file's does
    const why = [`${ELSEWHERE} could not be read.`, 'runs.csv holds the failures, but the check could not open it.', 'old-runs.csv counts 39 runs, not 40.']
    const results = (marks: Any[]) => marks.filter(m => m.n !== 4).map(m => ({ n: m.n, status: 'failed', failedBy: 'evidence', shown: m.words, reason: why[m.n - 1] }))
    const { $, spawned } = engine(() => null, results)
    const call = hooksOn($)
    await noteRow($, 'row-1', FOUR)
    await startCheck($, { turnId: 't-1', reason: 'answer' })
    expect(spawned.length).toBe(1)
    // a rule of the person's refused the check's read of the file: nothing the person does here lets a check read it
    await call('tool.call', { tool: 'Read', file_path: ELSEWHERE, agentId: 'agent-1', tool_use_id: 'toolu_r1' }, refusedRead(READ_RULE))
    await endCheck($, { agentId: 'agent-1', reason: 'answer', answer: '```json\n[]\n```' })
    const ruled = [{ tool: 'Read', file: ELSEWHERE, fix: null }]
    const items = (await rowMarks($, 'row-1'))!.items
    expect(items.map(m => [m.failedBy, m.unread])).toEqual([['evidence', ruled], ['evidence', ruled], ['evidence', undefined], ['none', undefined]])
    // x is not offered on 1 and 2; on 4 it is, as on any citation whose check did not run
    expect(await repairOk($, items[0]!)).toBeNull()
    expect(await repairOk($, items[1]!)).toBeNull()
    expect(await repairOk($, items[3]!)).not.toBeNull()
    // 3 alone is repaired at once
    await autoRepair($, 'agent-1')
    expect(spawned.slice(1).map(a => a.description)).toEqual([REPAIR_DESCRIPTION])
    expect(String(spawned[1].prompt)).toContain('repair citation 3.')
    // that repair checks 3 alone: the file it could not read either is one its check needed, named or not
    await call('tool.call', { tool: 'Read', file_path: ELSEWHERE, agentId: 'agent-2', tool_use_id: 'toolu_r2' }, refusedRead(READ_RULE))
    await endCheck($, { agentId: 'agent-2', reason: 'answer', answer: '```json\n[]\n```' })
    expect((await itemOf($, 3)).unread).toEqual(ruled)
    expect(await repairOk($, await itemOf($, 3))).toBeNull()
  } finally {
    setOptions({})
  }
})

/** Claude's own code in the session's temp folder (core/home.ts tempDir), which the validator takes as evidence of what
 *  code does. */
const CODE = '/made-up/tmp/thimble/count.py'

test("a check that could not read a file no evidence may cite, as the validator says (outside the session's folder and the temp folders): no citation names it, each keeps the validator's reason, x gives no OK for it and starts the repair, and they are repaired at once, as before the rework; a file the validator takes, Claude's own code in the temp folder, is named as before", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    // the validator: ELSEWHERE lies outside every folder a cited file may lie in, so the first three marks fail on it
    const reason = `${ELSEWHERE} is outside the folder this session works in.`
    const results = (marks: Any[]) => marks.map(m => (m.n <= 3 ? { n: m.n, status: 'failed', failedBy: 'evidence', shown: m.words, reason } : { n: m.n, status: 'verified', shown: m.words, reason: 'counted' }))
    const { $, spawned } = engine(() => null, results, {}, {}, [ELSEWHERE])
    const call = hooksOn($)
    await checkThatReads($, call, refusedRead(READ_DONT_ASK))
    const items = (await rowMarks($, 'row-1'))!.items
    expect(items.map(m => [m.status, m.reason, m.unread])).toEqual([...Array(3).fill(['failed', reason, undefined]), ['verified', 'counted', undefined], ['verified', 'counted', undefined]])
    // x is offered, and gives no OK for the file: Claude Code's ask on a check's read of it stands
    const ok = await repairOk($, items[0]!)
    expect(ok).not.toBeNull()
    await ok!.give()
    expect((await call('tool.check', { tool: 'Read', input: { file_path: ELSEWHERE }, tool_use_id: 'toolu_r3', agentId: 'agent-1' }, ASK)).decision).toBe('ask')
    // each is repaired at once, as any citation a check could not confirm
    await autoRepair($, 'agent-1')
    expect(spawned.slice(2).map(a => [a.description, /repair citation (\d)\./.exec(String(a.prompt))?.[1]])).toEqual([[REPAIR_DESCRIPTION, '1'], [REPAIR_DESCRIPTION, '2'], [REPAIR_DESCRIPTION, '3']])
    // a repair's check that could not read that file and Claude's own code: the citation names the code alone, and x's
    // OK covers a check's read of it alone
    const both = engine(() => null, results, {}, {}, [ELSEWHERE])
    const onBoth = hooksOn(both.$)
    const item = await repairThatReads(both.$, onBoth, [{ tool: 'Read', file_path: ELSEWHERE }, { tool: 'Read', file_path: CODE }])
    expect(item.unread).toEqual([{ tool: 'Read', file: CODE, fix: 'ok' }])
    await (await repairOk(both.$, item))!.give()
    const read = async (file: string) => (await onBoth('tool.check', { tool: 'Read', input: { file_path: file }, tool_use_id: 'toolu_c1', agentId: 'agent-1' }, ASK)).decision
    expect(await read(CODE)).toBe('allow')
    expect(await read(ELSEWHERE)).toBe('ask')
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

/** A made-up plugin beneath thimble whose hook asks about every new agent: as one only the person may answer
 *  (`person`), as its own ask (`own`), or passes Claude Code's verdict on unchanged (any other description). */
const GUARD: Any = { name: 'made-up-guard', tier: 'builtin', register(on: Any) {
  on('tool.check', { tool: 'Agent' }, async ($: Any, e: Any, next: Any) => {
    const how = String(e.input?.description ?? '')
    if (how === 'person') return { decision: 'ask', decider: 'person', reason: 'made-up-guard holds new agents' }
    if (how === 'own') return { decision: 'ask', reason: 'made-up-guard holds new agents' }
    return next(e)
  })
} }
/** A made-up plugin between it and thimble that says, in its reason, the verdict its hook read: what a hook above the
 *  guard reads, as thimble's does. */
const READER: Any = { name: 'made-up-reader', tier: 'append', register(on: Any) {
  on('tool.check', { tool: 'Agent' }, async ($: Any, e: Any, next: Any) => {
    const v = await next(e)
    return { ...v, reason: JSON.stringify(v) }
  })
} }

test("the verdict a tool.check hook reads, as Claude Code settles a plugin's answer beneath it: another plugin's ask, its own or the person's only, names that plugin, and thimble's allow takes none of them; Claude Code's own ask names none, and is thimble's to answer", { plugins: [GUARD, READER], options: { citations: 'auto cite + verify' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask', reason: "Claude requested permissions to use Agent, but you haven't granted it yet." }) as never)
  const read = async (description: string): Promise<Any> => JSON.parse(String((await $.tool.check({ tool: 'Agent', input: { description, prompt: 'Check these.', subagent_type: 'fork' } } as never)).reason))
  const person = await read('person')
  const own = await read('own')
  const engines = await read('checking citations')
  expect(person).toEqual({ decision: 'ask', reason: 'made-up-guard holds new agents', plugin: 'made-up-guard' })
  expect(own).toEqual({ decision: 'ask', reason: 'made-up-guard holds new agents', plugin: 'made-up-guard' })
  expect(engines).toEqual({ decision: 'ask', reason: "Claude requested permissions to use Agent, but you haven't granted it yet." })
  // with the person's OK given, on a checker's spawn of thimble's own: each verdict as read
  const ok: Any = { state: { get: async (k: Any) => ({ value: k.key === 'checksAllowed' ? true : undefined }) } }
  const ours = { input: { description: 'checking citations', subagent_type: 'fork' } }
  expect(await allowsCheck(ok, ours, THIMBLE, person)).toBe(false)
  expect(await allowsCheck(ok, ours, THIMBLE, own)).toBe(false)
  expect(await allowsCheck(ok, ours, THIMBLE, engines)).toBe(true)
})
