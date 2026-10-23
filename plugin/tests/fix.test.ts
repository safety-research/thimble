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
import { fixingWord } from '../fix/fixes'
import { fixKey, fixLineRows } from '../fix/line'
import { notStarted, registerFix, wordsOfSkill } from '../fix/register'
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
  // other fixes a test gives the kernel (a fix that is on, to change); fold.fails: a change does not fit its fix
  const others: Any[] = []
  const fold = { fails: false }
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
      const r = argv.indexOf('--refines')
      if (r > 0) Object.assign(fix, { refines: Number(argv[r + 1]), refines_always: argv.includes('--always') })
      return ok(fix)
    }
    // the check refused the change: another round in the same copy; the test's refusal was for the first round only
    if (verb === 'again') { Object.assign(fix, { state: 'working', rounds: fix.rounds + 1, refuse: null }); return ok(fix) }
    // --always: the words name the fix this one refines, so its change goes into that fix whatever the end says
    if (verb === 'round') { Object.assign(fix, { words: [...fix.words, stdin], rounds: fix.rounds + 1, state: 'working' }, argv.includes('--always') && fix.refines != null ? { refines_always: true } : {}); return ok(fix) }
    if (verb === 'done') {
      const t = argv.indexOf('--title')
      Object.assign(fix, { state: argv.includes('--request') ? 'request' : 'ready', title: t > 0 ? argv[t + 1] : fix.title, summary: stdin, commit: 'c0ffee1', tests: 'passed', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }] })
      // the kernel's check after the fixer's end refused it (fix.refuse is the reason a test gives); a refusal for
      // safety files is kept on the record (refused) until the next check
      if (argv.includes('--cannot')) { Object.assign(fix, { state: 'failed', tests: null, error: stdin, refused: null }); return ok(fix) }
      if (fix.refuse) Object.assign(fix, { state: 'failed', tests: null, error: fix.refuse, refused: /safety files/.test(fix.refuse) ? { why: fix.refuse, files: ['plugin/engine/kernel/privacy.py'] } : { why: fix.refuse, files: [], tests: 'FAIL made-up test' } })
      else fix.refused = null
      // the end said `Changes fix N` (or the person named it): the change goes into fix N, unless it does not fit
      const c = argv.indexOf('--changes')
      const into = others.find(f => f.id === (c > 0 ? Number(argv[c + 1]) : fix.refines_always ? fix.refines : -1))
      if (into && fix.state === 'ready') {
        if (fold.fails) return ok({ ...fix, fold_failed: into.id })
        Object.assign(into, { state: 'ready', words: [...into.words, ...fix.words], rounds: into.rounds + 1, summary: stdin, tests: 'passed', commit: 'f01d3d1' })
        fix.state = 'removed'
        return ok({ ...into, folded: fix.id })
      }
      return ok(fix)
    }
    if (verb === 'apply') {
      // the kernel checks the press's secret against the sha256 the plugin wrote
      const id = Number(argv[argv.indexOf('apply') + 1])
      if (!JSON.parse(files.get(`${HOME}/fixes/asks/${id}.json`) ?? '{}').key || !stdin) return { exitCode: 1, stdout: '', stderr: "thimble fix apply: only the person's key press in thimble does that" }
      Object.assign(id === 1 ? fix : others.find(f => f.id === id), { state: 'on', work: null })
      return ok({ id, reload: true, version: '0.10.2+fix.c0ffee1' })
    }
    if (verb === 'remove') { if (argv.includes('1')) fix.state = 'removed'; return ok({ id: 1, reload: false }) }
    if (verb === 'merge') {
      const ids = argv.slice(argv.indexOf('merge') + 1, argv.indexOf('--ask')).map(Number)
      if (!JSON.parse(files.get(`${HOME}/fixes/asks/${ids[0]}.json`) ?? '{}').key || !stdin) return { exitCode: 1, stdout: '', stderr: "thimble fix merge: only the person's key press in thimble does that" }
      const t = argv.indexOf('--title')
      return ok({ id: ids[0], title: t > 0 ? argv[t + 1] : 'first', merged: ids.slice(1), redo: [], reload: true })
    }
    if (verb === 'redo') { Object.assign(fix, { state: 'working', refuse: null }); return ok(fix) }
    if (verb === 'undo') { fix.state = 'off'; return ok({ id: 1, reload: true }) }
    if (verb === 'notnow') { fix.state = 'off'; return ok(fix) }
    if (verb === 'diff') return ok('diff --git a/plugin/bar/bar.tsx b/plugin/bar/bar.tsx\n-  coverage\n+  read\n')
    if (verb === 'update' && argv.includes('--check')) return ok({ from: '0.10.2', to: '0.10.3', newer: fix.state === 'on' })
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
  return { $, call, tick, end, made: () => { made = true }, others, fold, ran, spawns, commands, files, fix, opened, toasts, notes, sent, agents, config, state, verbs, copied, asked, where }
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
  expect(String(r.text)).toContain('in a copy (fix 1, "make the bar say read")')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("make the bar's coverage item say read")
  // a fork (no agent type of its own), in the copy, whose first message opens with the fixer's task
  expect(s.spawns[0]).toMatchObject({ subagentType: 'fork', cwd: WORK, name: 'fix-1' })
  const first = String(s.spawns[0].prompt)
  expect(first.startsWith('PROMPT fixer')).toBe(true)
  expect(first).toContain("The person asked for this change to their thimble (fix 1):\n\nmake the bar's coverage item say read")
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
  expect(String(r.text)).toContain('(fix 1, ')
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
  expect(String(r.text)).toContain('thimble gave these words to the fork that already fixes fix 1')
  expect(s.spawns.length).toBe(1)
  expect(s.ran.find(x => x.argv.includes('round'))?.stdin).toBe('and keep the percent')
  expect(s.sent).toEqual([{ to: { agentId: 'agent-fixer-1' }, text: 'The person adds to fix 1 (round 2): and keep the percent' }])
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
  // d: a few lines in the line's place, not a diff
  await (await fixKey(s.$, 'd'))!.later()
  rows = await fixLineRows(s.$, ELS, 110)
  expect(rows.map(textOf)).toEqual([
    '  Bar says read for coverage · fix 1',
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
  rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  ✓ Bar says read for coverage is on · thimble reloaded · u undo')
  expect(textOf(rows[1])).toBe(`    If thimble stops loading: sh ${HOME}/fixes/off.sh`)
  // only u acts now
  expect(await fixKey(s.$, 'y')).toBe(null)
  await (await fixKey(s.$, 'u'))!.later()
  expect(s.verbs()).toContain('undo 1')
  expect(s.commands).toEqual(['reload-plugins', 'reload-plugins'])
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain('is off · thimble reloaded')
  // the person's next prompt takes the line
  await s.call('prompt.submit', { text: 'Which runs failed?', origin: { kind: 'composer' } })
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
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
  // the new load of the plugin: the line says it reloaded
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ Bar says read for coverage is on · thimble reloaded · u undo')

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
  expect(s.toasts.join('\n')).toContain('Fix 1 waits, ready: in a shell, thimble fix apply 1 turns it on, and thimble fix list lists your fixes.')
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
  expect(textOf(rows)).toContain('× Fix 1 did not pass: Skip the scan for my notes')
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
  expect(textOf(rows[0])).toBe('  × Fix 1 did not pass: Skip the scan for my notes · it needs the scan off')
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
  expect(String(r.text)).toContain('thimble started a fork of this conversation that fixes thimble in the background, in a copy (fix 1')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("the card's legend hides its last row")
  expect(String(s.spawns[0].prompt)).toContain("Claude, in the conversation above, saw thimble misbehave and asked for this change to the person's thimble (fix 1):")
  // no words: nothing starts, and Claude reads why
  const none = skillText(await skillCall(s, ' '))
  expect(String(none.text)).toContain('thimble started no fix')
  expect(s.spawns.length).toBe(1)
  // its end: the line and the notification, and Claude is told, so that it can tell the person
  await s.end('Title: Legend shows every row\nWhat it does: The legend wraps.')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Legend shows every row · tests pass')
  const told = ((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['fix-1']).toBe('The thimble fix you started, fix 1 ("Legend shows every row"), is ready and tests pass; the person turns it on with y. Tell the person in one short line.')
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
  expect(String(s.spawns[0].prompt)).toContain('The person asked for this change to their thimble (fix 1)')
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
  expect(s.verbs()).toContain('update --check --json')
  expect(s.verbs()).not.toContain('update --json')
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain('↑ thimble 0.10.3 is out (you have 0.10.2) · in a shell: thimble update')
  expect(s.commands).toEqual([])
  // the reload starts the module again: no second look in this session
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(s.verbs().filter(v => v === 'update --check --json').length).toBe(1)
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

/** A fix the person applied earlier, on: fix 5. */
const onFix = () => ({ id: 5, title: 'Bar says read', words: ['say read, not coverage'], rounds: 1, made_in: 'terminal', created: 1761100000, state: 'on', on_at: 1761100100, work: null, commit: 'be11ead', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }], tests: 'passed', summary: 'The bar says read.', error: null })

test('words while the fix applied last is on: the fixer hears of it, and its end Changes fix 5 makes that fix ready again with both rounds', async () => {
  const s = setup()
  s.others.push(onFix())
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await ask(s, 'not quite: keep the percent')
  expect(String(r.text)).toContain('in a copy (fix 1, "make the bar say read")')
  expect(s.verbs()).toContain('new --made-in terminal --refines 5')
  const first = String(s.spawns[0].prompt)
  expect(first).toContain('The person applied fix 5 ("Bar says read": The bar says read.; asked in the words "say read, not coverage") last')
  expect(first).toContain('end with the line `Changes fix N` (its number) in place of the Title line')
  // a repair of what that fix added is a change to it; only a change clearly about something else is a fix of its own
  expect(first).toContain('When your change is about the same feature or part of thimble as one of these fixes (a repair of something it added included)')
  expect(first).toContain('only a change clearly about something else ends with a title of its own')
  await s.end('Done.\n\nChanges fix 5\nWhat it does: The bar says read and keeps the percent.')
  expect(s.verbs()).toContain('done 1 --summary - --changes 5')
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  ✓ thimble changed fix 5: Bar says read · tests pass')
  expect(textOf(rows[1])).toBe('    y use it now · d what changed · n later')
  expect(s.notes).toEqual([{ text: 'thimble changed fix 5: Bar says read · tests pass', title: 'thimble' }])
  await (await fixKey(s.$, 'd'))!.later()
  rows = await fixLineRows(s.$, ELS, 110)
  expect(rows.map(textOf).slice(0, 4)).toEqual([
    '  Bar says read · fix 5',
    '    You asked   say read, not coverage',
    '    then        not quite: keep the percent',
    '    Claude did  The bar says read and keeps the percent.',
  ])
  // y turns the changed fix on with the person's key, and reloads
  await (await fixKey(s.$, 'y'))!.later()
  expect(s.verbs()).toContain('apply 5 --ask -')
  expect(s.commands).toEqual(['reload-plugins'])
})

test('/thimble-fix 5 <words> always changes fix 5; /thimble-fix new <words> is a new fix; a change that does not fit fix 5 is a new fix and the line says so', async () => {
  const s = setup()
  s.others.push({ ...onFix(), state: 'off' })
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await ask(s, '5 keep the percent')
  // a change to fix 5, never a fix of its own number: Claude and the bar speak of fix 5
  expect(String(r.text)).toBe('thimble started a fork of this conversation that changes fix 5 in the background, in a copy. The person sees "changing fix 5" on the bar while it works, and decides with a key whether to use the changed fix. Tell the person in one short line, then go on with their request. thimble tells you when it ends.')
  expect(busySteps()).toContain('changing fix 5')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe('keep the percent')
  expect(s.verbs()).toContain('new --made-in terminal --refines 5 --always')
  expect(String(s.spawns[0].prompt)).toContain('The person asked to change their fix 5')
  // the end gives a title, and still the change goes into fix 5
  await s.end('Title: Bar keeps percent\nWhat it does: The bar keeps the percent.')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble changed fix 5: Bar says read · tests pass')

  const t = setup()
  t.others.push(onFix())
  await t.call('session.start', { cwd: '/made-up/data' })
  await ask(t, 'new a pane for labels')
  expect(t.ran.find(x => x.argv.includes('new'))?.stdin).toBe('a pane for labels')
  expect(t.verbs()).toContain('new --made-in terminal')
  expect(String(t.spawns[0].prompt)).not.toContain('fix 5')

  const u = setup()
  u.others.push(onFix())
  u.fold.fails = true
  await u.call('session.start', { cwd: '/made-up/data' })
  await ask(u, 'keep the percent')
  await u.end('Changes fix 5\nWhat it does: The bar keeps the percent.')
  expect(textOf((await fixLineRows(u.$, ELS, 160))[0])).toBe("  ✓ thimble fixed: make the bar say read · tests pass · a new fix: it did not fit fix 5")
  expect(u.others[0].state).toBe('on')
})

test('when the fixer cannot tell which fix the words are for, the line asks; a number makes them a change to that fix', async () => {
  const s = setup()
  s.others.push(onFix(), { ...onFix(), id: 3, title: 'Labels pane', words: ['a pane for labels'], on_at: 1761100200, summary: 'A labels pane.' })
  await s.call('session.start', { cwd: '/made-up/data' })
  await ask(s, 'make it bigger')
  const first = String(s.spawns[0].prompt)
  expect(s.verbs()).toContain('new --made-in terminal --refines 3')
  expect(first).toContain('Their other fixes that are on, also in your copy: fix 5 ("Bar says read"')
  expect(first).toContain('end with one line `Which fix: <one short question>`')
  await s.end('Which fix: The bar item, or the labels pane?')
  expect(s.verbs()).toContain('remove 1')
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  ? The bar item, or the labels pane?')
  expect(textOf(rows[1])).toBe('    3 Labels pane · 5 Bar says read · 0 a new fix · n never mind')
  expect(await fixKey(s.$, '7')).toBe(null)
  await (await fixKey(s.$, '5'))!.later()
  expect(s.verbs()).toContain('new --made-in terminal --refines 5 --always')
  expect(s.ran.filter(x => x.argv.includes('new')).at(-1)?.stdin).toBe('make it bigger')
  expect(String(s.spawns[1].prompt)).toContain('The person asked to change their fix 5')
  rows = await fixLineRows(s.$, ELS, 110)
  expect(rows).toEqual([])
})


test('/thimble-fix 2 <words> while a fixer works on a change that may be fix 2\'s: one fixer, whose end makes it part of fix 2', async () => {
  // fix 2 is on; the person's words about it start fix 3, which may change fix 2; then "2 merge those into fix 2"
  const s = setup()
  s.fix.id = 3
  s.others.push({ ...onFix(), id: 2, title: 'Ask about any card element' })
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await ask(s, 'the card is stuck on drawing, and e does not show the card in a thread')
  expect(s.verbs()).toContain('new --made-in terminal --refines 2')
  expect(String(r.text)).toContain('(fix 3, "make the bar say read"). If its change is about fix 2, it becomes part of fix 2, with no fix 3 of its own. The person sees on the bar')
  expect(busySteps()).toContain('fixing fix 3')
  const again = await ask(s, '2 merge those all into fix 2, not a separate fix')
  // the same fixer, told to end with Changes fix 2; the kernel records that it changes fix 2 whatever its end says
  expect(s.spawns.length).toBe(1)
  expect(s.verbs().filter(v => v.startsWith('new'))).toEqual(['new --made-in terminal --refines 2'])
  expect(s.verbs()).toContain('round 3 --always')
  expect(s.sent).toEqual([{ to: { agentId: 'agent-fixer-1' }, text: 'The person adds to this change to fix 2 (round 2): merge those all into fix 2, not a separate fix\n\nEnd with the line `Changes fix 2` in place of the Title line: thimble makes your change part of fix 2.' }])
  expect(String(again.text)).toBe('thimble gave these words to the fork that is already changing fix 2; its change becomes part of fix 2. Tell the person in one short line, then go on with their request.')
  expect(fixingWord(s.fix)).toBe('changing fix 2')
  // its end, even with a title of its own, folds into fix 2: one fix, ready again with every round
  await s.end('Done.\n\nTitle: Card draws again\nWhat it does: The card finishes drawing, and e shows it in a thread.')
  expect(s.verbs().filter(v => v.startsWith('done'))).toEqual(['done 3 --summary - --title Card draws again'])
  expect(s.others[0]).toMatchObject({ state: 'ready', words: ['say read, not coverage', 'the card is stuck on drawing, and e does not show the card in a thread', 'merge those all into fix 2, not a separate fix'] })
  expect(s.fix.state).toBe('removed')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble changed fix 2: Ask about any card element · tests pass')
})

test('Claude\'s words for a fix that may change fix 2: a round says how to end, and Claude hears of fix 2 at the end, never of a number to decline', async () => {
  const s = setup()
  s.fix.id = 3
  s.others.push({ ...onFix(), id: 2, title: 'Ask about any card element' })
  await s.call('session.start', { cwd: '/made-up/data' })
  await skillCall(s, 'the card is stuck on drawing')
  const r = skillText(await skillCall(s, 'and e does nothing in a thread'))
  expect(String(r.text)).toBe('thimble gave these words to the fork that already fixes fix 3 ("make the bar say read"). If its change is about fix 2, it becomes part of fix 2, with no fix 3 of its own. Tell the person in one short line, then go on with their request.')
  expect(s.sent[0]!.text).toBe('Claude adds to fix 3 (round 2): and e does nothing in a thread\n\nWhen these words ask to make your change part of fix 2, end with the line `Changes fix 2` in place of the Title line.')
  await s.end('Changes fix 2\nWhat it does: The card finishes drawing.')
  const told = ((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['fix-3']).toBe('The thimble change you started is now part of fix 2 ("Ask about any card element"): it is ready and tests pass; the person turns the changed fix on with y. Tell the person in one short line.')
})
