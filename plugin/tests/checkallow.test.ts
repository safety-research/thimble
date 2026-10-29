// thimble's answer at tool.check on a spawn (marks/register.ts, marks/checker.ts allowsCheck). Once the person let
// thimble start its checks of citations (g on the line of a check Claude Code refused where nobody was asked: auto
// mode's classifier gave no verdict, or don't ask mode), thimble answers Claude Code's own ask on a checker's spawn of
// its own with allow. A deny (a deny rule), an ask a rule, a classic hook, a setting or another plugin made, Claude's
// own call of a subagent however it is worded, another plugin's call, and thimble's other forks stay as Claude Code
// decides. An ask another plugin made reaches thimble's hook as Claude Code 2.1.307 settles it, naming that plugin: its
// own ask, and one only the person may answer (`decider: 'person'`) alike. All data is made up. `claude plugin test
// plugin`.
import { expect } from 'claude-code/testing'

import { failLineNow } from '../bar/notice'
import { AGAIN_DESCRIPTION, allowsCheck, checkKey, launchRepair, noteRow, REPAIR_DESCRIPTION, repairOf, startCheck, UNREVIEWED_LINE } from '../marks/checker'
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
 *  starts. */
function engine(refused: () => string | null) {
  const state = new Map<string, { value: unknown; version: number }>()
  const spawned: Any[] = []
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { cwd: async () => '/made-up/data', id: async () => 's-allow', messages: async () => [] },
    fs: {
      read: async (p: string) => { if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}'; throw new Error(`no file ${p}`) },
      write: async () => undefined,
      list: async () => [],
      exists: async () => false,
    },
    process: { run: async (argv: string[]) => tempRun(argv) ?? { exitCode: 0, stdout: '', stderr: '' } },
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

test("x on a failed citation in don't ask mode: the line names the mode and offers g, not x again, which would be refused the same way; g starts that repair", async () => {
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
