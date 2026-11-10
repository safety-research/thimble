// thimble fix in the hooks module (fix/), on a plain engine whose kernel is faked (the kernel's own tests are
// test_fixes.py): the person's /thimble-fix <words>, which Claude's fix-thimble skill names the fix of, starts the
// fixer as a fork of the session in its copy, with their words as they typed them and a text copy of what thimble
// shows; no fix starts from Claude's words; Claude can neither apply nor send a fix, the fixer included, whose shell
// runs in the sandbox the kernel describes and whose writes stay in its copy; the fixer's end puts the fix's line above
// the bar and sends a notification; d shows what changed; y applies it with a secret only that press holds and reloads
// the plugins, and the line then offers u to undo it. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { refusedText } from '../fix/fixer'
import { fixKey, fixLineRows } from '../fix/line'
import { NOT_ASKED, registerFix, wordsOfSkill } from '../fix/register'
import { promptStub } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const HOME = '/made-up/.thimble'
const WORK = `${HOME}/fixes/work/1`
// what `thimble fix sandbox 1` prints: the sandbox command's start, whose rules let it write the copy and its temp folder
const BOX = ['/usr/bin/env', '-i', '/made-up/node', '/made-up/plugin/sandbox/run.mjs', '--srt', '/made-up/srt',
  JSON.stringify({ filesystem: { allowWrite: [{ path: WORK }, { path: `${HOME}/fixes/tmp/1` }] } }), '--', '/bin/bash', '-c']
const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const boxed = (command: string) => [...BOX, command].map(quoted).join(' ')
const ELS = { Box: (p: Any) => ({ type: 'Box', props: p }), Text: (p: Any) => ({ type: 'Text', props: p }), Button: (p: Any) => ({ type: 'Button', props: p }) }

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

/** Whether a hook's matcher admits the event: strings equal, patterns test, objects match key by key. */
function admits(m: Any, e: Any): boolean {
  if (!m) return true
  return Object.entries(m).every(([k, v]) => (v instanceof RegExp ? v.test(String(e?.[k] ?? '')) : v && typeof v === 'object' ? admits(v, e?.[k]) : e?.[k] === v))
}

let now = 0

/** The fix module's hooks on an engine that keeps state, files and timers in memory, with a faked kernel. `refuse`: the
 *  kernel's check does not use the fixer's first change, with this refusal. */
function setup(refuse: Any = null) {
  const hooks: Record<string, { m: Any; fn: Any }[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? { m: null, fn: a } : { m: a, fn: b })
    const reg: Any = { catch: () => reg }
    return reg
  }
  registerFix(on, {} as never)
  const state = new Map<string, unknown>()
  const files = new Map<string, string>()
  const timers: (() => unknown)[] = []
  const ran: { argv: string[]; stdin?: string; env?: Record<string, string> }[] = []
  const spawns: Any[] = []
  const commands: string[] = []
  const notes: { text: string; title?: string }[] = []
  const agents: { id: string; status: string }[] = []
  // each prompt the plugin gave Claude
  const prompts: Any[] = []
  const fix: Any = { id: 1, title: 'make the bar say read', words: ["make the bar's coverage item say read"], rounds: 1, made_in: 'terminal', created: 1761200000, state: 'working', work: WORK, commit: null, files: [], tests: null, summary: '', error: null }
  // the kernel's records: none until the first request
  let made = false
  const all = () => (made && fix.state !== 'removed' ? [fix] : [])
  const list = () => ({ fixes: all(), on: true, live: `${HOME}/fixes/live`, version: '0.10.2', count_on: all().filter(f => f.state === 'on').length, pointed: true, due: null })
  const kernel = (argv: string[], stdin?: string) => {
    const ok = (out: unknown) => ({ exitCode: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' })
    const verb = argv[argv.indexOf('fix') + 1]
    if (verb === 'list') return ok(list())
    if (verb === 'sandbox') return ok(BOX)
    if (verb === 'new') {
      made = true
      if (stdin) fix.words = [stdin]
      return ok(fix)
    }
    if (verb === 'done') {
      // the check that refuses the first change keeps the refusal on the record
      if (refuse && !fix.commit) return ok(Object.assign(fix, { state: 'failed', commit: 'c0ffee0', tests: 'failed', error: refuse.why, refused: refuse }))
      // the fix takes the fixer's title
      const t = argv.indexOf('--title')
      Object.assign(fix, { state: 'ready', summary: stdin, commit: 'c0ffee1', tests: 'passed', error: null, refused: null, files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }], title: t > 0 ? argv[t + 1] : fix.title })
      return ok(fix)
    }
    // another round in the same copy, which keeps the refusal for its fixer
    if (verb === 'again') return ok(Object.assign(fix, { state: 'working', error: null }))
    if (verb === 'apply') {
      // the kernel checks the press's secret against the sha256 the plugin wrote
      if (!JSON.parse(files.get(`${HOME}/fixes/asks/1.json`) ?? '{}').key || !stdin) return { exitCode: 1, stdout: '', stderr: "thimble fix apply: only the person's key press in thimble does that" }
      Object.assign(fix, { state: 'on', work: null })
      return ok({ id: 1, reload: true, version: '0.10.2+fix.c0ffee1' })
    }
    if (verb === 'undo') {
      Object.assign(fix, { state: 'off' })
      return ok({ id: 1, title: fix.title, reload: true, version: '0.10.2' })
    }
    if (verb === 'update' && argv.includes('--check')) return ok({ from: '0.10.2', to: '0.10.2', newer: false })
    return ok({})
  }
  const $: Any = {
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    env: { get: async (k: string) => ({ THIMBLE_HOME: HOME, HOME: '/made-up/home', THIMBLE_ROOT: '/made-up/data' } as Record<string, string>)[k] },
    fs: {
      read: async (p: string) => { if (files.has(p)) return files.get(p); const s = promptStub(p); if (s != null) return s; throw new Error('missing') },
      write: async (p: string, t: string) => { files.set(p, t) },
      exists: async (p: string) => files.has(p),
      stat: async (p: string) => ({ kind: 'dir', size: 0, realPath: p }),
    },
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } },
    },
    clock: { now: async () => (now += 1000), sleep: async () => undefined, after: (_ms: number, fn: () => unknown) => { timers.push(fn); return { cancel() {} } }, every: () => ({ cancel() {} }) },
    agent: {
      spawn: async (a: Any) => { spawns.push(a); const agentId = `agent-fixer-${spawns.length}`; agents.push({ id: agentId, status: 'running' }); return { model: 'claude-made-up', agentId } },
      list: async () => agents,
    },
    session: { id: async () => 's-fix', cwd: async () => '/made-up/data', root: async () => '/made-up/data', send: async () => ({ isDelivered: true }) },
    config: { list: async () => [] },
    // the person's rules, as Claude Code reads them: they deny rm -rf
    tool: { check: async (q: Any) => ({ decision: /^rm -rf/.test(String(q.input?.command)) ? 'deny' : 'ask', reason: 'Bash(rm -rf:*) is denied' }) },
    process: { run: async (argv: string[], o: Any = {}) => { ran.push({ argv, env: o.env, ...(o.stdin != null ? { stdin: o.stdin } : {}) }); return argv.includes('fix') ? kernel(argv, o.stdin) : { exitCode: 0, stdout: '', stderr: '' } } },
    command: { run: async (c: Any) => { commands.push(c.command); return {} }, register: async (c: Any) => ({ command: c.name }) },
    prompt: {
      read: async () => ({ text: '', cursor: 0 }),
      fill: async (a: Any) => ({ isFilled: true, text: a.text, cursor: a.text.length }),
      // as Claude Code takes a plugin's prompt: never a text that begins with /, which would run a command as the person
      submit: async (a: Any) => {
        if (String(a.text).trimStart().startsWith('/')) throw new Error('thimble: $.prompt.submit submits a prompt to the model; a text beginning with / would run a command as the user; run one with $.command.run({ command })')
        prompts.push(a)
        return { text: a.text }
      },
    },
    ui: { toast: () => undefined, notify: async (text: string, o: Any = {}) => { notes.push({ text, title: o.title }); return { isSent: true } }, log: () => undefined, open: async () => ({ isPlaced: true }), panes: async () => [], close: async () => ({}), invalidate: () => undefined },
  }
  /** An event through the module's hooks that admit it, in order, then `base`. */
  const call = (event: string, e: Any, base: (e: Any) => Any = async x => x) => {
    const chain = (hooks[event] ?? []).filter(h => admits(h.m, e))
    const run = (i: number, ev: Any): Any => (i < chain.length ? chain[i]!.fn($, ev, Object.assign((x: Any) => run(i + 1, x), { called: false, origin: { plugin: 'thimble' }, signal: { aborted: false } })) : base(ev))
    return run(0, e)
  }
  /** The timers that came due, run (each may add more). */
  const tick = async () => {
    for (let n = 0; n < 5 && timers.length; n++) for (const fn of timers.splice(0)) await fn()
    await new Promise(r => setTimeout(r, 5))
  }
  // the session the plugin names on new and done, how long done waits for the tests, and the person's own words, are
  // left out: tests look at them apart
  const verbs = () => ran.map(r => r.argv.slice(r.argv.indexOf('fix') + 1).filter(x => !x.startsWith('--asked=')).join(' ').replace(/ --session \S+/, '').replace(/ --within \S+/, '')).filter(Boolean)
  /** The fixer's end: its agent idles, and its turn's end reaches the hooks. */
  const end = async (answer: string, agentId = 'agent-fixer-1') => {
    for (const a of agents) if (a.id === agentId) a.status = 'idle'
    await call('turn.complete', { turnId: 't-f', agentId, reason: 'answer', answer, durationMs: 9, isAborted: false }, async () => ({}))
    await tick()
  }
  return { $, call, tick, end, ran, spawns, commands, files, notes, verbs, prompts }
}

/** The person's /thimble-fix <words>: the command's answer gives Claude the request with the words (prompts/
 *  fix-request.md), and a moment later the words go to Claude as the person's prompt, with no other command run;
 *  Claude, reading them, starts the fix with the fix-thimble skill. What Claude reads in the skill's place. */
async function ask(s: ReturnType<typeof setup>, words: string): Promise<Any> {
  const ran = s.commands.length
  const own = await s.call('command.run', { command: 'thimble-fix', args: words }, async () => { throw new Error('/thimble-fix with words runs no command of its own') })
  expect(own.context[0]).toBe(`REQUEST ${words}`)
  await s.tick()
  expect(s.prompts.splice(0)).toEqual([{ text: words, asUser: true }])
  expect(s.commands.slice(ran)).toEqual([])
  return skillText(await skillCall(s, words))
}

/** Claude's call of the fix-thimble skill, through the Skill tool: the skill itself must not run. */
function skillCall(s: ReturnType<typeof setup>, words: string, skill = 'thimble:fix-thimble'): Promise<Any> {
  return s.call('tool.call', { tool: 'Skill', tool_use_id: `tu-skill-${words.length}`, skill, args: words }, async () => { throw new Error('the fix-thimble skill itself never runs') })
}

/** What Claude reads of a Skill call's answer, in the shape skill.prompt's `{ text }` has. */
const skillText = (r: Any) => ({ text: (r.context ?? []).join('\n'), result: r.result })

/** A request, and the fixer's end with what it says. */
async function requested(s: ReturnType<typeof setup>, answer = 'Done.\n\nTitle: Bar says read for coverage\nWhat it does: The bar says r read 14%.') {
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await ask(s, "make the bar's coverage item say read")
  await s.end(answer)
  return r
}

const ran = async (e: Any) => ({ result: { ran: e.command ?? e.file_path ?? '' } })

test("a request forks the session into its copy with a text copy of the screen; no call, the fixer's included, applies or writes the fixes", async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  // what the screen shows: a failure line above the bar
  await s.$.state.set({ plugin: 'thimble', key: 'failLine' }, { kind: 'failed', text: 'The card “Runs by day” could not be drawn' })
  const r = await ask(s, "make the bar's coverage item say read")
  expect(String(r.text)).toContain('in a copy ("make the bar say read")')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("make the bar's coverage item say read")
  // a fork (no agent type of its own), in the copy, named after the fix, whose first message opens with the task
  expect(s.spawns[0]).toMatchObject({ subagentType: 'fork', cwd: WORK, name: 'fix-bar-say-read' })
  const first = String(s.spawns[0].prompt)
  expect(first.startsWith('PROMPT fixer')).toBe(true)
  expect(first).toContain("The person asked for this change to their thimble:\n\nmake the bar's coverage item say read")
  expect(first).toContain("What thimble shows on the person's screen now, as text")
  expect(first).toContain('× The card “Runs by day” could not be drawn')
  expect(first).toContain('No side pane is open.')
  expect(first).toContain('No card is drawn.')
  // the fixer's shell runs in the sandbox, in the foreground, for at most 5 minutes; that call needs no dialog
  const seen: Any[] = []
  const keep = async (e: Any) => { seen.push(e); return { result: { ran: e.command } } }
  const check = (tool_use_id: string, command: string) => s.call('tool.check', { tool: 'Bash', tool_use_id, agentId: 'agent-fixer-1', input: { command } }, async () => ({ decision: 'ask' }))
  const test1 = s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-1', agentId: 'agent-fixer-1', command: "grep -rn 'coverage' plugin/bar", run_in_background: true }, async (e: Any) => {
    // the check comes while the call runs, on the command as it runs
    seen.push({ ...e, verdict: (await check('tu-1', e.command)).decision })
    return { result: { ran: e.command } }
  })
  expect((await test1).result.ran).toBe(boxed("grep -rn 'coverage' plugin/bar"))
  expect(seen[0]).toMatchObject({ timeout: 300000, run_in_background: false, verdict: 'allow' })
  await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-1b', agentId: 'agent-fixer-1', command: 'ls', timeout: 900000 }, keep)
  await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-1c', agentId: 'agent-fixer-1', command: 'ls', timeout: 2000 }, keep)
  expect(seen.slice(1).map(e => e.timeout)).toEqual([300000, 2000])
  // a command the person's rules deny is still denied; a command thimble did not put in the sandbox asks as usual
  await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-1d', agentId: 'agent-fixer-1', command: 'rm -rf ~' }, async (e: Any) => {
    seen.push({ verdict: (await check('tu-1d', e.command)).decision })
    return { result: {} }
  })
  expect(seen.at(-1).verdict).toBe('deny')
  expect((await check('tu-9', 'find / -name x')).decision).toBe('ask')
  // the shell reaches the package registries to add a package, never to publish one or sign in: refused before it runs
  for (const command of ['npm publish', 'cd pkg && npm --registry=https://registry.npmjs.org/ publish --access public', 'npm login', 'yarn npm publish'])
    expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-1e', agentId: 'agent-fixer-1', command }, ran)).deny)).toContain('never to publish one')
  expect((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-1f', agentId: 'agent-fixer-1', command: 'npm install left-pad' }, ran)).result.ran).toBe(boxed('npm install left-pad'))
  // its writes stay in its copy
  expect((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-2', agentId: 'agent-fixer-1', file_path: `${WORK}/plugin/bar/bar.tsx` }, ran)).result.ran).toBe(`${WORK}/plugin/bar/bar.tsx`)
  for (const file_path of ['/made-up/home/notes.txt', `${WORK}/../2/plugin/bar/bar.tsx`, `${HOME}/fixes/work/12/x.ts`]) {
    expect(String((await s.call('tool.call', { tool: 'Edit', tool_use_id: 'tu-3', agentId: 'agent-fixer-1', file_path }, ran)).deny)).toContain('changes only its copy')
  }
  // main's calls are its own: not in the sandbox, no answer from thimble
  expect((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-4', command: 'ls ~' }, ran)).result.ran).toBe('ls ~')
  expect((await s.call('tool.check', { tool: 'Bash', tool_use_id: 'tu-4', input: { command: 'ls ~' } }, async () => ({ decision: 'ask' }))).decision).toBe('ask')
  // the verbs and the folder only thimble and the person's keys use: refused to main and to the fixer alike
  for (const agentId of [undefined, 'agent-fixer-1']) {
    expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5', agentId, command: 'thimble fix apply 1 --ask -' }, ran)).deny)).toContain('Only thimble and the person')
    expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5b', agentId, command: 'cd x && thimble  fix merge 1 2 --ask -' }, ran)).deny)).toContain('Only thimble and the person')
    // sending a fix publicly is the person's own command, never Claude's
    for (const command of ['thimble file pr 1 --yes', 'thimble file issue 1 --open', 'cd x && thimble  file  pr 2'])
      expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5d', agentId, command }, ran)).deny)).toContain('Only thimble and the person')
    // another round after a refusal is thimble's to start, never Claude's
    expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5c', agentId, command: 'thimble fix again 1' }, ran)).deny)).toContain('Only thimble and the person')
    expect(String((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-6', agentId, file_path: `${HOME}/fixes/asks/1.json` }, ran)).deny)).toContain('thimble alone')
  }
  expect((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-7', command: 'thimble fix list' }, ran)).result.ran).toBe('thimble fix list')
})

test("the fixer's end: the line and a notification say it is fixed; d shows what changed; y applies it with the press's secret and reloads; u then undoes it", async () => {
  const s = setup()
  await requested(s)
  expect(s.verbs()).toContain('done 1 --summary - --title Bar says read for coverage')
  expect(s.ran.find(x => x.argv.includes('done'))?.stdin).toBe('The bar says r read 14%.')
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  ✓ thimble fixed: Bar says read for coverage · tests pass')
  expect(textOf(rows[1])).toBe('    y use it now · d what changed · n later')
  expect(s.notes).toEqual([{ text: 'thimble fixed: Bar says read for coverage · tests pass', title: 'thimble' }])
  // each key's words are a click that does what the key does: d opens what changed (the d key closes it again)
  const keyButton = (rs: Any[], k: string): Any => {
    const walk = (n: Any): Any => (!n || typeof n !== 'object' ? null : Array.isArray(n) ? n.map(walk).find(Boolean) ?? null : n.type === 'Button' && n.props?.key === `fix-key-${k}` ? n : walk(n.props?.children))
    return walk(rs)
  }
  await keyButton(rows, 'd').props.onPress()
  expect((await fixLineRows(s.$, ELS, 110)).map(textOf)).toContain('    Changed     1 file · tests pass')
  await (await fixKey(s.$, 'd'))!.later()
  rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows[1])).toBe('    y use it now · d what changed · n later')
  // d: a few lines in the line's place, not a diff
  await (await fixKey(s.$, 'd'))!.later()
  rows = await fixLineRows(s.$, ELS, 110)
  expect(rows.map(textOf)).toEqual([
    '  Bar says read for coverage',
    "    You asked   make the bar's coverage item say read",
    '    Claude did  The bar says r read 14%.',
    '    Changed     1 file · tests pass',
    '    y use it now · n later',
  ])
  expect(s.verbs().some(v => v.startsWith('diff'))).toBe(false)
  // y: a secret on stdin, its sha256 in asks/1.json (never the secret), then the plugins load again
  const y = await fixKey(s.$, 'y')
  expect(y).not.toBe(null)
  await y!.later()
  const apply = s.ran.find(x => x.argv.includes('apply'))
  expect(apply?.argv.slice(-2)).toEqual(['--ask', '-'])
  expect(String(apply?.stdin)).toMatch(/^[0-9a-f]{64}$/)
  const asked = String(s.files.get(`${HOME}/fixes/asks/1.json`))
  expect(asked).toMatch(/"key":"[0-9a-f]{64}"/)
  expect(asked).not.toContain(String(apply?.stdin))
  expect(s.commands).toEqual(['reload-plugins'])
  // the reload loads the plugin again (its session start), and the line says the fix is on, with u to undo it
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  ✓ Bar says read for coverage is on · thimble reloaded · u undo')
  expect(keyButton(rows, 'u')).not.toBe(null)
  expect(await fixKey(s.$, 'y')).toBe(null)
  // u: the fix goes off, and the plugins load again
  await (await fixKey(s.$, 'u'))!.later()
  expect(s.verbs()).toContain('undo 1')
  expect(s.commands).toEqual(['reload-plugins', 'reload-plugins'])
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ○ Bar says read for coverage is off · thimble reloaded · thimble fix on, in a shell, turns it on again')
  expect(await fixKey(s.$, 'u')).toBe(null)
})

test("y while Claude's turn runs: the line says the fix loads when Claude finishes; after that load, u undoes it until the person's next prompt", async () => {
  const s = setup()
  await requested(s)
  // Claude's turn runs (core/turn.ts keeps it in $.state)
  const TURN = { plugin: 'thimble', key: 'mainTurn' }
  await s.$.state.set(TURN, 't-main')
  await (await fixKey(s.$, 'y'))!.later()
  expect(s.commands).toEqual([])
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ Bar says read for coverage is on · reloads when Claude finishes · u undo')
  // the turn's end runs the reload, and the plugin's new load keeps the line
  await s.$.state.set(TURN, null)
  await s.call('turn.complete', { turnId: 't-main', reason: 'answer', answer: 'Done.', durationMs: 9, isAborted: false }, async () => ({}))
  await s.tick()
  expect(s.commands).toEqual(['reload-plugins'])
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ Bar says read for coverage is on · thimble reloaded · u undo')
  expect(await fixKey(s.$, 'u')).not.toBe(null)
  // the person's next prompt: the line goes, and u is typed as usual
  await s.call('prompt.submit', { text: 'thanks', origin: { kind: 'composer' } }, async (e: Any) => e)
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(await fixKey(s.$, 'u')).toBe(null)
})

test("a change whose tests failed: a new fixer gets another round in the same copy, told the end of the tests' output and the file that holds all of it; the person sees the fix only once it passes", async () => {
  const LOG = `${HOME}/fixes/tmp/1/tests.log`
  const s = setup({ why: 'its tests failed in the sandbox', files: [], tests: '(fail) the bar says read\n 1 fail', log: LOG })
  await requested(s)
  expect(s.verbs()).toContain('again 1')
  expect(s.spawns.length).toBe(2)
  expect(s.spawns[1]).toMatchObject({ subagentType: 'fork', cwd: WORK })
  expect(String(s.spawns[1].prompt)).toContain(`thimble did not use the last change for this fix: its tests failed in the sandbox. Your last change is in your copy. The end of their output:\n\n(fail) the bar says read\n 1 fail\n\nTheir whole output is in ${LOG}. Fix what fails.`)
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(s.notes).toEqual([])
  await s.end('Title: Bar says read for coverage\nWhat it does: The bar says r read 14%.', 'agent-fixer-2')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Bar says read for coverage · tests pass')
  // a refusal from a kernel that names no file: the end of the output alone
  expect(refusedText({ why: 'its tests failed in the sandbox', files: [], tests: ' 1 fail' }, false)).toContain('The end of their output:\n\n 1 fail\n\nFix what fails.')
})

test("a fixer that closes its end in a code fence: the fence is no part of what the fix does", async () => {
  const s = setup()
  await requested(s, 'Done.\n\n```\nTitle: Bar says read for coverage\nWhat it does: The bar says r read 14%.\n```')
  expect(s.ran.find(x => x.argv.includes('done'))?.stdin).toBe('The bar says r read 14%.')
})

/** What Claude is told of fix 1 at the person's next prompt, or ''. */
async function toldOf(s: ReturnType<typeof setup>): Promise<string> {
  return ((((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>)['fix-1']) ?? ''
}

test("Claude's fix-thimble skill starts no fix without the person's /thimble-fix: a fix it offered, on the person's yes, is no request of theirs; Claude reads that /thimble-fix asks for one", async () => {
  expect(wordsOfSkill("The fix the person's words change: 2\n\nthimble starts its fix…")).toBe('2')
  expect(wordsOfSkill("The fix the person's words change: \n\nthimble starts its fix…")).toBe('')
  expect(wordsOfSkill("The fix the person's words change: $ARGUMENTS\n\nthimble starts…\n\nARGUMENTS: new")).toBe('new')
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  // Claude saw thimble misbehave, offered a fix, and the person said yes: Claude's words start nothing
  const r = skillText(await skillCall(s, "new the card's legend hides its last row; it should show every row", 'fix-thimble'))
  expect(r.result).toEqual({ success: true, commandName: 'fix-thimble' })
  expect(r.text).toBe(NOT_ASKED)
  expect(s.verbs().filter(v => /^(new|round|redo)\b/.test(v))).toEqual([])
  expect(s.spawns).toEqual([])
  // the person's own /thimble-fix <words>: the skill starts the fix in their words, and Claude reads what came of it
  await s.call('command.run', { command: 'thimble-fix', args: 'the legend should show every row' }, async () => ({}))
  await s.tick()
  const ok = skillText(await skillCall(s, 'new'))
  expect(String(ok.text)).toContain('thimble started a fork of this conversation that fixes thimble in the background')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe('the legend should show every row')
  expect(String(s.spawns[0].prompt)).toContain('The person asked for this change to their thimble:\n\nthe legend should show every row\n')
  // its end: the line and the notification, and Claude hears that the fix waits for the person's y
  await s.end('Title: Legend shows every row\nWhat it does: The legend wraps.')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Legend shows every row · tests pass')
  expect(await toldOf(s)).toBe(`thimble's fixer finished the fix "Legend shows every row"; it waits for the person's y. Nothing for you to do.`)
})
