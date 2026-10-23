// thimble fix in the hooks module (fix/), on a plain engine whose kernel is faked (the kernel's own tests are
// test_fixes.py): /thimble-fix, or Claude's fix-thimble skill, starts the fixer as a fork of the session in its copy,
// with a text copy of what thimble shows; more words while it works go to the same fixer; Claude can neither apply nor
// send a fix, the fixer included; the fixer's end puts the fix's line above the bar and sends a notification; d shows
// what changed; y applies it with a secret only that press holds and reloads the plugins (at the turn's end when Claude
// is mid-reply; a --plugin-dir session is told to restart); u undoes it; n leaves it ready in the list; /thimble-fix
// alone lists the fixes. The fixer's shell runs in the sandbox the kernel describes, with a time limit, and its writes
// stay in its copy. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { fixKey, fixLineRows } from '../fix/line'
import { drawFixes } from '../fix/pane'
import { registerFix, wordsOfSkill } from '../fix/register'
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

/** Every Button in a drawing, by its key. */
function buttons(n: Any, out: Record<string, Any> = {}): Record<string, Any> {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => buttons(x, out)); return out }
  if (n.type === 'Button' && n.props?.key) out[n.props.key] = n.props
  buttons(n.props?.children, out)
  return out
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
    if (verb === 'new') {
      made = true
      if (stdin) fix.words = [stdin]
      const r = argv.indexOf('--refines')
      if (r > 0) Object.assign(fix, { refines: Number(argv[r + 1]), refines_always: argv.includes('--always') })
      return ok(fix)
    }
    if (verb === 'round') { Object.assign(fix, { words: [...fix.words, stdin], rounds: fix.rounds + 1, state: 'working' }); return ok(fix) }
    if (verb === 'done') {
      const t = argv.indexOf('--title')
      Object.assign(fix, { state: argv.includes('--request') ? 'request' : 'ready', title: t > 0 ? argv[t + 1] : fix.title, summary: stdin, commit: 'c0ffee1', tests: 'passed', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }] })
      // the kernel's check after the fixer's end refused it (fix.refused is the reason a test gives)
      if (fix.refused) Object.assign(fix, { state: 'failed', tests: null, error: fix.refused })
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
    if (verb === 'redo') { Object.assign(fix, { state: 'working', refused: null }); return ok(fix) }
    if (verb === 'undo') { fix.state = 'off'; return ok({ id: 1, reload: true }) }
    if (verb === 'notnow') { fix.state = 'off'; return ok(fix) }
    if (verb === 'diff') return ok('diff --git a/plugin/bar/bar.tsx b/plugin/bar/bar.tsx\n-  coverage\n+  read\n')
    if (verb === 'update' && argv.includes('--check')) return ok({ from: '0.10.2', to: '0.10.3', newer: fix.state === 'on' })
    if (verb === 'share') {
      const given = stdin ? JSON.parse(stdin) : null
      return ok({ id: 1, title: given?.title || fix.title, took: 'took 1 file name out of the text', opened: true, page: `${HOME}/fixes/share/1/index.html`, url: 'https://github.com/safety-research/thimble/issues/new?title=Bar%20says%20read&body=What%20was%20wrong', shortened: false, text: given ? 'claude' : 'earlier' })
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
  const verbs = () => ran.map(r => r.argv.slice(r.argv.indexOf('fix') + 1).join(' ')).filter(Boolean)
  /** The fixer's end: its agent idles, and its turn's end reaches the hooks. */
  const end = async (answer: string, agentId = 'agent-fixer-1') => {
    for (const a of agents) if (a.id === agentId) a.status = 'idle'
    await call('turn.complete', { turnId: 't-f', agentId, reason: 'answer', answer, durationMs: 9, isAborted: false }, async () => ({}))
    await tick()
  }
  return { $, call, tick, end, made: () => { made = true }, others, fold, ran, spawns, commands, files, fix, opened, toasts, notes, sent, agents, config, state, verbs, copied, asked, where }
}

/** A request, and the fixer's end with what it says. */
async function requested(s: ReturnType<typeof setup>, answer = 'Done.\n\nTitle: Bar says read for coverage\nWhat it does: The bar says r read 14%.') {
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await s.call('command.run', { command: 'thimble-fix', args: "make the bar's coverage item say read" })
  await s.end(answer)
  return r
}

const ran = async (e: Any) => ({ result: { ran: e.command ?? e.file_path ?? '' } })

test("a request forks the session into its copy with a text copy of the screen; no call, the fixer's included, applies or writes the fixes", async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  // what the screen shows: a failure line above the bar, and Your fixes open in the side pane
  await s.$.state.set({ plugin: 'thimble', key: 'failLine' }, { kind: 'failed', text: 'The card “Runs by day” could not be drawn' })
  await s.call('command.run', { command: 'thimble-fix', args: '' })
  const r = await s.call('command.run', { command: 'thimble-fix', args: "make the bar's coverage item say read" })
  expect(String(r.text)).toBe('A fork of this session is fixing it in the background (fix 1). Keep going.')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("make the bar's coverage item say read")
  // a fork (no agent type of its own), in the copy, whose first message opens with the fixer's task
  expect(s.spawns[0]).toMatchObject({ subagentType: 'fork', cwd: WORK })
  const first = String(s.spawns[0].prompt)
  expect(first.startsWith('PROMPT fixer')).toBe(true)
  expect(first).toContain("The person asked for this change to their thimble (fix 1):\n\nmake the bar's coverage item say read")
  expect(first).toContain("What thimble shows on the person's screen now, as text")
  expect(first).toContain('× The card “Runs by day” could not be drawn')
  expect(first).toContain('The side pane, open on fixes:')
  expect(first).toContain('Your fixes · thimble 0.10.2')
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
    expect(String((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-6', agentId, file_path: `${HOME}/fixes/asks/1.json` }, ran)).deny)).toContain('thimble alone')
  }
  expect((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-7', command: 'thimble fix list' }, ran)).result.ran).toBe('thimble fix list')
})

test('more words while the fixer works go to the same fixer, as a round of its fix', async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.call('command.run', { command: 'thimble-fix', args: "make the bar's coverage item say read" })
  const r = await s.call('command.run', { command: 'thimble-fix', args: 'and keep the percent' })
  expect(String(r.text)).toBe('The fork fixing fix 1 has these words too. Keep going.')
  expect(s.spawns.length).toBe(1)
  expect(s.ran.find(x => x.argv.includes('round'))?.stdin).toBe('and keep the percent')
  expect(s.sent).toEqual([{ to: { agentId: 'agent-fixer-1' }, text: 'The person adds to fix 1 (round 2): and keep the percent' }])
  // once the fixer ended, new words are a new request
  await s.end('Title: Bar says read\nWhat it does: The bar says read.')
  await (await fixKey(s.$, 'n'))!.later()
  s.fix.state = 'ready'
  await s.call('command.run', { command: 'thimble-fix', args: 'the pane title too' })
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

test('n leaves the fix ready in the list, where y turns it on; a fixer that changed nothing leaves a request', async () => {
  const s = setup()
  await requested(s)
  await (await fixKey(s.$, 'n'))!.later()
  expect(s.verbs().some(v => v.startsWith('notnow'))).toBe(false)
  expect(s.fix.state).toBe('ready')
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(s.toasts.join('\n')).toContain('waits in Your fixes, ready')
  await s.call('command.run', { command: 'thimble-fix', args: '' })
  const drawn = await drawFixes(s.$, { props: { bodyColumns: 90 } }, {}, ELS)
  expect(textOf(drawn)).toMatch(/◆ ready +Bar says read for coverage/)
  await buttons(drawn)['key-y']!.onPress()
  expect(s.verbs()).toContain('apply 1 --ask -')
  const t = setup()
  await requested(t, 'Title: Explain terms of my field\nRequest: It needs words only the person knows.')
  expect(t.verbs()).toContain('done 1 --summary - --title Explain terms of my field --request')
  expect(textOf(await fixLineRows(t.$, ELS, 110))).toContain('Saved as a request with no code: Explain terms of my field')
})

test('a refused fix shows its whole reason: a long one on a row of its own, a short one after the title; d shows what changed', async () => {
  const s = setup()
  s.fix.refused = 'it changes plugin/engine/kernel/privacy.py (the privacy scan); thimble does not apply changes to its safety files'
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows)).toContain('× Fix 1 did not pass: Skip the scan for my notes')
  expect(rows.map((r: Any) => r.props.key)).toEqual(['fix-line-1', 'fix-line-why', 'fix-line-2'])
  expect(textOf(rows[1])).toBe(`    ${s.fix.refused}`)
  expect(textOf(rows[2])).toBe('    d what changed · r redo · n later')
  expect(s.notes).toEqual([])
  await (await fixKey(s.$, 'd'))!.later()
  rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows.at(-2))).toBe(`    Changed     1 file · ${s.fix.refused}`)
  expect(textOf(rows.at(-1))).toBe('    r redo · n later')
  // r: a new fixer, told where the earlier change is
  await (await fixKey(s.$, 'r'))!.later()
  expect(s.spawns.length).toBe(2)
  expect(String(s.spawns[1].prompt)).toContain(`is in ${HOME}/fixes/tmp/1/earlier.patch;`)
  const t = setup()
  t.fix.refused = 'its tests failed'
  await requested(t, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  rows = await fixLineRows(t.$, ELS, 110)
  expect(textOf(rows[0])).toBe('  × Fix 1 did not pass: Skip the scan for my notes · its tests failed')
  expect(rows.map((r: Any) => r.props.key)).not.toContain('fix-line-why')
})

test('/thimble-fix alone lists the fixes but those in the release; the selected fix shows what changed, and no diff key', async () => {
  const s = setup()
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  await s.call('command.run', { command: 'thimble-fix', args: '' })
  expect(s.opened).toContain('thimble')
  const e = { props: { bodyColumns: 90 } }
  let drawn = await drawFixes(s.$, e, {}, ELS)
  expect(textOf(drawn)).toContain('Your fixes · thimble 0.10.2 + 0 on')
  expect(textOf(drawn)).toMatch(/◆ ready +Bar says read/)
  expect(textOf(drawn)).toContain("You asked   make the bar's coverage item say read")
  expect(textOf(drawn)).toContain('Claude did  The bar says read.')
  expect(Object.keys(buttons(drawn))).not.toContain('key-d')
  await buttons(drawn)['key-y']!.onPress()
  expect(s.verbs()).toContain('apply 1 --ask -')
  drawn = await drawFixes(s.$, e, {}, ELS)
  expect(Object.keys(buttons(drawn))).toContain('key-u')
  s.fix.state = 'released'
  await s.call('command.run', { command: 'thimble-fix', args: '' })
  drawn = await drawFixes(s.$, e, {}, ELS)
  expect(textOf(drawn)).toContain('Ask for a change at the prompt')
  expect(textOf(drawn)).not.toContain('Bar says read')
})

test("Claude starts a fix with the fix-thimble skill: the same fork starts, Claude reads what came of it, and is told when it ends", async () => {
  expect(wordsOfSkill("What thimble does wrong, and what it should do: the explainer's links show as raw text\n\nthimble starts its fix…")).toBe("the explainer's links show as raw text")
  expect(wordsOfSkill('What thimble does wrong, and what it should do: \n\nthimble starts its fix…')).toBe('')
  expect(wordsOfSkill('What thimble does wrong, and what it should do: $ARGUMENTS\n\nthimble starts…\n\nARGUMENTS: the bar is cut')).toBe('the bar is cut')
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const skill = { skill: 'thimble:fix-thimble', text: "What thimble does wrong, and what it should do: the card's legend hides its last row\n\nthimble starts its fix…", frontmatter: {}, source: 'plugin' }
  const r = await s.call('skill.prompt', skill, async (e: Any) => ({ text: e.text }))
  expect(String(r.text)).toContain('thimble started a fork of this conversation that fixes thimble in the background, in a copy (fix 1')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("the card's legend hides its last row")
  expect(String(s.spawns[0].prompt)).toContain("Claude, in the conversation above, saw thimble misbehave and asked for this change to the person's thimble (fix 1):")
  // no words: nothing starts, and Claude reads why
  const none = await s.call('skill.prompt', { ...skill, text: 'What thimble does wrong, and what it should do: \n\nthimble starts…' }, async (e: Any) => ({ text: e.text }))
  expect(String(none.text)).toContain('thimble started no fix')
  expect(s.spawns.length).toBe(1)
  // its end: the line and the notification, and Claude is told, so that it can tell the person
  await s.end('Title: Legend shows every row\nWhat it does: The legend wraps.')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble fixed: Legend shows every row · tests pass')
  const told = ((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>
  expect(told['fix-1']).toBe('The thimble fix you started, fix 1 ("Legend shows every row"), is ready and tests pass; the person turns it on with y. Tell the person in one short line.')
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

test("s in Your fixes shares the selected fix: Claude's text, then the share page; o opens it again and c copies the link", async () => {
  const s = setup()
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  await s.call('command.run', { command: 'thimble-fix', args: '' })
  const e = { props: { bodyColumns: 100 } }
  let drawn = await drawFixes(s.$, e, {}, ELS)
  expect(buttons(drawn)['key-s']!.label).toBe('share')
  await buttons(drawn)['key-s']!.onPress()
  // one model call with the fix-draft text, then the kernel's share with Claude's text on stdin; never draft or send
  expect(s.asked.length).toBe(1)
  expect(s.asked[0].system[0].text).toBe('PROMPT fix-draft')
  expect(s.asked[0].prompt).toContain("<round n=\"1\">make the bar's coverage item say read</round>")
  const share = s.ran.find(x => x.argv.includes('share'))
  expect(share?.argv.slice(-4)).toEqual(['1', '--json', '--draft', '-'])
  expect(JSON.parse(String(share?.stdin))).toEqual({ title: 'Bar says coverage, not read', wrong: 'The bar said coverage after Claude read a file.', fixed: 'The bar says read.' })
  expect(s.verbs().some(v => /^(?:draft|send)\b/.test(v))).toBe(false)
  drawn = await drawFixes(s.$, e, {}, ELS)
  const text = textOf(drawn)
  expect(text).toContain('Share fix 1: Bar says coverage, not read')
  expect(text).toContain('  ✓ privacy check: took 1 file name out of the text')
  expect(text).toContain('  ✓ opened the share page in your browser')
  expect(text).toContain('Nothing leaves your computer until you press Submit there.')
  // o: the page again from the same text, no model call; c: the link on the clipboard
  expect([buttons(drawn)['key-o']!.label, buttons(drawn)['key-c']!.label]).toEqual(['open the page again', 'copy the link'])
  await buttons(drawn)['key-o']!.onPress()
  expect(s.asked.length).toBe(1)
  expect(s.ran.filter(x => x.argv.includes('share')).at(-1)?.argv.slice(-2)).toEqual(['1', '--json'])
  await buttons(drawn)['key-c']!.onPress()
  expect(s.copied).toEqual(['https://github.com/safety-research/thimble/issues/new?title=Bar%20says%20read&body=What%20was%20wrong'])
  // moving in the list shows the fix again
  await buttons(drawn)['key-j']!.onPress()
  expect(textOf(await drawFixes(s.$, e, {}, ELS))).not.toContain('Share fix 1')
})

/** A fix the person applied earlier, on: fix 5. */
const onFix = () => ({ id: 5, title: 'Bar says read', words: ['say read, not coverage'], rounds: 1, made_in: 'terminal', created: 1761100000, state: 'on', on_at: 1761100100, work: null, commit: 'be11ead', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }], tests: 'passed', summary: 'The bar says read.', error: null })

test('words while the fix applied last is on: the fixer hears of it, and its end Changes fix 5 makes that fix ready again with both rounds', async () => {
  const s = setup()
  s.others.push(onFix())
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await s.call('command.run', { command: 'thimble-fix', args: 'not quite: keep the percent' })
  expect(String(r.text)).toBe('A fork of this session is fixing it in the background (fix 1). Keep going.')
  expect(s.verbs()).toContain('new --made-in terminal --refines 5')
  const first = String(s.spawns[0].prompt)
  expect(first).toContain('The person applied fix 5 ("Bar says read": The bar says read.; asked in the words "say read, not coverage")')
  expect(first).toContain('end with the line `Changes fix 5` in place of the Title line')
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
  // Your fixes lists the rounds
  await s.call('command.run', { command: 'thimble-fix', args: '' })
  const drawn = textOf(await drawFixes(s.$, { props: { bodyColumns: 90 } }, {}, ELS))
  expect(drawn).toContain('not quite: keep the percent')
  expect(drawn).toContain('2 rounds')
})

test('/thimble-fix 5 <words> always changes fix 5; /thimble-fix new <words> is a new fix; a change that does not fit fix 5 is a new fix and the line says so', async () => {
  const s = setup()
  s.others.push({ ...onFix(), state: 'off' })
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await s.call('command.run', { command: 'thimble-fix', args: '5 keep the percent' })
  expect(String(r.text)).toBe('A fork of this session is changing fix 5 in the background. Keep going.')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe('keep the percent')
  expect(s.verbs()).toContain('new --made-in terminal --refines 5 --always')
  expect(String(s.spawns[0].prompt)).toContain('The person asked to change their fix 5')
  // the end gives a title, and still the change goes into fix 5
  await s.end('Title: Bar keeps percent\nWhat it does: The bar keeps the percent.')
  expect(textOf((await fixLineRows(s.$, ELS, 110))[0])).toBe('  ✓ thimble changed fix 5: Bar says read · tests pass')

  const t = setup()
  t.others.push(onFix())
  await t.call('session.start', { cwd: '/made-up/data' })
  await t.call('command.run', { command: 'thimble-fix', args: 'new a pane for labels' })
  expect(t.ran.find(x => x.argv.includes('new'))?.stdin).toBe('a pane for labels')
  expect(t.verbs()).toContain('new --made-in terminal')
  expect(String(t.spawns[0].prompt)).not.toContain('fix 5')

  const u = setup()
  u.others.push(onFix())
  u.fold.fails = true
  await u.call('session.start', { cwd: '/made-up/data' })
  await u.call('command.run', { command: 'thimble-fix', args: 'keep the percent' })
  await u.end('Changes fix 5\nWhat it does: The bar keeps the percent.')
  expect(textOf((await fixLineRows(u.$, ELS, 160))[0])).toBe("  ✓ thimble fixed: make the bar say read · tests pass · a new fix: it did not fit fix 5")
  expect(u.others[0].state).toBe('on')
})
