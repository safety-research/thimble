// thimble fix in the hooks module (fix/), on a plain engine whose kernel is faked (the kernel's own tests are
// test_fixes.py): /thimble-fix, or Claude's fix-thimble skill, starts the fixer as a fork of the session in its copy,
// with a text copy of what thimble shows; more words while it works go to the same fixer; Claude can neither apply nor
// send a fix, the fixer included; the fixer's end puts the fix's line above the bar and sends a notification; d shows
// what changed; y applies it with a secret only that press holds and reloads the plugins (at the turn's end when Claude
// is mid-reply; a --plugin-dir session is told to restart); u undoes it; n leaves it ready in the list; /thimble-fix
// alone says that fixes are listed and managed in a shell. The fixer's shell runs in the sandbox the kernel describes, with a time limit, and its writes
// stay in its copy. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { busySteps } from '../bar/busy'
import { fixSlug, fixingWord } from '../fix/fixes'
import { fixKey, fixLineRows } from '../fix/line'
import { notStarted, registerFix, wordsOfSkill } from '../fix/register'
import { fixesContext } from '../fix/request'
import { textOf as screenText, TEXT_ELS } from '../fix/screen'
import { promptStub } from './stubs'

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

/** The fix module's hooks on an engine that keeps state, files and timers in memory, with a faked kernel. */
function setup() {
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
  const ran: { argv: string[]; stdin?: string }[] = []
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
      return ok(fix)
    }
    // the check refused the change: another round in the same copy; the test's refusal was for the first round only
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
      Object.assign(fix, { state: argv.includes('--request') ? 'request' : 'ready', title: t > 0 && !fix.prev ? argv[t + 1] : fix.title, summary: stdin, commit: 'c0ffee1', tests: 'passed', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }] })
      // the kernel's check after the fixer's end refused it (fix.refuse is the reason a test gives); a refusal for
      // safety files is kept on the record (refused) until the next check
      if (argv.includes('--cannot')) { Object.assign(fix, { state: 'failed', tests: null, error: stdin, refused: null }); return ok(fix) }
      if (fix.refuse) Object.assign(fix, { state: 'failed', tests: null, error: fix.refuse, refused: /safety files/.test(fix.refuse) ? { why: fix.refuse, files: ['plugin/engine/kernel/privacy.py'] } : { why: fix.refuse, files: [], tests: 'FAIL made-up test' } })
      else fix.refused = null
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
    if (verb === 'redo') { Object.assign(fix, { state: 'working', refuse: null }); return ok(fix) }
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
    process: { run: async (argv: string[], o: Any = {}) => { ran.push({ argv, ...(o.stdin != null ? { stdin: o.stdin } : {}) }); return argv.includes('fix') ? kernel(argv, o.stdin) : { exitCode: 0, stdout: '', stderr: '' } } },
    command: { run: async (c: Any) => { commands.push(c.command); return {} }, register: async () => ({ command: 'thimble-fix' }) },
    model: { complete: async (req: Any) => { asked.push(req); return { isAnswered: true, text: JSON.stringify({ title: 'Bar says coverage, not read', wrong: 'The bar said coverage after Claude read a file.', fixed: 'The bar says read.' }) } } },
    ui: { copy: async (o: Any) => { copied.push(o.text); return { isCopied: true } }, toast: (t: string) => { toasts.push(t) }, notify: async (text: string, o: Any = {}) => { notes.push({ text, title: o.title }); return { isSent: true } }, log: () => undefined, open: async (o: Any) => { opened.push(o.id); return { isPlaced: true } }, panes: async () => opened.map(id => ({ id })), close: async () => ({}), invalidate: () => undefined },
  }
  /** An event through the module's hooks that admit it, in order, then `base`. */
  const call = (event: string, e: Any, base: (e: Any) => Any = async x => x) => {
    const chain = (hooks[event] ?? []).filter(h => admits(h.m, e))
    const run = (i: number, ev: Any): Any => (i < chain.length ? chain[i]!.fn($, ev, Object.assign((x: Any) => run(i + 1, x), { called: false, origin: { plugin: 'thimble' } })) : base(ev))
    return run(0, e)
  }
  /** The timers that came due, run (each may add more). */
  const tick = async () => {
    for (let n = 0; n < 5 && timers.length; n++) for (const fn of timers.splice(0)) await fn()
    await new Promise(r => setTimeout(r, 5))
  }
  // the session the plugin names on new, round, redo and done is left out: one test looks at it
  const verbs = () => ran.map(r => r.argv.slice(r.argv.indexOf('fix') + 1).join(' ').replace(/ --session \S+/, '')).filter(Boolean)
  /** The fixer's end: its agent idles, and its turn's end reaches the hooks. */
  const end = async (answer: string, agentId = 'agent-fixer-1') => {
    for (const a of agents) if (a.id === agentId) a.status = 'idle'
    await call('turn.complete', { turnId: 't-f', agentId, reason: 'answer', answer, durationMs: 9, isAborted: false }, async () => ({}))
    await tick()
  }
  return { $, call, tick, end, made: () => { made = true }, others, ran, spawns, commands, files, fix, opened, toasts, notes, sent, agents, config, state, verbs, copied, asked, where }
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

test('a refused change goes back to a new fixer in the same copy, told what was refused and why; its next round passes, and the person sees no failure', async () => {
  const s = setup()
  const why = 'it changes plugin/engine/kernel/privacy.py (the privacy scan); thimble does not apply changes to its safety files'
  s.fix.refuse = why
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  expect(s.verbs()).toContain('again 1')
  expect(s.spawns.length).toBe(2)
  const second = String(s.spawns[1].prompt)
  expect(second).toContain(`thimble did not use the last change for this fix: ${why}. Your last change is in your copy. Leave plugin/engine/kernel/privacy.py as it is and make the change in other files. When the request truly cannot be met without that, end with one line \`Cannot: <why, in plain words for the person>\` in place of the Title line; thimble shows that line to the person.`)
  expect(String(s.spawns[0].prompt)).not.toContain('did not use the last change')
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

test('a fixer that finds the request cannot be met ends with Cannot: the line shows its words, long on a row of its own, short after the title; d shows what changed, r redoes', async () => {
  const s = setup()
  const why = 'The scan is part of what keeps your data private, and a fix may not change it, so notes cannot skip it.'
  s.fix.refuse = 'it changes plugin/engine/kernel/privacy.py (the privacy scan); thimble does not apply changes to its safety files'
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await s.end(`I could not do this.\n\nCannot: ${why}`, 'agent-fixer-2')
  expect(s.ran.find(x => x.argv.includes('--cannot'))?.stdin).toBe(why)
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows)).toContain('× Skip the scan for my notes did not pass')
  expect(rows.map((r: Any) => r.props.key)).toEqual(['fix-line-1', 'fix-line-why', 'fix-line-2'])
  expect(textOf(rows[1])).toBe(`    ${why}`)
  expect(textOf(rows[2])).toBe('    d what changed · r redo · n later')
  expect(s.notes).toEqual([])
  await (await fixKey(s.$, 'd'))!.later()
  rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows.at(-2))).toBe(`    Changed     1 file · ${why}`)
  expect(textOf(rows.at(-1))).toBe('    r redo · n later')
  // r, the person's own: a new fixer, told where the earlier change is
  await (await fixKey(s.$, 'r'))!.later()
  expect(s.spawns.length).toBe(3)
  expect(String(s.spawns[2].prompt)).toContain(`is in ${HOME}/fixes/tmp/1/earlier.patch;`)
  const t = setup()
  t.fix.refuse = 'its tests failed in the sandbox'
  await requested(t, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  await t.end('Cannot: it needs the scan off', 'agent-fixer-2')
  rows = await fixLineRows(t.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  × Skip the scan for my notes did not pass · it needs the scan off')
  expect(rows.map((r: Any) => r.props.key)).not.toContain('fix-line-why')
})

test('/thimble-fix alone says how to ask and that fixes are listed and managed in a shell; it opens no pane and starts no turn', async () => {
  const s = setup()
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  const r = await s.call('command.run', { command: 'thimble-fix', args: '' }, async () => { throw new Error('/thimble-fix alone answers at once') })
  expect(r.text).toBe('Ask for a change to thimble with /thimble-fix <what should work differently>.\nYour fixes are listed and managed in a shell: thimble fix list (thimble fix --help shows the rest).')
  expect(s.opened).toEqual([])
  expect(s.commands).toEqual([])
})

test("Claude starts a fix with the fix-thimble skill: the same fork starts, Claude reads what came of it, and is told when it ends", async () => {
  expect(wordsOfSkill("What thimble does wrong, and what it should do: the explainer's links show as raw text\n\nthimble starts its fix…")).toBe("the explainer's links show as raw text")
  expect(wordsOfSkill('What thimble does wrong, and what it should do: \n\nthimble starts its fix…')).toBe('')
  expect(wordsOfSkill('What thimble does wrong, and what it should do: $ARGUMENTS\n\nthimble starts…\n\nARGUMENTS: the bar is cut')).toBe('the bar is cut')
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = skillText(await skillCall(s, "the card's legend hides its last row", 'fix-thimble'))
  expect(r.result).toEqual({ success: true, commandName: 'fix-thimble' })
  expect(String(r.text)).toBe('thimble started a fork of this conversation that fixes thimble in the background, in a copy ("make the bar say read"). The person sees "fixing make the bar say read" on the bar while it works, and decides with a key whether to use the fix. Tell the person in one short line, then go on with their request. thimble tells you when the fix ends.')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("the card's legend hides its last row")
  expect(String(s.spawns[0].prompt)).toContain("Claude, in the conversation above, saw thimble misbehave and asked for this change to the person's thimble:")
  // no words: nothing starts, and Claude reads why
  const none = skillText(await skillCall(s, ' '))
  expect(String(none.text)).toContain('thimble started no fix')
  expect(s.spawns.length).toBe(1)
  // its end: the line and the notification, and Claude is told, so that it can tell the person
  await s.end('Title: Legend shows every row\nWhat it does: The legend wraps.')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Legend shows every row · tests pass')
  const told = ((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['fix-1']).toBe('The thimble fix you started, "Legend shows every row", is ready and tests pass; the person turns it on with y. Tell the person in one short line.')
})

test("where skill.prompt passes over thimble (an organization's security plugin), the Skill call still starts the fix, once; skill.prompt alone starts it too", async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  // the person's words, as typed after /thimble:thimble-fix, with an arrow and a question mark
  const words = 'Cards should open a side thread on click -> hover feedback on a bar, then a thread. Can you do that?'
  const r = skillText(await skillCall(s, words))
  expect(r.text).toContain('thimble started a fork of this conversation')
  expect(s.ran.filter(x => x.argv.includes('new')).map(x => x.stdin)).toEqual([words])
  expect(s.spawns.length).toBe(1)
  // the skill did not run, so no skill.prompt follows; one that comes some other way (a preload) is its own request
  const pre = await s.call('skill.prompt', { skill: 'thimble:fix-thimble', text: `What thimble does wrong, and what it should do: new the bar's label is cut\n\nthimble starts…`, frontmatter: {}, source: 'plugin' }, async (e: Any) => ({ text: e.text }))
  expect(String(pre.text)).toContain('thimble started a fork of this conversation')
  expect(s.ran.filter(x => x.argv.includes('new')).length).toBe(2)
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

test('/thimble-fix alone and /thimble-fix update answer at once, with no turn of Claude; words go to Claude as the prompt command, with the fix the person\'s', async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const none = async () => { throw new Error('no command runs') }
  expect(String((await s.call('command.run', { command: 'thimble-fix', args: '' }, none)).text)).toContain('thimble fix list')
  expect(s.opened.length).toBe(0)
  expect(String((await s.call('command.run', { command: 'thimble-fix', args: 'update' }, none)).text)).toContain('thimble update')
  await s.tick()
  expect(s.commands).toEqual([])
  // words: the prompt command runs with them, the same as /thimble:thimble-fix typed in full
  const runs: Any[] = []
  s.$.command.run = async (c: Any) => { runs.push(c); return {} }
  await s.call('command.run', { command: 'thimble-fix', args: '2' })
  await s.tick()
  expect(runs).toEqual([{ command: 'thimble:thimble-fix', args: '2' }])
  const passed = await s.call('command.run', { command: 'thimble:thimble-fix', args: '2' }, async (e: Any) => ({ ran: e.args }))
  expect(passed).toEqual({ ran: '2' })
  expect(s.spawns).toEqual([])
  // the prompt command stays out of the menu, so the person sees one /thimble-fix
  expect((await s.call('command.describe', { command: 'thimble:thimble-fix', description: 'd', isHidden: false, immediate: false }, async (e: Any) => ({ description: e.description, isHidden: e.isHidden }))).isHidden).toBe(true)
  // Claude's skill after it: the fixer reads the words as the person's, and Claude is not told of it again
  await skillCall(s, "2 make the bar's coverage item bold")
  expect(String(s.spawns[0].prompt)).toContain('The person asked for this change to their thimble:')
  expect(((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).toEqual({})
  // after two of main's turns (Claude's question, and its answer), a skill call is Claude's own again
  await s.call('command.run', { command: 'thimble-fix', args: 'the bar' })
  for (const turnId of ['t-1', 't-2']) await s.call('turn.complete', { turnId, reason: 'answer', answer: 'ok', durationMs: 9, isAborted: false }, async () => ({}))
  await s.end('Title: Bar coverage bold\nWhat it does: The coverage item is bold.')
  await skillCall(s, "new the pane's title is cut")
  expect(String(s.spawns.at(-1).prompt)).toContain('Claude, in the conversation above, saw thimble misbehave')
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
  expect(ran.context).toEqual(["The person's thimble fixes (start the fix-thimble skill with `N <words>` to change fix N, `new <words>` for a new fix):\n1  \"Bar says read for coverage\" (on): The bar says r read 14%."])
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
    "The person's thimble fixes (start the fix-thimble skill with `N <words>` to change fix N, `new <words>` for a new fix):\n2  \"Click any card element to ask about it\" (on, being changed (working))\n3  \"Bar says read\" (off)")
  expect(fixesContext([])).toBe('')
})
