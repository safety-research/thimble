// thimble fix in the hooks module (fix/), on a plain engine whose kernel is faked (the kernel's own tests are
// test_fixes.py): the person's /thimble-fix <words>, which Claude's fix-thimble skill names the fix of, starts the fixer
// as a fork of the session in its copy, with their words as they typed them and a text copy of what thimble shows; no
// fix starts from Claude's words; more words while it works go to the same fixer; Claude can neither apply nor send a
// fix, the fixer included; the fixer's end puts the fix's line above the bar and sends a notification; d shows what
// changed; y applies it with a secret only that press holds and reloads the plugins (at the turn's end when Claude is
// mid-reply; a --plugin-dir session is told to restart); u undoes it; n leaves it ready in the list; /thimble-fix alone
// says how to ask; a failed fix's d shows what it tried and puts its failure in the prompt box for the person to send to
// Claude, and the keys under it show only while the box is empty, where they act; a failed fix's line goes at the next
// prompt. The fixer's shell runs in the sandbox the kernel describes, with
// a time limit, its writes stay in its copy, and it publishes nothing to the package registries it reaches. All data is
// made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { busyNow, busySteps } from '../bar/busy'
import { FIX_ALONE, fixSlug, fixingWord, noticeText, refreshFixes } from '../fix/fixes'
import { askClaudeText, fixKey, fixLineRows } from '../fix/line'
import { NOT_ASKED, notStarted, registerFix, wordsOfSkill } from '../fix/register'
import { fixesContext, formOf, namedFix } from '../fix/request'
import { textOf as screenText, TEXT_ELS } from '../fix/screen'
import { registerKeys } from '../hooks/keys'
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

/** The fix module's hooks on an engine that keeps state, files and timers in memory, with a faked kernel. `keys`: the
 *  keys' hook too (hooks/keys.ts), registered first as the plugin registers it, so that a key typed at the prompt goes
 *  where the person's key goes. */
function setup(o: { keys?: boolean } = {}) {
  const hooks: Record<string, { m: Any; fn: Any }[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? { m: null, fn: a } : { m: a, fn: b })
    const reg: Any = { catch: () => reg }
    return reg
  }
  if (o.keys) registerKeys(on, {} as never)
  registerFix(on, {} as never)
  const state = new Map<string, unknown>()
  const files = new Map<string, string>()
  const timers: (() => unknown)[] = []
  const ran: { argv: string[]; stdin?: string; env?: Record<string, string> }[] = []
  const spawns: Any[] = []
  const commands: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  const notes: { text: string; title?: string }[] = []
  const sent: { to: Any; text: string }[] = []
  const agents: { id: string; status: string }[] = []
  const config: { key: string; value: unknown }[] = []
  const copied: string[] = []
  const asked: Any[] = []
  // the person's prompt box, each fill a plugin made of it, and each time a hook asked for the bar to draw again
  const box = { text: '' }
  const fills: Any[] = []
  const redraws: string[] = []
  const fix: Any = { id: 1, title: 'make the bar say read', words: ["make the bar's coverage item say read"], rounds: 1, made_in: 'terminal', created: 1761200000, state: 'working', work: WORK, commit: null, files: [], tests: null, summary: '', error: null }
  // the kernel's records: none until the first request
  let made = false
  // other fixes a test gives the kernel
  const others: Any[] = []
  const all = () => [...(made ? [fix] : []), ...others].filter(f => f.state !== 'removed')
  const list = () => ({ fixes: all(), on: true, live: `${HOME}/fixes/live`, version: '0.10.2', count_on: all().filter(f => f.state === 'on').length, pointed: true })
  const kernel = (argv: string[], stdin?: string) => {
    const ok = (out: unknown) => ({ exitCode: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' })
    const verb = argv[argv.indexOf('fix') + 1]
    if (verb === 'list') return ok(list())
    if (verb === 'sandbox') return ok(BOX)
    // the kernel records the session whose fixer works on the fix (new, round, redo)
    const si = argv.indexOf('--session')
    if (si > 0 && ['new', 'round', 'redo'].includes(verb!)) fix.session = argv[si + 1]
    if (verb === 'new') {
      made = true
      if (stdin) fix.words = [stdin]
      // the person's own words, which the kernel keeps beside Claude's
      const own = argv.find(x => x.startsWith('--asked='))
      if (own) fix.asked = [own.slice('--asked='.length)]
      return ok(fix)
    }
    // the check refused the change: another try in the same copy; the test's refusal was for the first try only
    if (verb === 'again') { Object.assign(fix, { state: 'working', rounds: fix.rounds + 1, refuse: null }); return ok(fix) }
    // a round of the fix: in its copy while it has one, else in place (a new copy; the version the person has, prev,
    // stays until y)
    if (verb === 'round') {
      if (!fix.work) Object.assign(fix, { prev: { state: fix.state, commit: fix.commit, title: fix.title, summary: fix.summary }, work: WORK })
      Object.assign(fix, { words: [...fix.words, stdin], rounds: fix.rounds + 1, state: 'working' })
      return ok(fix)
    }
    if (verb === 'done') {
      const t = argv.indexOf('--title')
      // a round of a fix changed in place keeps its name; one that changed no code leaves the fix as it was
      if (fix.prev && argv.includes('--request')) { Object.assign(fix, { ...fix.prev, work: null, prev: null }); return ok({ ...fix, unchanged: true }) }
      // the fixer ends saying it cannot be done: after a refusal of files no fix may change, the fix is blocked
      if (argv.includes('--cannot')) { Object.assign(fix, { state: 'failed', tests: null, error: stdin, refused: null, ...(fix.refused?.files?.length ? { blocked: fix.refused.files } : {}) }); return ok(fix) }
      Object.assign(fix, { state: argv.includes('--request') ? 'request' : 'ready', summary: stdin, commit: 'c0ffee1', tests: 'passed', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }] })
      // the kernel's check after the fixer's end refused it (fix.refuse is the reason a test gives), and the fix keeps
      // its name; a refusal of files no fix may change is kept on the record (refused) until the next check. A change
      // it uses takes the fixer's title
      if (fix.refuse) Object.assign(fix, { state: 'failed', tests: null, error: fix.refuse, refused: /no fix may change/.test(fix.refuse) ? { why: fix.refuse, files: ['plugin/engine/kernel/privacy.py'] } : { why: fix.refuse, files: [], tests: 'FAIL made-up test' } })
      else Object.assign(fix, { refused: null, title: t > 0 && !fix.prev ? argv[t + 1] : fix.title })
      return ok(fix)
    }
    if (verb === 'apply') {
      // the kernel checks the press's secret against the sha256 the plugin wrote
      const id = Number(argv[argv.indexOf('apply') + 1])
      if (!JSON.parse(files.get(`${HOME}/fixes/asks/${id}.json`) ?? '{}').key || !stdin) return { exitCode: 1, stdout: '', stderr: "thimble fix apply: only the person's key press in thimble does that" }
      const f = id === 1 ? fix : others.find(x => x.id === id)
      const changed = !!f.prev
      Object.assign(f, { state: 'on', work: null })
      return ok({ id, reload: true, version: '0.10.2+fix.c0ffee1', ...(changed ? { changed: true } : {}) })
    }
    if (verb === 'remove') { if (argv.includes('1')) fix.state = 'removed'; return ok({ id: 1, reload: false }) }
    if (verb === 'merge') {
      const ids = argv.slice(argv.indexOf('merge') + 1, argv.indexOf('--ask')).map(Number)
      if (!JSON.parse(files.get(`${HOME}/fixes/asks/${ids[0]}.json`) ?? '{}').key || !stdin) return { exitCode: 1, stdout: '', stderr: "thimble fix merge: only the person's key press in thimble does that" }
      const t = argv.indexOf('--title')
      return ok({ id: ids[0], title: t > 0 ? argv[t + 1] : 'first', merged: ids.slice(1), redo: [], reload: true })
    }
    // another try: a blocked fix only with new words, as the kernel says
    if (verb === 'redo') {
      if (fix.blocked?.length && !stdin) return { exitCode: 1, stdout: '', stderr: 'thimble fix redo: fix 1 needs a change to plugin/engine/kernel/privacy.py, which no fix may make' }
      Object.assign(fix, { state: 'working', refuse: null, blocked: undefined })
      return ok(fix)
    }
    // u after y on a fix changed in place: its version before comes back
    if (verb === 'undo') {
      if (fix.prev) { Object.assign(fix, { ...fix.prev, prev: null }); return ok({ id: 1, reload: true, back: true }) }
      fix.state = 'off'
      return ok({ id: 1, reload: true })
    }
    if (verb === 'notnow') { fix.state = 'off'; return ok(fix) }
    if (verb === 'diff') return ok('diff --git a/plugin/bar/bar.tsx b/plugin/bar/bar.tsx\n-  coverage\n+  read\n')
    if (verb === 'update' && argv.includes('--check')) return ok(fix.check ?? { from: '0.10.2', to: '0.10.3', newer: fix.state === 'on' })
    if (verb === 'share') {
      const given = stdin ? JSON.parse(stdin) : null
      return ok({ id: 1, title: given?.title || fix.title, took: 'took 1 file name out of the text', opened: argv.includes('--open'), url: 'https://github.com/safety-research/thimble/issues/new?title=Bar%20says%20read&body=What%20was%20wrong', shortened: false, text: given ? 'claude' : 'earlier' })
    }
    return ok({})
  }
  const where = { root: '/made-up/data' }
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
    session: { id: async () => 's-fix', cwd: async () => where.root, root: async () => where.root, send: async (a: Any) => { sent.push(a); return { isDelivered: true } } },
    config: { list: async () => config },
    // the person's rules, as Claude Code reads them: they deny rm -rf
    tool: { check: async (q: Any) => ({ decision: /^rm -rf/.test(String(q.input?.command)) ? 'deny' : 'ask', reason: 'Bash(rm -rf:*) is denied' }) },
    process: { run: async (argv: string[], o: Any = {}) => { ran.push({ argv, env: o.env, ...(o.stdin != null ? { stdin: o.stdin } : {}) }); return argv.includes('fix') ? kernel(argv, o.stdin) : { exitCode: 0, stdout: '', stderr: '' } } },
    command: { run: async (c: Any) => { commands.push(c.command); return {} }, register: async () => ({ command: 'thimble-fix' }) },
    prompt: {
      read: async () => ({ text: box.text, cursor: box.text.length }),
      fill: async (a: Any) => {
        fills.push(a)
        box.text = a.mode === 'append' ? box.text + a.text : a.text
        return { isFilled: true, text: box.text, cursor: box.text.length }
      },
    },
    model: { complete: async (req: Any) => { asked.push(req); return { isAnswered: true, text: JSON.stringify({ title: 'Bar says coverage, not read', wrong: 'The bar said coverage after Claude read a file.', fixed: 'The bar says read.' }) } } },
    ui: { copy: async (o: Any) => { copied.push(o.text); return { isCopied: true } }, toast: (t: string) => { toasts.push(t) }, notify: async (text: string, o: Any = {}) => { notes.push({ text, title: o.title }); return { isSent: true } }, log: () => undefined, open: async (o: Any) => { opened.push(o.id); return { isPlaced: true } }, panes: async () => opened.map(id => ({ id })), close: async () => ({}), invalidate: (ev: string) => { redraws.push(ev) } },
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
  // the session the plugin names on new, round, redo and done, how long done waits for the tests, and the person's own
  // words, are left out: tests look at them apart
  const verbs = () => ran.map(r => r.argv.slice(r.argv.indexOf('fix') + 1).filter(x => !x.startsWith('--asked=')).join(' ').replace(/ --session \S+/, '').replace(/ --within \S+/, '')).filter(Boolean)
  /** The fixer's end: its agent idles, and its turn's end reaches the hooks. */
  const end = async (answer: string, agentId = 'agent-fixer-1') => {
    for (const a of agents) if (a.id === agentId) a.status = 'idle'
    await call('turn.complete', { turnId: 't-f', agentId, reason: 'answer', answer, durationMs: 9, isAborted: false }, async () => ({}))
    await tick()
  }
  return { $, call, tick, end, made: () => { made = true }, others, ran, spawns, commands, files, fix, opened, toasts, notes, sent, agents, config, state, verbs, copied, asked, where, box, fills, redraws }
}

/** The person's /thimble-fix <words>: the command runs the plugin's prompt command with the words a moment later, and
 *  Claude, reading it, starts the fix with the fix-thimble skill. What Claude reads in the skill's place. */
async function ask(s: ReturnType<typeof setup>, words: string): Promise<Any> {
  const own = await s.call('command.run', { command: 'thimble-fix', args: words }, async () => { throw new Error('/thimble-fix with words runs no command of its own') })
  expect(own).toEqual({})
  await s.tick()
  expect(s.commands.splice(s.commands.indexOf('thimble:thimble-fix'), 1)).toEqual(['thimble:thimble-fix'])
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
    expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5b', agentId, command: 'cd x && thimble  fix send 1 --answer pr' }, ran)).deny)).toContain('Only thimble and the person')
    // sending a fix publicly is the person's own command, never Claude's
    for (const command of ['thimble file pr 1 --yes', 'thimble file issue 1 --open', 'cd x && thimble  file  pr 2'])
      expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5d', agentId, command }, ran)).deny)).toContain('Only thimble and the person')
    // another round after a refusal is thimble's to start, never Claude's
    expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5c', agentId, command: 'thimble fix again 1' }, ran)).deny)).toContain('Only thimble and the person')
    expect(String((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-6', agentId, file_path: `${HOME}/fixes/asks/1.json` }, ran)).deny)).toContain('thimble alone')
  }
  expect((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-7', command: 'thimble fix list' }, ran)).result.ran).toBe('thimble fix list')
})

test("two sessions share the fixes' folder: a fix another session's fixer works on is never ended, given words or told of here", async () => {
  const s = setup()
  const other = (id: number, session?: string) => ({ id, title: `a change made elsewhere ${id}`, words: ['made-up words'], rounds: 1, made_in: 'terminal', created: 1761100000, state: 'working', work: `${HOME}/fixes/work/${id}`, commit: null, files: [], tests: null, summary: '', error: null, ...(session ? { session } : {}) })
  // fix 7: another session's fixer works on it; fix 8: a record with no session, whose fixer this session never started
  s.others.push(other(7, 's-other'), other(8))
  await s.call('session.start', { cwd: '/made-up/data' })
  await new Promise(r => setTimeout(r, 20))
  await s.call('turn.complete', { turnId: 't-main', reason: 'answer', answer: 'ok', durationMs: 9, isAborted: false }, async () => ({}))
  await s.tick()
  expect(s.verbs().filter(v => /^done (7|8)\b/.test(v))).toEqual([])
  // words go to a new fix of this session's, which the kernel records with this session
  const r = await ask(s, "make the bar's coverage item say read")
  expect(String(r.text)).toContain('("make the bar say read")')
  expect(s.sent).toEqual([])
  expect(s.ran.find(x => x.argv.includes('new'))?.argv.slice(-2)).toEqual(['--session', 's-fix'])
  await s.end('Title: Bar says read\nWhat it does: The bar says read.')
  expect(s.ran.find(x => x.argv.includes('done'))?.argv).toEqual(expect.arrayContaining(['done', '1', '--session', 's-fix']))
  expect(s.verbs().filter(v => /^done (7|8)\b/.test(v))).toEqual([])
  expect(s.notes.map(n => n.text)).toEqual(['thimble fixed: Bar says read · tests pass'])
})

test('more words while the fixer works go to the same fixer, as a round of its fix', async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  await ask(s, "make the bar's coverage item say read")
  const r = await ask(s, 'and keep the percent')
  expect(String(r.text)).toBe('thimble gave these words to the fork that is already fixing "make the bar say read". Tell the person in one short line, then go on with their request.')
  expect(s.spawns.length).toBe(1)
  expect(s.ran.find(x => x.argv.includes('round'))?.stdin).toBe('and keep the percent')
  expect(s.sent).toEqual([{ to: { agentId: 'agent-fixer-1' }, text: 'The person adds to this fix (round 2): and keep the percent' }])
  // once the fixer ended, new words are a new request
  await s.end('Title: Bar says read\nWhat it does: The bar says read.')
  await (await fixKey(s.$, 'n'))!.later()
  s.fix.state = 'ready'
  await ask(s, 'the pane title too')
  expect(s.sent.length).toBe(1)
  expect(s.spawns.length).toBe(2)
})

test("the fixer's end: the line and a notification say it is fixed; d shows what changed; y applies it with the press's secret and reloads; u undoes it", async () => {
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
  // once the fix is on and loaded, its line goes; the transcript keeps one line that says so
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(await fixKey(s.$, 'y')).toBe(null)
  expect(await fixKey(s.$, 'u')).toBe(null)
})

test("y while Claude is mid-reply: the reload waits for the turn's end, and the line says so; a --plugin-dir session is told to restart", async () => {
  const s = setup()
  await requested(s)
  await s.$.state.set({ plugin: 'thimble', key: 'mainTurn' }, 't-main')
  await (await fixKey(s.$, 'y'))!.later()
  expect(s.commands).toEqual([])
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ Bar says read for coverage is on · reloads when Claude finishes · u undo')
  // the person's prompt keeps the line while the reload waits
  await s.call('prompt.submit', { text: 'Which runs failed?', origin: { kind: 'composer' } })
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain('reloads when Claude finishes')
  await s.$.state.set({ plugin: 'thimble', key: 'mainTurn' }, null)
  await s.call('turn.complete', { turnId: 't-main', reason: 'answer', answer: 'Runs 3 and 9.', durationMs: 9, isAborted: false }, async () => ({}))
  await s.tick()
  expect(s.commands).toEqual(['reload-plugins'])
  // the new load of the plugin: the fix is on, and its line goes
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])

  const t = setup()
  t.config.push({ key: 'thimble@inline.cards', value: true })
  await requested(t)
  await (await fixKey(t.$, 'y'))!.later()
  expect(t.verbs()).toContain('apply 1 --ask -')
  expect(t.commands).toEqual([])
  expect(textOf((await fixLineRows(t.$, ELS, 160))[0])).toBe(`  ✓ Bar says read for coverage is on · restart Claude Code with --plugin-dir ${HOME}/fixes/live/plugin to load it · u undo`)
})

test('a fixer that works on across a reload keeps its step and its time on the bar, and the step reads the list this session keeps, not the kernel at each tick', async () => {
  const s = setup()
  // the session's clock, in milliseconds since 1970 as Claude Code's; the fix's round started 100 s ago (the kernel's
  // `started`, in seconds)
  now = 10 ** 13
  s.made()
  s.fix.started = (now - 100000) / 1000
  s.agents.push({ id: 'agent-fixer-1', status: 'running' })
  await s.$.state.set({ plugin: 'thimble', key: 'fixers' }, { 'agent-fixer-1': 1 })
  // a setting changed, so the plugins reloaded: the module's session start again
  await s.call('session.start', { cwd: '/made-up/data' })
  await new Promise(r => setTimeout(r, 20))
  const shown = await busyNow(s.$)
  expect(shown?.word).toBe('fixing make the bar say read')
  expect(shown?.secs).toBeGreaterThanOrEqual(100)
  const lists = () => s.verbs().filter(v => v.startsWith('list')).length
  const before = lists()
  for (let i = 0; i < 5; i++) await s.tick()
  expect(lists()).toBe(before)
})

/** The kernel's first `n` answers to done: the fix still working, its tests still running in the kernel's own process.
 *  Each done call, with the bar's steps while it runs. */
function stillTesting(s: ReturnType<typeof setup>, n: number): { argv: string[]; timeoutMs: number; steps: string[] }[] {
  const calls: { argv: string[]; timeoutMs: number; steps: string[] }[] = []
  const run = s.$.process.run
  s.$.process.run = async (argv: string[], o: Any = {}) => {
    if (argv.includes('done')) {
      calls.push({ argv, timeoutMs: o.timeoutMs, steps: busySteps() })
      if (n-- > 0) return { exitCode: 0, stdout: JSON.stringify({ ...s.fix, state: 'working', testing: { since: 1761200000, lock: `${HOME}/fixes/tests/1.lock` } }), stderr: '' }
    }
    return run(argv, o)
  }
  return calls
}

test("while the fix's tests still run, the check asks the kernel again, each call within Claude Code's 10 minutes, with testing <name> on the bar; then the line says what came of them", async () => {
  const s = setup()
  const calls = stillTesting(s, 2)
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  expect(calls.length).toBe(3)
  for (const c of calls) {
    expect(c.argv).toEqual(expect.arrayContaining(['done', '1', '--summary', '-', '--title', 'Bar says read', '--within', '540']))
    expect(c.timeoutMs).toBe(600000)
    expect(c.steps).toContain('testing make the bar say read')
  }
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Bar says read · tests pass')
  expect(s.notes.map(n => n.text)).toEqual(['thimble fixed: Bar says read · tests pass'])
  expect(busySteps()).not.toContain('testing make the bar say read')
})

test("a fix whose tests run when the plugins reload is waited for: its fixer's end, taken again, asks the kernel until the tests ended, then shows the line", async () => {
  const s = setup()
  s.made()
  // the fixer ended and its change is being tested; the reload came before the check said what came of it
  s.agents.push({ id: 'agent-fixer-1', status: 'idle' })
  await s.$.state.set({ plugin: 'thimble', key: 'fixers' }, { 'agent-fixer-1': 1 })
  const calls = stillTesting(s, 1)
  await s.call('session.start', { cwd: '/made-up/data' })
  await new Promise(r => setTimeout(r, 20))
  await s.tick()
  expect(calls.map(c => [c.argv.includes('--within'), c.timeoutMs])).toEqual([[true, 600000], [true, 600000]])
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: make the bar say read · tests pass')
})

/** The kernel's answers to done, one a call (the fix with these fields), then the fake kernel's own. Each done call,
 *  with what the bar showed while it ran. */
function doneSays(s: ReturnType<typeof setup>, answers: Any[]): { argv: string[]; bar: Any }[] {
  const calls: { argv: string[]; bar: Any }[] = []
  const run = s.$.process.run
  s.$.process.run = async (argv: string[], o: Any = {}) => {
    if (argv.includes('done')) {
      calls.push({ argv, bar: await busyNow(s.$) })
      const a = answers.shift()
      if (a) return { exitCode: 0, stdout: JSON.stringify({ ...s.fix, ...a }), stderr: '' }
    }
    return run(argv, o)
  }
  return calls
}

const TESTING = { since: 1761200000, lock: `${HOME}/fixes/tests/1.lock` }

test('a new round that took the copy while the tests ran: the check of the round before shows no line', async () => {
  const s = setup()
  // more words for the fix while its tests ran: the kernel's next answer is the new round, working, with no tests
  const calls = doneSays(s, [{ state: 'working', testing: TESTING }, { state: 'working', testing: null }])
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  expect(calls.length).toBe(2)
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(s.notes).toEqual([])
  expect(s.verbs().some(v => v.startsWith('again'))).toBe(false)
})

test('the check asks again only while the fix works and its tests run: a fix removed meanwhile ends the asking', async () => {
  const s = setup()
  // a record of a fix removed while its tests ran, written with the mark of them
  const calls = doneSays(s, Array.from({ length: 5 }, () => ({ state: 'removed', testing: TESTING })))
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  expect(calls.length).toBe(1)
})

test('a fix whose tests ran for minutes before a reload: the bar counts testing <name> from their start', async () => {
  const s = setup()
  now = 3 * 10 ** 13
  s.made()
  Object.assign(s.fix, { started: (now - 300000) / 1000, testing: { since: (now - 200000) / 1000, lock: `${HOME}/fixes/tests/1.lock` } })
  s.agents.push({ id: 'agent-fixer-1', status: 'idle' })
  await s.$.state.set({ plugin: 'thimble', key: 'fixers' }, { 'agent-fixer-1': 1 })
  const calls = doneSays(s, [{ state: 'ready', tests: 'passed', testing: null }])
  await s.call('session.start', { cwd: '/made-up/data' })
  await new Promise(r => setTimeout(r, 20))
  await s.tick()
  expect(calls[0]?.bar?.word).toBe('testing make the bar say read')
  expect(calls[0]?.bar?.secs).toBeGreaterThanOrEqual(200)
})

test("what came of a check that no session waited for gets its line at this session's start, with the notification, Claude told, and the kernel told it was shown; a refused change gets another round", async () => {
  const s = setup()
  s.made()
  // the session ended while the tests ran, and the kernel's runner wrote what came of them, not shown yet
  Object.assign(s.fix, { state: 'ready', tests: 'passed', commit: 'c0ffee1', title: 'Bar says read', session: 's-fix', unshown: true })
  await s.call('session.start', { cwd: '/made-up/data' })
  await new Promise(r => setTimeout(r, 20))
  await s.tick()
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Bar says read · tests pass')
  expect(s.notes.map(n => n.text)).toEqual(['thimble fixed: Bar says read · tests pass'])
  expect(s.verbs()).toContain('shown 1')
  const told = ((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['fix-1']).toBe(`thimble's fixer finished the fix "Bar says read"; it waits for the person's y. Nothing for you to do.`)
  // another session's outcome is that session's to show
  const o = setup()
  o.made()
  Object.assign(o.fix, { state: 'ready', tests: 'passed', session: 's-other', unshown: true })
  await o.call('session.start', { cwd: '/made-up/data' })
  await new Promise(r => setTimeout(r, 20))
  expect(await fixLineRows(o.$, ELS, 110)).toEqual([])
  expect(o.verbs().some(v => v.startsWith('shown'))).toBe(false)
  // tests that failed: a new fixer in the same copy, told why, as at the fixer's end
  const t = setup()
  t.made()
  Object.assign(t.fix, { state: 'failed', tests: 'failed', session: 's-fix', unshown: true, error: 'its tests failed in the sandbox', refused: { why: 'its tests failed in the sandbox', files: [], tests: 'FAIL made-up test' } })
  await t.call('session.start', { cwd: '/made-up/data' })
  await new Promise(r => setTimeout(r, 20))
  await t.tick()
  expect(t.verbs()).toContain('again 1')
  expect(t.spawns.length).toBe(1)
  expect(String(t.spawns[0].prompt)).toContain('FAIL made-up test')
})

/** What Claude is told of fix 1 at the person's next prompt, or ''. */
async function toldOf(s: ReturnType<typeof setup>): Promise<string> {
  return ((((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>)['fix-1']) ?? ''
}

test("a new round that took the copy before the check's first answer: the check shows no line and tells Claude nothing", async () => {
  const s = setup()
  // the kernel's first answer is already the new round: working, with no tests running
  const calls = doneSays(s, [{ state: 'working', testing: null, rounds: 2 }])
  await s.call('session.start', { cwd: '/made-up/data' })
  await ask(s, "make the bar's coverage item say read")
  await s.end('Title: Bar says read\nWhat it does: The bar says read.')
  expect(calls.length).toBe(1)
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(s.notes).toEqual([])
  expect(await toldOf(s)).not.toContain('did not pass')
  expect(s.verbs().some(v => v.startsWith('again'))).toBe(false)
})

test('a fix removed in a shell while its tests ran: the check shows no line, so no y offers to try again a fix that is gone', async () => {
  const s = setup()
  // the kernel's answer: the record of the fix removed, with no tests running
  const calls = doneSays(s, [{ state: 'removed', testing: null }])
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  expect(calls.length).toBe(1)
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(await fixKey(s.$, 'y')).toBe(null)
  expect(s.notes).toEqual([])
  expect(await toldOf(s)).not.toContain('did not pass')
})

/** Waits a little for what a check not awaited does. */
async function until(f: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 200 && !(await f()); i++) await new Promise(r => setTimeout(r, 5))
}

test("what the kernel's runner wrote just after this session's start read the list gets its line when the look for ended fixers takes the fix", async () => {
  const s = setup()
  s.made()
  Object.assign(s.fix, { session: 's-fix', testing: TESTING })
  s.agents.push({ id: 'agent-fixer-1', status: 'idle' })
  await s.$.state.set({ plugin: 'thimble', key: 'fixers' }, { 'agent-fixer-1': 1 })
  // the start's read of the list says working; the runner writes what came of the tests before the next read
  const run = s.$.process.run
  let lists = 0
  s.$.process.run = async (argv: string[], o: Any = {}) => {
    if (argv.includes('list') && ++lists === 2) Object.assign(s.fix, { state: 'ready', tests: 'passed', commit: 'c0ffee1', title: 'Bar says read', testing: null, unshown: true })
    return run(argv, o)
  }
  await s.call('session.start', { cwd: '/made-up/data' })
  await until(async () => (await fixLineRows(s.$, ELS, 110)).length > 0)
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Bar says read · tests pass')
  expect(s.notes.map(n => n.text)).toEqual(['thimble fixed: Bar says read · tests pass'])
  expect(s.verbs()).toContain('shown 1')
  expect(s.verbs().some(v => v.startsWith('done'))).toBe(false)
})

test('an outcome not shown yet whose refusal a new round answers is marked shown before that round, so no later start shows it or tells Claude again', async () => {
  const s = setup()
  s.made()
  Object.assign(s.fix, { state: 'failed', tests: 'failed', session: 's-fix', unshown: true, error: 'its tests failed in the sandbox', refused: { why: 'its tests failed in the sandbox', files: [], tests: 'FAIL made-up test' } })
  await s.call('session.start', { cwd: '/made-up/data' })
  await until(() => s.spawns.length > 0)
  const v = s.verbs()
  expect(v).toContain('shown 1')
  expect(v.indexOf('shown 1')).toBeLessThan(v.indexOf('again 1'))
})

test("after /resume gives the session a new id, an outcome not shown yet of the conversation's fix gets its line: by the conversation the kernel kept, or by this load's own fixers", async () => {
  // claude --resume: a new session id, the conversation's first launch and its transcript carried
  const s = setup()
  s.made()
  Object.assign(s.fix, { state: 'ready', tests: 'passed', commit: 'c0ffee1', title: 'Bar says read', session: 's-made-up-old', conversation: 's-made-up-old', unshown: true })
  Object.assign(s.$.session, { id: async () => 's-made-up-resumed', usage: async () => ({ startedAt: 1761100000000 }), messages: async () => [{ role: 'user' }] })
  s.files.set(`${HOME}/starts/1761100000000.json`, JSON.stringify({ key: 's-made-up-old', sessions: ['s-made-up-old'] }))
  await s.call('session.start', { cwd: '/made-up/data' })
  await until(async () => (await fixLineRows(s.$, ELS, 110)).length > 0)
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Bar says read · tests pass')
  expect(s.verbs()).toContain('shown 1')
  // /resume inside a running Claude Code: the record names the old session only, and this load started its fixer
  const t = setup()
  t.made()
  Object.assign(t.fix, { state: 'ready', tests: 'passed', commit: 'c0ffee1', title: 'Bar says read', session: 's-made-up-old', unshown: true })
  await t.$.state.set({ plugin: 'thimble', key: 'fixers' }, { 'agent-fixer-1': 1 })
  await t.call('session.start', { cwd: '/made-up/data' })
  await until(async () => (await fixLineRows(t.$, ELS, 110)).length > 0)
  expect(textOf((await fixLineRows(t.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Bar says read · tests pass')
  expect(t.verbs()).toContain('shown 1')
})

test("a round's fixer that ends while the check of the round before waits: its end is kept, and checked with its own words once that check returns", async () => {
  const s = setup()
  // the first check's done answers only when the test lets it; by then the new round took the copy
  let answer: () => void = () => undefined
  const held = new Promise<void>(r => { answer = r })
  const calls: { argv: string[]; stdin?: string }[] = []
  const run = s.$.process.run
  s.$.process.run = async (argv: string[], o: Any = {}) => {
    if (argv.includes('done')) {
      calls.push({ argv, stdin: o.stdin })
      if (calls.length === 1) {
        await held
        return { exitCode: 0, stdout: JSON.stringify({ ...s.fix, state: 'working', testing: null }), stderr: '' }
      }
    }
    return run(argv, o)
  }
  await s.call('session.start', { cwd: '/made-up/data' })
  await ask(s, "make the bar's coverage item say read")
  await s.end('Title: Bar says read\nWhat it does: The bar says read.')
  expect(calls.length).toBe(1)
  // the person's follow-up while the check waits: a round of the fix, with a fixer of its own
  await ask(s, '1 and keep the percent')
  expect(s.spawns.length).toBe(2)
  await s.end('Cannot: the percent is not in the data', 'agent-fixer-2')
  expect(calls.length).toBe(1)
  answer()
  await until(async () => calls.length > 1 && (await fixLineRows(s.$, ELS, 110)).length > 0)
  expect(calls.length).toBe(2)
  expect(calls[1]!.argv).toEqual(expect.arrayContaining(['done', '1', '--cannot', '-']))
  expect(calls[1]!.stdin).toBe('the percent is not in the data')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toContain('did not pass · the percent is not in the data')
})

test('an end kept while a check waited is not checked when more words started a newer fixer: that fixer\'s own end checks the copy', async () => {
  const s = setup()
  let answer: () => void = () => undefined
  const held = new Promise<void>(r => { answer = r })
  const calls: string[][] = []
  const run = s.$.process.run
  s.$.process.run = async (argv: string[], o: Any = {}) => {
    if (argv.includes('done')) {
      calls.push(argv)
      if (calls.length === 1) {
        await held
        return { exitCode: 0, stdout: JSON.stringify({ ...s.fix, state: 'working', testing: null }), stderr: '' }
      }
    }
    return run(argv, o)
  }
  await s.call('session.start', { cwd: '/made-up/data' })
  await ask(s, "make the bar's coverage item say read")
  await s.end('Title: Bar says read\nWhat it does: The bar says read.')
  await ask(s, '1 and keep the percent')
  await s.end('Title: Bar says read percent\nWhat it does: The bar says read 14%.', 'agent-fixer-2')
  // more words before the first check returned: a third fixer, which still works
  await ask(s, '1 and say it in the pane too')
  expect(s.spawns.length).toBe(3)
  answer()
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5))
  expect(calls.length).toBe(1)
  await s.end('Title: Bar and pane say read percent\nWhat it does: The bar and the pane say read 14%.', 'agent-fixer-3')
  await until(() => calls.length > 1)
  expect(calls.length).toBe(2)
  expect(calls[1]).toEqual(expect.arrayContaining(['--title', 'Bar and pane say read percent']))
})

test('n leaves the fix ready in the list, where thimble fix apply in a shell turns it on; a fixer that changed nothing leaves a request', async () => {
  const s = setup()
  await requested(s)
  await (await fixKey(s.$, 'n'))!.later()
  expect(s.verbs().some(v => v.startsWith('notnow'))).toBe(false)
  expect(s.fix.state).toBe('ready')
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(s.toasts.join('\n')).toContain('“Bar says read for coverage” waits, ready: in a shell, thimble fix apply 1 turns it on, and thimble fix list lists your fixes.')
  const t = setup()
  await requested(t, 'Title: Explain terms of my field\nRequest: It needs words only the person knows.')
  expect(t.verbs()).toContain('done 1 --summary - --title Explain terms of my field --request')
  expect(textOf(await fixLineRows(t.$, ELS, 110))).toContain('Saved as a request with no code: Explain terms of my field')
})

test("a fix that changes the sandbox, the launcher or dependencies says which in one sentence on the line that asks for y, and in d", async () => {
  const s = setup()
  s.fix.notice = { 'the sandbox': ['plugin/cards/argv.mjs'], dependencies: ['browser/frontend/package-lock.json'] }
  await requested(s, 'Title: Cards draw on Node 26\nWhat it does: The card runner starts with --allow-net.')
  const said = 'This fix changes the sandbox (plugin/cards/argv.mjs) and dependencies (browser/frontend/package-lock.json).'
  expect(noticeText(s.fix)).toBe(said)
  let rows = await fixLineRows(s.$, ELS, 160)
  expect(rows.map(textOf)).toEqual(['  ✓ thimble fixed: Cards draw on Node 26 · tests pass', `    ${said}`, '    y use it now · d what changed · n later'])
  await (await fixKey(s.$, 'd'))!.later()
  rows = await fixLineRows(s.$, ELS, 160)
  expect(rows.map(textOf)).toContain(`    Note        ${said}`)
  // y applies it as any fix
  await (await fixKey(s.$, 'y'))!.later()
  expect(s.verbs()).toContain('apply 1 --ask -')
  expect(noticeText({ notice: { 'the launcher': ['plugin/bin/thimble'] } })).toBe('This fix changes the launcher (plugin/bin/thimble).')
  expect(noticeText({})).toBe('')
})

test("the plugin runs the kernel with the release checkout's launcher, which no fix changes, once there is one that hands the way back off itself, and names the folder it was loaded from", async () => {
  const s = setup()
  await requested(s)
  // before the first fix the loaded plugin is the release: its launcher
  expect(s.ran.find(x => x.argv.includes('new'))?.argv[0]).toBe('/made-up/plugin/bin/thimble')
  // a release checkout from before the hand-off (its launcher names no fixes/release/plugin) runs an older kernel: the
  // loaded plugin's launcher runs, as that launcher's own guard does
  s.files.set(`${HOME}/fixes/release/plugin/bin/thimble`, '#!/bin/sh\n# a made-up launcher from before the hand-off\n')
  await refreshFixes(s.$)
  expect(s.ran.filter(x => x.argv.includes('list')).at(-1)?.argv[0]).toBe('/made-up/plugin/bin/thimble')
  s.files.set(`${HOME}/fixes/release/plugin/bin/thimble`, '#!/bin/sh\n# the way back runs from $THIMBLE_HOME/fixes/release/plugin (made up)\n')
  await (await fixKey(s.$, 'y'))!.later()
  const apply = s.ran.find(x => x.argv.includes('apply'))!
  expect(apply.argv[0]).toBe(`${HOME}/fixes/release/plugin/bin/thimble`)
  expect(apply.env?.THIMBLE_PLUGIN_ROOT).toBe('/made-up/plugin')
  // the release's kernel writes no bytecode into the release checkout, whatever its launcher says
  expect(apply.env?.PYTHONDONTWRITEBYTECODE).toBe('1')
})

const WAY_BACK = 'it changes plugin/engine/kernel/privacy.py (the privacy scan); no fix may change the code that turns fixes off and undoes them, or the scan a shared fix goes through'

test('a refused change goes back to a new fixer in the same copy, told what was refused and why; its next round passes, and the person sees no failure', async () => {
  const s = setup()
  const why = WAY_BACK
  s.fix.refuse = why
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  expect(s.verbs()).toContain('again 1')
  expect(s.spawns.length).toBe(2)
  const second = String(s.spawns[1].prompt)
  expect(second).toContain(`thimble did not use the last change for this fix: ${why}. Your last change is in your copy. Leave plugin/engine/kernel/privacy.py as it is and make the change in other files. When the request truly cannot be met without that, end with one line \`Cannot: <why, in plain words for the person>\` in place of the Title line; thimble shows that line to the person.`)
  expect(String(s.spawns[0].prompt)).not.toContain('did not use the last change')
  // the same fix, tried again: its name stays (the refused try's title is not used), on the bar too
  expect(s.spawns[1].name).toBe(s.spawns[0].name)
  expect(busySteps()).toContain('fixing make the bar say read')
  // no failure line and no notification while the next round works
  expect(textOf(await fixLineRows(s.$, ELS, 110))).not.toContain('did not pass')
  expect(s.notes).toEqual([])
  await s.end('Title: Skip the scan for my notes\nWhat it does: The notes you name are left out of what the scan reads.', 'agent-fixer-2')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Skip the scan for my notes · tests pass')
  expect(s.verbs().filter(v => v.startsWith('again'))).toEqual(['again 1'])
  // failing tests go back too, with the end of their output
  const t = setup()
  t.fix.refuse = 'its tests failed in the sandbox'
  await requested(t)
  expect(String(t.spawns[1].prompt)).toContain('thimble did not use the last change for this fix: its tests failed in the sandbox. Your last change is in your copy. The end of their output:\n\nFAIL made-up test\n\nFix what fails.')
})

test("a failed fix's line goes at the next prompt, as a request's does; the fix stays failed in the list, and y is no longer the line's", async () => {
  const s = setup()
  s.fix.refuse = 'its tests failed in the sandbox'
  await requested(s)
  await s.end('Cannot: it needs the scan off', 'agent-fixer-2')
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain('did not pass')
  await s.call('prompt.submit', { text: 'Which runs failed?', origin: { kind: 'composer' } })
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(await fixKey(s.$, 'y')).toBe(null)
  expect(s.fix.state).toBe('failed')
  // n dismisses it before then
  const t = setup()
  t.fix.refuse = 'its tests failed in the sandbox'
  await requested(t)
  await t.end('Cannot: it needs the scan off', 'agent-fixer-2')
  await (await fixKey(t.$, 'n'))!.later()
  expect(await fixLineRows(t.$, ELS, 110)).toEqual([])
  const u = setup()
  await requested(u, 'Title: Explain terms of my field\nRequest: It needs words only the person knows.')
  await u.call('prompt.submit', { text: 'Which runs failed?', origin: { kind: 'composer' } })
  expect(await fixLineRows(u.$, ELS, 110)).toEqual([])
})

test('a fixer that finds the request cannot be met ends with Cannot: the line shows its words, long on a row of its own, short after the title; d shows what it tried and why, y tries again, n dismisses, and a fix blocked by the files no fix may change offers no y', async () => {
  const s = setup()
  const why = 'The scan is part of what keeps your data private, and a fix may not change it, so notes cannot skip it.'
  s.fix.refuse = WAY_BACK
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await s.end(`I could not do this.\n\nCannot: ${why}`, 'agent-fixer-2')
  expect(s.ran.find(x => x.argv.includes('--cannot'))?.stdin).toBe(why)
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows)).toContain('× make the bar say read did not pass')
  expect(rows.map((r: Any) => r.props.key)).toEqual(['fix-line-1', 'fix-line-why', 'fix-line-2'])
  expect(textOf(rows[1])).toBe(`    ${why}`)
  // blocked: another try would fail the same way, so no y
  expect(textOf(rows[2])).toBe('    d ask Claude · n dismiss')
  expect(await fixKey(s.$, 'y')).toBe(null)
  expect(s.notes).toEqual([])
  await (await fixKey(s.$, 'd'))!.later()
  // the box holds the failure d put there, so what it tried shows with no key under it: n would type into it
  rows = await fixLineRows(s.$, ELS, 110)
  expect(rows.slice(-2).map(textOf)).toEqual(['    Tried       plugin/bar/bar.tsx', `    Why         ${why}`])
  // the person clears the box: n acts there again, and shows
  s.box.text = ''
  expect(textOf((await fixLineRows(s.$, ELS, 110)).at(-1))).toBe('    n dismiss')
  // a failure another try can mend: y tries it again, the person's own key, and the new fixer is told where the
  // earlier change is
  const t = setup()
  t.fix.refuse = 'its tests failed in the sandbox'
  await requested(t, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await t.end('Cannot: it needs the scan off', 'agent-fixer-2')
  rows = await fixLineRows(t.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  × make the bar say read did not pass · it needs the scan off')
  expect(rows.map((r: Any) => r.props.key)).not.toContain('fix-line-why')
  expect(textOf(rows[1])).toBe('    y try again · d ask Claude · n dismiss')
  await (await fixKey(t.$, 'd'))!.later()
  t.box.text = ''
  expect(textOf((await fixLineRows(t.$, ELS, 110)).at(-1))).toBe('    y try again · n dismiss')
  await (await fixKey(t.$, 'y'))!.later()
  expect(t.verbs()).toContain('redo 1')
  expect(t.spawns.length).toBe(3)
  expect(String(t.spawns[2].prompt)).toContain(`is in ${HOME}/fixes/tmp/1/earlier.patch;`)
})

test('a failed fix offers y try again and d ask Claude, never r: y, or a click on its words, starts it again in a new copy, and r is no key of the line', async () => {
  const s = setup()
  s.fix.refuse = 'its tests failed in the sandbox'
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await s.end('Cannot: it needs the scan off', 'agent-fixer-2')
  const rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows.at(-1))).toBe('    y try again · d ask Claude · n dismiss')
  expect(textOf(rows)).not.toContain('redo')
  expect(await fixKey(s.$, 'r')).toBe(null)
  // d: what it tried and why it did not pass, never Changed
  await (await fixKey(s.$, 'd'))!.later()
  const open = await fixLineRows(s.$, ELS, 110)
  expect(textOf(open.find((r: Any) => r.props.key === 'fix-what-tried'))).toBe('    Tried       plugin/bar/bar.tsx')
  expect(textOf(open.find((r: Any) => r.props.key === 'fix-what-why'))).toBe('    Why         it needs the scan off')
  expect(textOf(open)).not.toContain('Changed')
  // d asked Claude already: it is no key of the view it opened
  expect(await fixKey(s.$, 'd')).toBe(null)
  // a click on `y try again` does what y does
  const buttons = (n: Any): Any[] => (n == null || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(buttons) : [...(n.type === 'Button' ? [n] : []), ...buttons(n.props?.children)])
  const again = buttons(rows).find(b => b.props.label === 'y try again')
  expect(again).toBeTruthy()
  await again.props.onPress()
  expect(s.verbs()).toContain('redo 1')
  expect(s.spawns.length).toBe(3)
})

/** The message d puts in the prompt box for fix 1 as the tests make it fail: Cannot after a refused try. */
const ASK_CLAUDE = "My thimble fix 1, “make the bar say read”, did not pass: it needs the scan off. I asked: “make the bar's coverage item say read”. Its fixer, which works in a sandbox, tried this: The scan skips the notes you name. Its copy of thimble is /made-up/.thimble/fixes/work/1, and thimble fix diff 1 shows its change. Find why it failed, and make the change in that copy if you can. Then I type /thimble-fix 1 and what you changed, so that thimble tests it."

test("a failed fix's d asks Claude: what it tried shows in the line's place, and the prompt box takes the failure, for the person to send with ↵; no key sends anything, and the keys under it show only while the box is empty", async () => {
  const s = setup()
  s.fix.refuse = 'its tests failed in the sandbox'
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await s.end('Cannot: it needs the scan off', 'agent-fixer-2')
  const before = { commands: [...s.commands], sent: s.sent.length, spawns: s.spawns.length }
  await (await fixKey(s.$, 'd'))!.later()
  // the line's place: what it tried and why, with no key under it while the box holds the failure (a key typed there
  // goes into the message); the box: the failure in the person's words, as a message to Claude
  expect((await fixLineRows(s.$, ELS, 110)).map(textOf)).toEqual([
    '  make the bar say read',
    "    You asked   make the bar's coverage item say read",
    '    Claude did  The scan skips the notes you name.',
    '    Tried       plugin/bar/bar.tsx',
    '    Why         it needs the scan off',
  ])
  expect(s.fills).toEqual([{ text: ASK_CLAUDE, mode: 'replace' }])
  // nothing went to Claude or anywhere else: no command, no message, no fork
  expect(s.commands).toEqual(before.commands)
  expect(s.sent.length).toBe(before.sent)
  expect(s.spawns.length).toBe(before.spawns)
  // d asked Claude already: it is no key of the view it opened
  expect(await fixKey(s.$, 'd')).toBe(null)
  // the person clears the box (esc esc): the bar draws again, and the keys that act at an empty prompt show
  const drawn = s.redraws.length
  s.box.text = ''
  await s.call('prompt.change', { text: '', cursor: 0, origin: { kind: 'clear' } })
  expect(s.redraws.slice(drawn)).toEqual(['ui.render'])
  expect(textOf((await fixLineRows(s.$, ELS, 110)).at(-1))).toBe('    y try again · n dismiss')
  expect(s.fills.length).toBe(1)
  // the person types a word: the keys go again, and a key typed with nothing to draw anew asks for no drawing
  await s.call('prompt.edit', { origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'w' }, async () => ({ text: 'w', cursor: 1 }))
  expect(s.redraws.slice(drawn)).toEqual(['ui.render', 'ui.render'])
  s.box.text = 'w'
  expect(textOf((await fixLineRows(s.$, ELS, 110)).at(-1))).toBe('    Why         it needs the scan off')
  await s.call('prompt.edit', { origin: { kind: 'composer' }, text: 'w', cursor: 1, start: 1, end: 1, inputText: 'h' }, async () => ({ text: 'wh', cursor: 2 }))
  expect(s.redraws.slice(drawn).length).toBe(2)
  // the person sends their prompt: a prompt like any, and the line goes, as at any prompt
  await s.call('prompt.submit', { text: 'what does the scan keep private?', origin: { kind: 'composer' } })
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  // with no such view, the box's changes ask for no drawing
  await s.call('prompt.change', { text: '', cursor: 0, origin: { kind: 'clear' } })
  expect(s.redraws.slice(drawn).length).toBe(2)
  // a click on `d ask Claude` while the person has typed something: the failure goes after their words, on a line of
  // its own
  const u = setup()
  u.fix.refuse = 'its tests failed in the sandbox'
  await requested(u, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await u.end('Cannot: it needs the scan off', 'agent-fixer-2')
  u.box.text = 'and the legend'
  const buttons = (n: Any): Any[] => (n == null || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(buttons) : [...(n.type === 'Button' ? [n] : []), ...buttons(n.props?.children)])
  await buttons(await fixLineRows(u.$, ELS, 110)).find(b => b.props.label === 'd ask Claude').props.onPress()
  expect(u.fills.at(-1)).toEqual({ text: `\n${ASK_CLAUDE}`, mode: 'append' })
  expect(u.box.text).toBe(`and the legend\n${ASK_CLAUDE}`)
  expect(buttons(await fixLineRows(u.$, ELS, 110))).toEqual([])
  // the person sends it: the line goes
  await u.call('prompt.submit', { text: u.box.text, origin: { kind: 'composer' } })
  expect(await fixLineRows(u.$, ELS, 110)).toEqual([])
  // a blocked fix asks Claude the same way
  const t = setup()
  t.fix.refuse = WAY_BACK
  await requested(t, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await t.end('Cannot: the scan keeps your data private, so a fix may not change it', 'agent-fixer-2')
  await (await fixKey(t.$, 'd'))!.later()
  expect(String(t.fills[0]?.text)).toContain('did not pass: the scan keeps your data private, so a fix may not change it.')
})

test("at the prompt, d on a failed fix puts its failure in the box; y and n then type into it, as the view shows them not, and once the box is empty again they show, and y tries the fix again", async () => {
  const s = setup({ keys: true })
  s.fix.refuse = 'its tests failed in the sandbox'
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await s.end('Cannot: it needs the scan off', 'agent-fixer-2')
  // a key the person types: through the keys' hook and the fix module's, then into the box when no one takes it
  const typed = async (e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length })
  const press = async (k: string) => {
    const at = s.box.text.length
    const r = await s.call('prompt.edit', { origin: { kind: 'composer' }, key: { key: k }, text: s.box.text, cursor: at, start: at, end: at, inputText: k }, typed)
    s.box.text = r.text
    await s.tick()
  }
  expect(textOf((await fixLineRows(s.$, ELS, 110)).at(-1))).toBe('    y try again · d ask Claude · n dismiss')
  await press('d')
  expect(s.box.text).toBe(ASK_CLAUDE)
  expect(textOf((await fixLineRows(s.$, ELS, 110)).at(-1))).toBe('    Why         it needs the scan off')
  // the person adds to the message: their keys are words, and nothing is tried again or dismissed
  const verbs = s.verbs().length
  await press('y')
  await press('n')
  expect(s.box.text).toBe(`${ASK_CLAUDE}yn`)
  expect(s.verbs().slice(verbs).filter(v => /^(redo|notnow)\b/.test(v))).toEqual([])
  expect((await fixLineRows(s.$, ELS, 110)).map(textOf)).toContain('    Why         it needs the scan off')
  // they clear the box instead of sending it: the view's keys show, and y at the empty prompt tries the fix again
  s.box.text = ''
  await s.call('prompt.change', { text: '', cursor: 0, origin: { kind: 'clear' } })
  expect(textOf((await fixLineRows(s.$, ELS, 110)).at(-1))).toBe('    y try again · n dismiss')
  await press('y')
  expect(s.box.text).toBe('')
  expect(s.verbs().slice(verbs)).toContain('redo 1')
})

test("the failure Claude reads names the person's words of each round, what the fixer tried, where its change is, and how a change Claude makes there gets tested, in one paragraph", () => {
  const f = (o: Any) => ({ id: 4, title: 'Legend shows every row', words: ['the legend hides its last row'], rounds: 1, made_in: 'terminal', created: 0, state: 'failed', work: null, commit: 'c', files: [], tests: null, summary: '', error: 'its tests failed in the sandbox', ...o })
  // with no copy, there is nowhere for Claude's change: it says what to add with /thimble-fix 4
  expect(askClaudeText(f({}), null)).toBe('My thimble fix 4, “Legend shows every row”, did not pass: its tests failed in the sandbox. I asked: “the legend hides its last row”. Its fixer works in a sandbox. thimble fix diff 4 shows its change. Find why it failed, and tell me what to add with /thimble-fix 4.')
  // the rounds in turn, a summary of several lines and a reason that ends with its own stop, as one paragraph; Claude's
  // change goes in the copy, where /thimble-fix 4 <words> goes on (y, or the number alone, would start a new copy)
  const t = askClaudeText(f({ words: ['the legend hides its last row', 'and wrap long names'], summary: 'The legend wraps.\nNames break at 40 cells.', error: 'it needs a newer node.' }), '~/.thimble/fixes/work/4')
  expect(t).toBe('My thimble fix 4, “Legend shows every row”, did not pass: it needs a newer node. I asked: “the legend hides its last row · then and wrap long names”. Its fixer, which works in a sandbox, tried this: The legend wraps. Names break at 40 cells. Its copy of thimble is ~/.thimble/fixes/work/4, and thimble fix diff 4 shows its change. Find why it failed, and make the change in that copy if you can. Then I type /thimble-fix 4 and what you changed, so that thimble tests it.')
  expect(t).not.toContain('\n')
})

test("/thimble-fix with the number of a fix that failed or no longer fits, a new version that did not fit at y included, tries it again in a new copy, in the person's words of before, as y on its failed line does; another fix's number says how to ask", async () => {
  const s = setup()
  s.fix.refuse = 'its tests failed in the sandbox'
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await s.end('Cannot: it needs the scan off', 'agent-fixer-2')
  // the line went at the person's next prompt; the fix's number still tries it again, with no turn of Claude
  await s.call('prompt.submit', { text: 'Which runs failed?', origin: { kind: 'composer' } })
  const none = async () => { throw new Error('no command runs') }
  expect(await s.call('command.run', { command: 'thimble-fix', args: '1' }, none)).toEqual({})
  await s.tick()
  await until(() => s.spawns.length === 3)
  expect(s.verbs()).toContain('redo 1')
  expect(String(s.spawns[2].prompt)).toContain("The person asked for this change to their thimble:\n\nmake the bar's coverage item say read\n")
  expect(s.commands).toEqual([])
  expect(s.toasts).toContain('A fork of this session is fixing “make the bar say read” again, in a new copy.')
  // a fix that is on: its number alone says how to ask
  s.fix.state = 'on'
  expect(await s.call('command.run', { command: 'thimble-fix', args: '#1' }, none)).toEqual({ text: FIX_ALONE })
  // one that no longer fits (the kernel's line names /thimble-fix 1): the same as a failed one
  s.fix.state = 'redo'
  expect(await s.call('command.run', { command: 'thimble-fix', args: '1' }, none)).toEqual({})
  await s.tick()
  await until(() => s.spawns.length === 4)
  expect(s.verbs().filter(v => v === 'redo 1').length).toBe(2)
  // a changed fix whose new version did not fit at y: it still waits, its record says why, and the kernel's line names
  // /thimble-fix 1, which tries it again
  Object.assign(s.fix, { state: 'ready', prev: { state: 'on', commit: 'c0ffee0', title: 'make the bar say read' }, error: 'its new version does not fit fix 2' })
  expect(await s.call('command.run', { command: 'thimble-fix', args: '1' }, none)).toEqual({})
  await s.tick()
  await until(() => s.spawns.length === 5)
  expect(s.verbs().filter(v => v === 'redo 1').length).toBe(3)
  expect(s.toasts).toContain('A fork of this session is changing “make the bar say read” again, in a new copy.')
  // a new version that waits for y with nothing against it: its number alone says how to ask
  Object.assign(s.fix, { state: 'ready', error: null })
  expect(await s.call('command.run', { command: 'thimble-fix', args: '1' }, none)).toEqual({ text: FIX_ALONE })
  // a fix that cannot do without a file no fix may change: the kernel says why, on the line
  const t = setup()
  t.fix.refuse = WAY_BACK
  await requested(t, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await t.end('Cannot: it needs the scan off', 'agent-fixer-2')
  expect(await t.call('command.run', { command: 'thimble-fix', args: '1' }, none)).toEqual({})
  await t.tick()
  await until(async () => textOf(await fixLineRows(t.$, ELS, 110)).includes('could not start again'))
  expect(textOf(await fixLineRows(t.$, ELS, 110))).toContain('× “make the bar say read” could not start again: fix 1 needs a change to plugin/engine/kernel/privacy.py, which no fix may make')
  expect(t.spawns.length).toBe(2)
})

test('/thimble-fix alone says how to ask, in one line; it opens no pane and starts no turn', async () => {
  const s = setup()
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  const r = await s.call('command.run', { command: 'thimble-fix', args: '' }, async () => { throw new Error('/thimble-fix alone answers at once') })
  expect(r.text).toBe('Ask for a change to thimble with /thimble-fix <what should work differently>.')
  expect(s.opened).toEqual([])
  expect(s.commands).toEqual([])
})

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

test("where skill.prompt passes over thimble (an organization's security plugin), the Skill call still starts the fix, once; skill.prompt alone starts it too", async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  // the person's words, as typed after /thimble-fix, with an arrow and a question mark
  const words = 'Cards should open a side thread on click -> hover feedback on a bar, then a thread. Can you do that?'
  await s.call('command.run', { command: 'thimble-fix', args: words }, async () => ({}))
  await s.tick()
  const r = skillText(await skillCall(s, 'new'))
  expect(r.text).toContain('thimble started a fork of this conversation')
  expect(s.ran.filter(x => x.argv.includes('new')).map(x => x.stdin)).toEqual([words])
  expect(s.spawns.length).toBe(1)
  // the skill did not run, so no skill.prompt follows; one that comes some other way (a preload) is its own request,
  // in the person's words of their next /thimble-fix
  await s.call('command.run', { command: 'thimble-fix', args: "new the bar's label is cut" }, async () => ({}))
  await s.tick()
  const pre = await s.call('skill.prompt', { skill: 'thimble:fix-thimble', text: `The fix the person's words change: new\n\nthimble starts…`, frontmatter: {}, source: 'plugin' }, async (e: Any) => ({ text: e.text }))
  expect(String(pre.text)).toContain('thimble started a fork of this conversation')
  expect(s.ran.filter(x => x.argv.includes('new')).map(x => x.stdin)).toEqual([words, "the bar's label is cut"])
  // another skill's call is left alone
  expect(await s.call('tool.call', { tool: 'Skill', tool_use_id: 'tu-o', skill: 'made-up:other', args: 'x' }, async () => ({ result: 'ran' }))).toEqual({ result: 'ran' })
})

test("a fix-thimble hook that fails tells Claude why, never that thimble's hooks did not run", async () => {
  expect(notStarted({ kind: 'throw', message: 'thimble fix new: no such file' })).toBe('thimble started no fix: its fix-thimble hook failed: thimble fix new: no such file. Tell the person in one short line, with that reason.')
  expect(notStarted({ kind: 'timeout' })).toContain('its fix-thimble hook failed: it took too long.')
  // the handlers the module gives Claude Code for the Skill call and skill.prompt
  const caught: Record<string, Any> = {}
  registerFix(((event: string, a: Any, b?: Any) => {
    const reg: Any = { catch: (h: Any) => { if (event === 'tool.call' && a?.tool === 'Skill') caught.call = h; if (event === 'skill.prompt') caught.prompt = h; return reg } }
    return reg
  }) as Any)
  const next = Object.assign(async () => { throw new Error('nothing beneath runs') }, { called: false, error: { kind: 'throw', message: 'made-up failure', budget: 1000 } })
  expect(await caught.call({}, { tool: 'Skill', skill: 'thimble:fix-thimble', args: 'x' }, next)).toEqual({ deny: notStarted(next.error) })
  expect(await caught.prompt({}, { skill: 'thimble:fix-thimble', text: 'x' }, next)).toEqual({ text: notStarted(next.error) })
  expect(String((await caught.call({}, {}, next)).deny)).toContain('made-up failure')
})

test('/thimble-fix alone and /thimble-fix update answer at once, with no turn of Claude; words go to Claude as the prompt command, and the fix takes them as the person typed them', async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const none = async () => { throw new Error('no command runs') }
  expect(await s.call('command.run', { command: 'thimble-fix', args: '' }, none)).toEqual({ text: FIX_ALONE })
  expect(s.opened.length).toBe(0)
  expect(String((await s.call('command.run', { command: 'thimble-fix', args: 'update' }, none)).text)).toContain('thimble update')
  await s.tick()
  expect(s.commands).toEqual([])
  // words: the prompt command runs with them, the same as /thimble:thimble-fix typed in full
  const runs: Any[] = []
  s.$.command.run = async (c: Any) => { runs.push(c); return {} }
  await s.call('command.run', { command: 'thimble-fix', args: 'the bar is cut' })
  await s.tick()
  expect(runs).toEqual([{ command: 'thimble:thimble-fix', args: 'the bar is cut' }])
  const passed = await s.call('command.run', { command: 'thimble:thimble-fix', args: 'the bar is cut' }, async (e: Any) => ({ ran: e.args }))
  expect(passed).toEqual({ ran: 'the bar is cut' })
  expect(s.spawns).toEqual([])
  // the prompt command stays out of the menu, so the person sees one /thimble-fix
  expect((await s.call('command.describe', { command: 'thimble:thimble-fix', description: 'd', isHidden: false, immediate: false }, async (e: Any) => ({ description: e.description, isHidden: e.isHidden }))).isHidden).toBe(true)
  // Claude's skill after it: the fixer and the kernel get the words the person typed, never Claude's, and Claude is not
  // told of the fix again
  await skillCall(s, "new The bar's coverage item is cut at narrow widths")
  expect(String(s.spawns[0].prompt)).toContain('The person asked for this change to their thimble:\n\nthe bar is cut\n')
  expect(String(s.spawns[0].prompt)).not.toContain('narrow widths')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe('the bar is cut')
  expect(((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).toEqual({})
  // after two of main's turns (Claude's question, and its answer), their words are no longer a request: a skill call
  // starts nothing
  await s.call('command.run', { command: 'thimble-fix', args: 'the pane' })
  for (const turnId of ['t-1', 't-2']) await s.call('turn.complete', { turnId, reason: 'answer', answer: 'ok', durationMs: 9, isAborted: false }, async () => ({}))
  await s.end('Title: Bar coverage bold\nWhat it does: The coverage item is bold.')
  expect(skillText(await skillCall(s, "new the pane's title is cut")).text).toBe(NOT_ASKED)
  expect(s.spawns.length).toBe(1)
})

/** A turn of main's that ended with `text` as its answer, as core/answers.ts keeps it. */
async function answered(s: ReturnType<typeof setup>, turnId: string, text: string): Promise<void> {
  const row = `row-${turnId}`
  const ids = ((await s.$.state.get({ plugin: 'thimble', key: 'answerTurns' })).value ?? []) as string[]
  await s.$.state.set({ plugin: 'thimble', key: 'answerTurns' }, [...ids, turnId])
  await s.$.state.set({ plugin: 'thimble', key: 'answerTurn', id: turnId }, { turnId, n: ids.length + 1, prompt: { text: 'q', by: 'composer', row: null }, rows: [row], answer: row, reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: [], seq: 0 })
  await s.$.state.set({ plugin: 'thimble', key: 'answerMsg', id: row }, { row, turnId, text, at: 1 })
}

test("/thimble-fix alone, also right after Claude asked whether to start a fix, says how to ask in one line and starts nothing; so does a number or new with no words after it", async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const runs: Any[] = []
  s.$.command.run = async (c: Any) => { runs.push(c); return {} }
  const none = async () => { throw new Error('no command runs') }
  const alone = async (args = '', command = 'thimble-fix') => s.call('command.run', { command, args }, none)
  // Claude's answer asks whether to start a fix: /thimble-fix alone is no yes to it
  await answered(s, 't-1', "The card's legend hides its last row, which is thimble's drawing, not your data. Want me to start a fix?")
  expect(await alone()).toEqual({ text: FIX_ALONE })
  expect(await alone('', 'thimble:thimble-fix')).toEqual({ text: FIX_ALONE })
  // a fix's number, or new, with no words after it: nothing says what should change
  for (const args of ['1', '#2', '3:', 'new', 'NEW:']) expect(await alone(args)).toEqual({ text: FIX_ALONE })
  await s.tick()
  expect(runs).toEqual([])
  expect(s.spawns).toEqual([])
  expect(s.verbs().filter(v => /^(new|round|redo|again)\b/.test(v))).toEqual([])
})

test("the fixer reads the person's own words, not Claude's restatement of them, at its start and in a round while it works", async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const mine = 'the coverage thing in the bar should just say read'
  expect(await s.call('command.run', { command: 'thimble-fix', args: mine }, async () => ({}))).toEqual({})
  await s.tick()
  await skillCall(s, "Change the bar's coverage item label from coverage to read")
  const first = String(s.spawns[0].prompt)
  expect(first).toContain(`The person asked for this change to their thimble:\n\n${mine}\n`)
  expect(first).not.toContain("Change the bar's coverage item label")
  // more words while the fixer works: the person's own reach it
  const more = 'and keep the percent'
  expect(await s.call('command.run', { command: 'thimble-fix', args: more }, async () => ({}))).toEqual({})
  await s.tick()
  await skillCall(s, 'Also keep the percentage value shown after the word')
  expect(s.sent).toEqual([{ to: { agentId: 'agent-fixer-1' }, text: `The person adds to this fix (round 2): ${more}` }])
})

test("the fixer reads the person's words without the form's head that names the fix, `new …` or `1 …`; `1` alone adds no words; a record kept with the head reads the same", async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  // new …: a new fix, whose fixer and the kernel get the words after `new`
  expect(await s.call('command.run', { command: 'thimble-fix', args: "new the pane's title is cut" }, async () => ({}))).toEqual({})
  await s.tick()
  await skillCall(s, "new The pane's title is cut off at narrow widths")
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("the pane's title is cut")
  expect(String(s.spawns[0].prompt)).toContain("The person asked for this change to their thimble:\n\nthe pane's title is cut\n")
  // 1 …, while fix 1's fixer works: the words after the number reach it
  expect(await s.call('command.run', { command: 'thimble-fix', args: '1 also keep the percent' }, async () => ({}))).toEqual({})
  await s.tick()
  await skillCall(s, '1 Also keep the percentage value shown after the title')
  expect(s.sent.at(-1)).toEqual({ to: { agentId: 'agent-fixer-1' }, text: 'The person adds to this fix (round 2): also keep the percent' })
  expect(s.ran.filter(x => x.argv.includes('round')).at(-1)?.stdin).toBe('also keep the percent')
  // 1 alone: no words of the person's, so nothing reaches the fixer or Claude
  expect(await s.call('command.run', { command: 'thimble-fix', args: '1' }, async () => { throw new Error('no command runs') })).toEqual({ text: FIX_ALONE })
  await s.tick()
  expect(s.sent.length).toBe(1)
  expect(s.ran.filter(x => x.argv.includes('round')).length).toBe(1)
  // a record kept with the head (as thimble kept the person's words before): y on its failed line starts a fixer that
  // reads the words after it
  const t = setup()
  t.fix.refuse = 'its tests failed in the sandbox'
  await requested(t, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await t.end('Cannot: it needs the scan off', 'agent-fixer-2')
  t.fix.asked = ['1 make the bar say read']
  await (await fixKey(t.$, 'y'))!.later()
  const redone = String(t.spawns.at(-1).prompt)
  expect(redone).toContain('The person asked for this change to their thimble:\n\nmake the bar say read\n')
  expect(redone).not.toContain('1 make the bar say read')
})

test('at session start one line says a newer release is out, once a session; /thimble-fix update says to run thimble update in a shell', async () => {
  const s = setup()
  s.fix.state = 'on'
  s.made()
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(s.verbs()).toContain('update --check --once --json')
  expect(s.verbs()).not.toContain('update --json')
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain('↑ thimble 0.10.3 is out (you have 0.10.2) · in a shell: thimble update')
  expect(s.commands).toEqual([])
  // the reload starts the module again: no second look in this session
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(s.verbs().filter(v => v === 'update --check --once --json').length).toBe(1)
  await s.call('prompt.submit', { text: 'Which runs failed?', origin: { kind: 'composer' } })
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  // /thimble-fix update: the session does not move thimble under itself; the reply names the shell's commands
  const r = await s.call('command.run', { command: 'thimble-fix', args: 'update' })
  await s.tick()
  expect(s.verbs()).not.toContain('update --json')
  expect(String(r.text)).toContain('In a terminal, run thimble update')
  expect(String(r.text)).toContain('thimble reapply')
  expect(s.commands).toEqual([])
})

test("on a dev install the line names the checkout's new commit, once for that commit", async () => {
  const line = 'Your checkout is at next at abc1234, and thimble runs 99b439d · in a shell: thimble update'
  const s = setup()
  s.fix.state = 'on'
  s.made()
  s.fix.check = { dev: true, from: '99b439d', to: 'next at abc1234', newer: true, say: true, line }
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain(`↑ ${line}`)
  // the next session: the kernel already said this commit (say: false), so no line
  const t = setup()
  t.fix.state = 'on'
  t.made()
  t.fix.check = { dev: true, from: '99b439d', to: 'next at abc1234', newer: true, say: false, line }
  await t.call('session.start', { cwd: '/made-up/data' })
  await t.tick()
  expect(t.verbs()).toContain('update --check --once --json')
  expect(await fixLineRows(t.$, ELS, 110)).toEqual([])
})

test("the session opened in live edits live's code, and its thimble update --continue reloads at the end of the turn; other sessions may not", async () => {
  const ran = async (e: Any) => ({ result: { ran: e.command ?? e.file_path ?? '' } })
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  expect(String((await s.call('tool.call', { tool: 'Edit', tool_use_id: 'tu-l1', file_path: `${HOME}/fixes/live/plugin/bar/bar.tsx` }, ran)).deny)).toContain('thimble alone')
  const t = setup()
  t.where.root = `${HOME}/fixes/live`
  await t.call('session.start', { cwd: t.where.root })
  expect((await t.call('tool.call', { tool: 'Edit', tool_use_id: 'tu-l2', file_path: `${HOME}/fixes/live/plugin/bar/bar.tsx` }, ran)).result.ran).toBe(`${HOME}/fixes/live/plugin/bar/bar.tsx`)
  // never the records or the key presses, also by way of ..
  expect(String((await t.call('tool.call', { tool: 'Write', tool_use_id: 'tu-l3', file_path: `${HOME}/fixes/live/../asks/1.json` }, ran)).deny)).toContain('thimble alone')
  expect(String((await t.call('tool.call', { tool: 'Write', tool_use_id: 'tu-l4', file_path: `${HOME}/fixes/fixes.jsonl` }, ran)).deny)).toContain('thimble alone')
  expect(String((await t.call('tool.call', { tool: 'Write', tool_use_id: 'tu-l5', file_path: `${HOME}/fixes/work/../asks/1.json` }, ran)).deny)).toContain('thimble alone')
  // Claude's thimble update --continue: the plugins load again when its turn ends
  await t.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-l6', command: 'thimble update --continue' }, ran)
  expect(t.commands).toEqual([])
  await t.call('turn.complete', { turnId: 't-1', reason: 'answer', answer: 'Done.', durationMs: 9, isAborted: false }, async () => ({}))
  await t.tick()
  expect(t.commands).toEqual(['reload-plugins'])
})

test('the text copy of a drawing: a row side by side, a column one under another, a button by its words', () => {
  const { Box, Text, Button, Markdown } = TEXT_ELS as Any
  const drawn = Box({ flexDirection: 'column', children: [
    Box({ children: [Text({ children: 'thimble' }), Text({ children: '  ' }), Button({ label: 'r coverage 43%', children: [Text({ children: 'r' }), Text({ children: ' coverage 43%' })] })] }),
    Markdown({ text: 'a **link**' }),
  ] })
  expect(screenText(drawn)).toBe('thimble  r coverage 43%\na **link**')
})

test('the live sequence: apply a fix, follow up on it, and the follow-up is a round of that fix in place; y puts the new version on, u brings back the one before', async () => {
  const s = setup()
  await requested(s)
  await (await fixKey(s.$, 'y'))!.later()
  expect(s.verbs()).toContain('apply 1 --ask -')
  // /thimble-fix: Claude reads the person's fixes beside the command, by name and state, the number as the handle
  const ran = await s.call('command.run', { command: 'thimble:thimble-fix', args: 'it breaks when I click' }, async () => ({}))
  expect(ran.context).toEqual(["The person's thimble fixes (start the fix-thimble skill with `N` to change fix N, `new` for a new fix):\n1  \"Bar says read for coverage\" (on): The bar says r read 14%."])
  // Claude gives `1 <words>`: a round of fix 1 itself, never a new fix
  const r = await ask(s, '1 it breaks when I click')
  expect(s.verbs().filter(v => v.startsWith('new'))).toEqual(['new --made-in terminal'])
  expect(s.verbs()).toContain('round 1')
  expect(s.ran.find(x => x.argv.includes('round'))?.stdin).toBe('it breaks when I click')
  expect(String(r.text)).toBe('thimble started a fork of this conversation that changes the person\'s fix "Bar says read for coverage" in the background, in a copy; the version they have stays until they press y. The person sees "changing Bar says read for coverage" on the bar while it works, and decides with a key whether to use the changed fix. Tell the person in one short line, then go on with their request. thimble tells you when it ends.')
  expect(busySteps()).toContain('changing Bar says read for coverage')
  expect(s.spawns[1]).toMatchObject({ name: 'fix-bar-says-read-coverage', cwd: WORK })
  const first = String(s.spawns[1].prompt)
  expect(first).toContain("Round 1: make the bar's coverage item say read\nRound 2: it breaks when I click")
  expect(first).toContain('These words change the fix the person already has on, "Bar says read for coverage" (The bar says r read 14%.); its change is in your copy, and your change becomes part of it.')
  // its end: the fix's own line, its name kept, the version on stays until y
  await s.end('Title: Clicking read works\nWhat it does: The read item works when clicked.', 'agent-fixer-2')
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  ✓ thimble changed: Bar says read for coverage · tests pass')
  expect(textOf(rows[1])).toBe('    y use it now · d what changed · n later')
  expect(s.notes.at(-1)).toEqual({ text: 'thimble changed: Bar says read for coverage · tests pass', title: 'thimble' })
  await (await fixKey(s.$, 'y'))!.later()
  expect(s.verbs().filter(v => v.startsWith('apply'))).toEqual(['apply 1 --ask -', 'apply 1 --ask -'])
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(s.fix.state).toBe('on')
})

test('words about something else are a new fix; a follow-up round that changes no code leaves the fix as it was', async () => {
  const s = setup()
  await requested(s)
  await (await fixKey(s.$, 'y'))!.later()
  await ask(s, 'new a pane for labels')
  expect(s.verbs().filter(v => v.startsWith('new'))).toEqual(['new --made-in terminal', 'new --made-in terminal'])
  expect(s.ran.filter(x => x.argv.includes('new')).at(-1)?.stdin).toBe('a pane for labels')
  expect(s.verbs().some(v => v.startsWith('round'))).toBe(false)

  const t = setup()
  await requested(t)
  await (await fixKey(t.$, 'y'))!.later()
  await ask(t, '1 what does the item say?')
  await t.end('Title: Bar says read\nRequest: It already says read.', 'agent-fixer-2')
  expect(textOf(await fixLineRows(t.$, ELS, 110))).toContain('◇ Claude changed no code: Bar says read for coverage stays as it was')
  expect(t.fix.state).toBe('on')
})

test("the fixes Claude reads, the bar's words and the subagent's name use the fix's name, not its number", () => {
  const f = (o: Any) => ({ id: 2, title: 'Click any card element to ask about it', words: [], rounds: 1, made_in: 'terminal', created: 0, state: 'on', work: null, commit: 'c', files: [], tests: null, summary: '', error: null, ...o })
  expect(fixSlug(f({}))).toBe('fix-click-any-card-element-ask')
  expect(fixSlug(f({ title: '!!' }))).toBe('fix-2')
  expect(fixingWord(f({ state: 'working' }))).toBe('fixing Click any card element to a…')
  expect(fixingWord(f({ state: 'working', prev: { state: 'on' } }))).toBe('changing Click any card element to a…')
  expect(fixesContext([f({ state: 'working', prev: { state: 'on' } }), f({ id: 3, title: 'Bar says read', state: 'off' }), f({ id: 4, state: 'removed' })])).toBe(
    "The person's thimble fixes (start the fix-thimble skill with `N` to change fix N, `new` for a new fix):\n2  \"Click any card element to ask about it\" (on, being changed (working))\n3  \"Bar says read\" (off)")
  expect(fixesContext([])).toBe('')
})

test("the fix takes the person's own words, never Claude's, and the fix they name comes first: `N: …` or `new: …` is the form they or Claude meant", async () => {
  const f = (o: Any) => ({ id: 2, title: 'Bar says read', words: [], rounds: 1, made_in: 'terminal', created: 0, state: 'on', work: null, commit: 'c', files: [], tests: null, summary: '', error: null, ...o })
  expect(formOf('2: it breaks when I click', [f({})])).toEqual({ words: 'it breaks when I click', target: 2, fresh: false })
  expect(formOf('#2 - it breaks', [f({})])).toEqual({ words: 'it breaks', target: 2, fresh: false })
  expect(formOf('new: Add a way to pick the model', [f({})])).toEqual({ words: 'Add a way to pick the model', target: null, fresh: true })
  expect(formOf('new-style labels should wrap', [])).toEqual({ words: 'new-style labels should wrap', target: null, fresh: false })
  expect(formOf('3: no such fix', [f({})])).toEqual({ words: '3: no such fix', target: null, fresh: false })
  // the fix the words change: the person's own head first, else Claude's form, with or without words after it
  expect(namedFix('2 it breaks', 'new', [f({})])).toEqual({ target: 2, fresh: false })
  expect(namedFix('new a pane for labels', '2', [f({})])).toEqual({ target: null, fresh: true })
  expect(namedFix('it breaks when I click', '2', [f({})])).toEqual({ target: 2, fresh: false })
  expect(namedFix('it breaks when I click', '#2: it breaks on click', [f({})])).toEqual({ target: 2, fresh: false })
  expect(namedFix('a pane for labels', 'new: A labels pane', [f({})])).toEqual({ target: null, fresh: true })
  expect(namedFix('it breaks', '3', [f({})])).toEqual({ target: null, fresh: false })
  expect(namedFix('it breaks', '', [f({})])).toEqual({ target: null, fresh: false })
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const mine = 'add a feature to customize the model in charge of citations'
  expect(await s.call('command.run', { command: 'thimble-fix', args: mine }, async () => ({}))).toEqual({})
  await s.tick()
  await skillCall(s, 'new: Add a way for the analyst to choose the model that checks citations')
  const made = s.ran.find(x => x.argv.includes('new'))!
  expect(made.stdin).toBe(mine)
  expect(made.argv.some(a => a.startsWith('--asked'))).toBe(false)
  // d shows their words
  await s.end('Title: Citations model setting\nWhat it does: The settings pane picks the model that checks citations.')
  await (await fixKey(s.$, 'd'))!.later()
  expect((await fixLineRows(s.$, ELS, 160)).map(textOf)).toContain(`    You asked   ${mine}`)
})
