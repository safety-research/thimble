// thimble fix in the hooks module (fix/), on a plain engine whose kernel is faked (the kernel's own tests are
// test_fixes.py): /thimble-fix starts the fixer in its copy; the fixer's shell runs in the sandbox and it writes only its
// copy; Claude can neither apply nor send a fix; the fixer's end puts the fix's line above the bar; y applies it with a
// secret only that press holds and reloads the plugins; u undoes it; n leaves it off; /thimble-fix alone lists the
// fixes, and d shows a fix's diff. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { fixKey, fixLineRows } from '../fix/line'
import { drawFixes } from '../fix/pane'
import { registerFix } from '../fix/register'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const HOME = '/made-up/.thimble'
const WORK = `${HOME}/fixes/work/1`
const BOX = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/made-up/node', '/made-up/plugin/sandbox/run.mjs', '--srt', `${HOME}/srt/0.0.79`,
  JSON.stringify({ filesystem: { allowWrite: [{ path: WORK, literal: true }, { path: `${HOME}/fixes/tmp/1`, literal: true }] } }), '--', '/bin/bash', '-c']
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
  const fix: Any = { id: 1, title: 'make the bar say read', words: ["make the bar's coverage item say read"], rounds: 1, made_in: 'terminal', created: 1761200000, state: 'working', work: WORK, commit: null, files: [], tests: null, summary: '', error: null }
  const list = () => ({ fixes: [fix], on: true, live: `${HOME}/fixes/live`, version: '0.10.2', count_on: fix.state === 'on' ? 1 : 0, pointed: true })
  const kernel = (argv: string[], stdin?: string) => {
    const ok = (out: unknown) => ({ exitCode: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' })
    const verb = argv[argv.indexOf('fix') + 1]
    if (verb === 'list') return ok(list())
    if (verb === 'new') return ok(fix)
    if (verb === 'sandbox') return ok(BOX)
    if (verb === 'done') {
      const t = argv.indexOf('--title')
      Object.assign(fix, { state: argv.includes('--request') ? 'request' : 'ready', title: t > 0 ? argv[t + 1] : fix.title, summary: stdin, commit: 'c0ffee1', tests: 'passed', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }] })
      // the kernel's check after the fixer's end refused it (fix.refused is the reason a test gives)
      if (fix.refused) Object.assign(fix, { state: 'failed', tests: null, error: fix.refused })
      return ok(fix)
    }
    if (verb === 'apply') {
      // the kernel checks the press's secret against the sha256 the plugin wrote
      if (!JSON.parse(files.get(`${HOME}/fixes/asks/1.json`) ?? '{}').key || !stdin) return { exitCode: 1, stdout: '', stderr: "thimble fix apply: only the person's key press in thimble does that" }
      Object.assign(fix, { state: 'on', work: null })
      return ok({ id: 1, reload: true, version: '0.10.2+fix.c0ffee1' })
    }
    if (verb === 'undo') { fix.state = 'off'; return ok({ id: 1, reload: true }) }
    if (verb === 'notnow') { fix.state = 'off'; return ok(fix) }
    if (verb === 'diff') return ok('diff --git a/plugin/bar/bar.tsx b/plugin/bar/bar.tsx\n-  coverage\n+  read\n')
    if (verb === 'update' && argv.includes('--check')) return ok({ from: '0.10.2', to: '0.10.3', newer: fix.state === 'on' })
    if (verb === 'update') {
      return ok(fix.state === 'on'
        ? { said: 'thimble 0.10.3 · 1 pending', pending: [1], reload: true, lines: ['thimble 0.10.2 → 0.10.3', '  pending         make the bar say read', '', `  cd ${HOME}/fixes/live && claude "$(cat ${HOME}/fixes/pending/0.10.3.md)"`] }
        : { said: '', reload: false, lines: ['thimble 0.10.3 is the newest release (0.10.3).'] })
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
    agent: { register: async () => ({ agent: 'thimble:fixer' }), spawn: async (a: Any) => { spawns.push(a); return { model: 'claude-made-up', agentId: `agent-fixer-${spawns.length}` } } },
    session: { id: async () => 's-fix', cwd: async () => where.root, root: async () => where.root },
    process: { run: async (argv: string[], o: Any = {}) => { ran.push({ argv, ...(o.stdin != null ? { stdin: o.stdin } : {}) }); return argv.includes('fix') ? kernel(argv, o.stdin) : { exitCode: 0, stdout: '', stderr: '' } } },
    command: { run: async (c: Any) => { commands.push(c.command); return {} }, register: async () => ({ command: 'thimble-fix' }) },
    ui: { toast: (t: string) => { toasts.push(t) }, log: () => undefined, open: async (o: Any) => { opened.push(o.id); return { isPlaced: true } }, panes: async () => opened.map(id => ({ id })), close: async () => ({}), invalidate: () => undefined },
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
  return { $, call, tick, ran, spawns, commands, files, fix, opened, toasts, verbs, where }
}

/** A request, and the fixer's end with what it says. */
async function requested(s: ReturnType<typeof setup>, answer = 'Done.\n\nTitle: Bar says read for coverage\nWhat it does: The bar says r read 14%.') {
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await s.call('command.run', { command: 'thimble-fix', args: "make the bar's coverage item say read" })
  await s.call('turn.complete', { turnId: 't-f', agentId: 'agent-fixer-1', reason: 'answer', answer, durationMs: 9, isAborted: false }, async () => ({}))
  await s.tick()
  return r
}

test('a request starts the fixer in its copy; its shell runs in the sandbox, and Claude can neither apply nor write the fixes', async () => {
  const s = setup()
  await s.call('session.start', { cwd: '/made-up/data' })
  const r = await s.call('command.run', { command: 'thimble-fix', args: "make the bar's coverage item say read" })
  expect(String(r.text)).toContain('works on fix 1')
  expect(s.ran.find(x => x.argv.includes('new'))?.stdin).toBe("make the bar's coverage item say read")
  expect(s.spawns[0]).toMatchObject({ subagentType: 'thimble:fixer', cwd: WORK })
  expect(s.spawns[0].prompt).toContain("make the bar's coverage item say read")
  const ran = async (e: Any) => ({ result: { ran: e.command ?? e.file_path ?? '' } })
  // the fixer's Bash: the same command, in the sandbox
  const bash = await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-1', agentId: 'agent-fixer-1', command: 'claude plugin test plugin' }, ran)
  expect(String(bash.result.ran).startsWith("'/usr/bin/env' '-i'")).toBe(true)
  expect(String(bash.result.ran)).toContain("'/bin/bash' '-c' 'claude plugin test plugin'")
  // its writes: only in its copy; no other tools
  expect((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-2', agentId: 'agent-fixer-1', file_path: `${WORK}/plugin/bar/bar.tsx` }, ran)).result.ran).toBe(`${WORK}/plugin/bar/bar.tsx`)
  expect(String((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-3', agentId: 'agent-fixer-1', file_path: '/made-up/data/notes.md' }, ran)).deny)).toContain('only its copy')
  expect(String((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-3b', agentId: 'agent-fixer-1', file_path: `${WORK}/../../live/plugin/x.ts` }, ran)).deny)).toContain('only its copy')
  expect(String((await s.call('tool.call', { tool: 'WebFetch', tool_use_id: 'tu-4', agentId: 'agent-fixer-1', url: 'https://example.com' }, ran)).deny)).toContain('works offline')
  // its hand-back, which ends its run, goes through
  expect((await s.call('tool.call', { tool: 'SubagentHandback', tool_use_id: 'tu-4b', agentId: 'agent-fixer-1', message: 'Title: x' }, async () => ({ result: { ran: 'handed back' } }))).result.ran).toBe('handed back')
  // main: thimble's own verbs and folder are refused; the person's shell verbs are not
  expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5', command: 'thimble fix apply 1 --ask -' }, ran)).deny)).toContain('Only thimble and the person')
  expect(String((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-5b', command: 'cd x && thimble  fix send 1 --answer pr' }, ran)).deny)).toContain('Only thimble and the person')
  expect(String((await s.call('tool.call', { tool: 'Write', tool_use_id: 'tu-6', file_path: `${HOME}/fixes/asks/1.json` }, ran)).deny)).toContain('thimble alone')
  expect((await s.call('tool.call', { tool: 'Bash', tool_use_id: 'tu-7', command: 'thimble fix list' }, ran)).result.ran).toBe('thimble fix list')
  // the fixer's calls thimble put in the sandbox or its copy need no dialog; main's and other places still ask
  const ask = async () => ({ decision: 'ask' })
  expect((await s.call('tool.check', { tool: 'Bash', tool_use_id: 'tu-1', agentId: 'agent-fixer-1', input: { command: bash.result.ran } }, ask)).decision).toBe('allow')
  expect((await s.call('tool.check', { tool: 'Bash', tool_use_id: 'tu-9', agentId: 'agent-fixer-1', input: { command: 'rm -rf ~' } }, ask)).decision).toBe('ask')
  expect((await s.call('tool.check', { tool: 'Write', agentId: 'agent-fixer-1', input: { file_path: `${WORK}/a.ts` } }, ask)).decision).toBe('allow')
  expect((await s.call('tool.check', { tool: 'Write', agentId: 'agent-fixer-1', input: { file_path: '/made-up/data/a.ts' } }, ask)).decision).toBe('ask')
  expect((await s.call('tool.check', { tool: 'Write', input: { file_path: `${WORK}/a.ts` } }, ask)).decision).toBe('ask')
})

test("the fixer's end puts the fix's line above the bar; y applies it with the press's secret and reloads; u undoes it", async () => {
  const s = setup()
  await requested(s)
  expect(s.verbs()).toContain('done 1 --summary - --title Bar says read for coverage')
  expect(s.ran.find(x => x.argv.includes('done'))?.stdin).toBe('The bar says r read 14%.')
  let line = textOf(await fixLineRows(s.$, ELS, 110))
  expect(line).toContain('Fix ready: Bar says read for coverage')
  expect(line).toContain('1 file +1 −1 · tests passed in the sandbox')
  expect(line).toContain('y apply · d diff · n not now')
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
  line = textOf(await fixLineRows(s.$, ELS, 110))
  expect(line).toContain('Bar says read for coverage is on · thimble reloaded · u undo')
  expect(line).toContain(`If thimble stops loading: sh ${HOME}/fixes/off.sh`)
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

test('n leaves the fix off in the list; a fixer that changed nothing leaves a request', async () => {
  const s = setup()
  await requested(s)
  await (await fixKey(s.$, 'n'))!.later()
  expect(s.verbs()).toContain('notnow 1')
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  expect(s.toasts.join('\n')).toContain('waits in Your fixes, off')
  const t = setup()
  await requested(t, 'Title: Explain terms of my field\nRequest: It needs words only the person knows.')
  expect(t.verbs()).toContain('done 1 --summary - --title Explain terms of my field --request')
  expect(textOf(await fixLineRows(t.$, ELS, 110))).toContain('Saved as a request with no code: Explain terms of my field')
})

test('a refused fix shows its whole reason: a long one on a row of its own, a short one after the title', async () => {
  const s = setup()
  s.fix.refused = 'it changes plugin/engine/kernel/privacy.py (the privacy scan); thimble does not apply changes to its safety files'
  await requested(s, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  let rows = await fixLineRows(s.$, ELS, 110)
  expect(textOf(rows)).toContain('× Fix 1 did not pass: Skip the scan for my notes')
  expect(rows.map((r: Any) => r.props.key)).toEqual(['fix-rule-a', 'fix-line-1', 'fix-line-why', 'fix-line-2', 'fix-rule-b'])
  expect(textOf(rows[2])).toBe(`  ${s.fix.refused}`)
  expect(textOf(rows[3])).toContain('d diff · r redo · n not now')
  const t = setup()
  t.fix.refused = 'its tests failed in the sandbox'
  await requested(t, 'Title: Skip the scan for my notes\nWhat it does: The scan skips the notes you name.')
  rows = await fixLineRows(t.$, ELS, 110)
  expect(textOf(rows[1])).toBe('× Fix 1 did not pass: Skip the scan for my notes · its tests failed in the sandbox')
  expect(rows.map((r: Any) => r.props.key)).not.toContain('fix-line-why')
})

test("/thimble-fix alone lists the fixes; d shows the selected fix's diff; u on a ready fix applies it", async () => {
  const s = setup()
  await requested(s, 'Title: Bar says read\nWhat it does: The bar says read.')
  await s.call('command.run', { command: 'thimble-fix', args: '' })
  expect(s.opened).toContain('thimble')
  const e = { props: { bodyColumns: 90 } }
  let drawn = await drawFixes(s.$, e, {}, ELS)
  expect(textOf(drawn)).toContain('Your fixes · thimble 0.10.2 + 0 on')
  expect(textOf(drawn)).toMatch(/◆ ready +Bar says read/)
  expect(textOf(drawn)).toContain("You asked “make the bar's coverage item say read”")
  await buttons(drawn)['key-d']!.onPress()
  drawn = await drawFixes(s.$, e, {}, ELS)
  expect(textOf(drawn)).toContain('+  read')
  await buttons(drawn)['key-u']!.onPress()
  expect(s.verbs()).toContain('apply 1 --ask -')
})

test('at session start one line says a newer release is out, once a session; /thimble-fix update moves to it and gives the command for the pending fixes', async () => {
  const s = setup()
  s.fix.state = 'on'
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(s.verbs()).toContain('update --check --json')
  expect(s.verbs()).not.toContain('update --json')
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain('↑ thimble 0.10.3 is out (you have 0.10.2) · /thimble-fix update')
  expect(s.commands).toEqual([])
  // the reload starts the module again: no second look in this session
  await s.call('session.start', { cwd: '/made-up/data' })
  await s.tick()
  expect(s.verbs().filter(v => v === 'update --check --json').length).toBe(1)
  await s.call('prompt.submit', { text: 'Which runs failed?', origin: { kind: 'composer' } })
  expect(await fixLineRows(s.$, ELS, 110)).toEqual([])
  // the person's /thimble-fix update: the release with the fixes on it, the summary, and the session reloads
  const r = await s.call('command.run', { command: 'thimble-fix', args: 'update' })
  await s.tick()
  expect(s.verbs()).toContain('update --json')
  expect(String(r.text)).toContain('thimble 0.10.2 → 0.10.3')
  expect(String(r.text)).toContain(`cd ${HOME}/fixes/live && claude "$(cat ${HOME}/fixes/pending/0.10.3.md)"`)
  expect(textOf(await fixLineRows(s.$, ELS, 110))).toContain('↑ thimble 0.10.3 · 1 pending')
  expect(s.commands).toEqual(['reload-plugins'])
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
