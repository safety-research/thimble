// The scripts the mod runs itself, outside Claude Code's tools, run in the sandbox browser mode's notebook kernels run
// in (backend/app/kernel_wrap.py: srt, else bubblewrap): a card's script run again, a verification script, a view's
// checks (which run its reader), the file browser's helper and a label's run. Claude Code's sandbox covers tool calls,
// not the mod's $.process.run. helper/sandbox.py plans the wrapper once a session; tests/test_sandbox.py runs it for
// real. `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { blockLayout, claimsIn } from '../hooks/cite'
import { TIMELINE } from './view-fixtures'

const CWD = '/corpus/wiki'
const SCRIPT = '.thimble-cc-mod/scripts/by.py'
const CARD = {
  id: 'abc123',
  kind: 'bar',
  question: 'Which wikis have the most revisions?',
  x: 'wiki',
  y: 'revisions',
  note: '',
  source: { script: SCRIPT, index: 0 },
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
  ],
  total: 14416,
}
const REPLY = ['[[card:abc123]]', '', 'dse has [[13403|card:abc123#revisions/dse]] revisions.'].join('\n')
const VIEW = `${CWD}/.thimble-cc-mod/views/timeline`
const PROPOSAL = { slug: 'timeline', name: 'Timeline', why: 'w', claims: ['a.jsonl'], unit: 'u', overview: 'o', zoom: 'z', filter: 'f', details: 'd', proposed_by: 'main', build: false, files: 1, ts: '2026-10-04T10:00:00Z' }
/** The plan helper/sandbox.py gives where bubblewrap runs. */
const PLAN = {
  wrap: 'bwrap',
  prefix: ['/usr/bin/bwrap', '--unshare-all', '--ro-bind', CWD, CWD, '--bind', `${CWD}/.thimble-cc-mod`, `${CWD}/.thimble-cc-mod`, '--'],
  python: '/usr/bin/python3.12',
  env: { PYTHONUSERBASE: '/home/u/.local' },
  line: 'run in bubblewrap: it reads this folder, writes only .thimble-cc-mod/, and keeps the network',
  error: '',
}

type Run = { argv: string[]; env: Record<string, string> }
type World = { files: Map<string, string>; runs: Run[]; plans: number; plan: Record<string, unknown> | string; logs: string[]; spawned: number; agents: { id: string; status: string; spawnedBy: string }[]; clock: ReturnType<typeof mock.clock> }

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On): World {
  mock.env(on, {})
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  const w: World = {
    files: new Map([
      [`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(CARD)],
      [`${CWD}/${SCRIPT}`, 'print(1)\n'],
      [`${VIEW}/proposal.json`, JSON.stringify(PROPOSAL)],
      [`${VIEW}/view.json`, JSON.stringify(TIMELINE.spec)],
      [`${VIEW}/rows.json`, JSON.stringify(TIMELINE.data)],
      [`${VIEW}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'built', attempt: 1, round: 2, left: [], at: 0 })],
    ]),
    runs: [],
    plans: 0,
    plan: PLAN,
    logs: [],
    spawned: 0,
    agents: [],
    clock,
  }
  on('env.set', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }) as never)
  on('session.append', () => ({ uuid: 'n1' }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
    if (/\/prompt\/view-\w+\.md$/.test(e.path)) return { value: '{{name}} {{checks}} {{drawings}}' }
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/.thimble-cc-mod/views') ? [{ name: 'timeline', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [] }) as never)
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = e.argv.map(String)
    if (argv.some(a => a.endsWith('/helper/sandbox.py'))) {
      w.plans++
      return ok(typeof w.plan === 'string' ? w.plan : JSON.stringify(w.plan))
    }
    w.runs.push({ argv, env: { ...(e.init?.env ?? {}) } })
    if (argv.some(a => a.endsWith('/helper/resolve.py'))) {
      const req = JSON.parse(e.init?.stdin ?? '{"items":[]}') as { items: { id: string; ref: string }[] }
      return ok(JSON.stringify(req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'value', card: 'abc123', value: '13403', status: 'ok', why: 'the card shows 13403', window: [] }))))
    }
    if (argv.some(a => /\/verify\/v-\w+\.py$/.test(a))) return ok('RESULT: 13403\n')
    if (argv.some(a => a.endsWith('/helper/viewpipe.py'))) return ok('checks passed')
    if (argv.some(a => a.endsWith('/helper/files.py'))) return ok(JSON.stringify({ ok: true, slug: 'files', name: 'files' }))
    if (argv.some(a => a.endsWith('/helper/labels.py'))) return ok(JSON.stringify({ slug: 'w', name: 'w', kind: 'code', values: ['yes', 'no'], counts: { yes: 1, no: 0 }, labeled: 1, total: 1, trial: false, examples: [], errors: [], cards: [], card_output: '', card_error: '', script: '' }))
    return ok('')
  })
  on('agent.spawn', () => {
    w.spawned++
    return { model: 'm', agentId: `agent-${w.spawned}` }
  })
  on('agent.list', () => ({ value: w.agents }) as never)
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('prompt.fill', ($, e) => ({ isFilled: true, text: e.text, cursor: e.text.length }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({}) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['(the engine row)'] }))
  return w
}

type M = Mounted<'terminal'>
const MESSAGE = { plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: REPLY, isFirstOfReply: true } } as never
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, bodyRows: 46 } } as never
const settle = async () => {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** The run of the command whose arguments include `part`. */
const runOf = (w: World, part: string | RegExp) => w.runs.find(r => r.argv.some(a => (typeof part === 'string' ? a === part || a.endsWith(part) : part.test(a))))

/** Wrapped as the plan says: its prefix, then the command with python3 named by the plan's interpreter. */
function expectBoxed(run: Run | undefined, command: string[]): void {
  expect(run).toBeDefined()
  expect(run!.argv).toEqual([...PLAN.prefix, ...command.map((a, i) => (i === 0 && a === 'python3' ? PLAN.python : a))])
  expect(run!.env).toMatchObject(PLAN.env)
}

async function lastReply($: Engine): Promise<void> {
  await $.turn.start({ text: 'q', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: REPLY, durationMs: 5, reason: 'answer' } as never)
}

test("a card's script run again from its panel runs in the sandbox, not with the user's access", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await lastReply($)
  await $.command.run({ command: 'thimble-card', args: '1' } as never)
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'rerun' })
  await pane.unmount()
  await settle()
  expectBoxed(runOf(w, SCRIPT), ['python3', SCRIPT])
  expect(runOf(w, SCRIPT)!.env).toMatchObject({ THIMBLE_CC_MOD_ROOT: CWD, THIMBLE_CC_MOD_ONLY: '0:abc123' })
  // planned once a session
  await $.command.run({ command: 'thimble-card', args: '1' } as never)
  const again = (await $.ui.mount(PANE)) as unknown as M
  await again.press({ key: 'rerun' })
  await again.unmount()
  await settle()
  expect(w.runs.filter(r => r.argv.includes(SCRIPT))).toHaveLength(2)
  expect(w.plans).toBe(1)
})

test('a verification script runs in the sandbox', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE)) as unknown as M
  const el = (await ui.find({ key: 'para-2' })) as unknown as { props: { props: { block: never; chips: never; cols: number } } }
  const p = el.props.props
  const span = blockLayout(p.block, p.chips, p.cols, -1).spans.find(sp => sp.chip === 0)!
  await ui.pointer({ type: 'down', x: span.x0, y: span.line, button: 'left', in: 'para-2' } as never)
  await ui.pointer({ type: 'up', x: span.x0, y: span.line, button: 'left', in: 'para-2' } as never)
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'verify' })
  // the subagent wrote the script; the analyst runs it
  const key = claimsIn(REPLY, 'm1').find(cl => cl.c.ref === 'card:abc123#revisions/dse')!.key
  const script = `.thimble-cc-mod/verify/v-${key}.py`
  w.files.set(`${CWD}/${script}`, 'print("RESULT: 13403")')
  await pane.press({ key: 'rerun' })
  await pane.unmount()
  await settle()
  expectBoxed(runOf(w, script), ['python3', script])
})

test("a view's checks, which run its reader, and the drawings its reviewer reads run in the sandbox", async ($, on) => {
  const w = world(on)
  // a builder taken up after a reload ends: its checks run, then the drawings for the reviewer
  w.files.set(`${VIEW}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'building', attempt: 1, round: 0, agent: 'agent-b', at: 0 }))
  w.agents.push({ id: 'agent-b', status: 'running', spawnedBy: 'thimble-cc-mod' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ turnId: 'b1', agentId: 'agent-b', answer: 'built', durationMs: 5, reason: 'answer' } as never)
  await w.clock.advance(1100)
  await settle()
  const run = runOf(w, '/helper/viewpipe.py')
  expect(run).toBeDefined()
  const viewpipe = run!.argv.find(a => a.endsWith('/helper/viewpipe.py'))!
  expectBoxed(run, ['python3', viewpipe, 'check', 'timeline', '--root', CWD])
  // the drawings the reviewer reads, drawn from files a script can write (or make a link out of the folder)
  const drawn = w.runs.filter(r => r.argv.some(a => a.endsWith('/tools/render_view.mjs')))
  expect(drawn).toHaveLength(2)
  const render = drawn[0]!.argv.find(a => a.endsWith('/tools/render_view.mjs'))!
  expectBoxed(drawn[0], ['node', render, '--spec', `${VIEW}/view.json`, '--rows', `${VIEW}/rows.json`, '--plain', '--height', '48', '--all', '--width', '96'])
})

test('the copy of a view kept before a builder fixes what its reviewer found runs in the sandbox', async ($, on) => {
  const w = world(on)
  w.files.set(`${VIEW}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'reviewing', attempt: 1, round: 0, agent: 'agent-r', at: 0 }))
  w.agents.push({ id: 'agent-r', status: 'running', spawnedBy: 'thimble-cc-mod' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  // the reviewer finds a problem: the view as reviewed is copied into reviewed/, which a script can make a link out of
  // the folder
  await $.turn.complete({ turnId: 'r1', agentId: 'agent-r', answer: '{"problems": ["Events, as it opens: no incident shows"]}', durationMs: 5, reason: 'answer' } as never)
  await w.clock.advance(1100)
  await settle()
  const run = w.runs.find(r => r.argv.some(a => a.endsWith('/helper/viewpipe.py')) && r.argv.includes('keep'))
  expect(run).toBeDefined()
  expectBoxed(run, ['python3', run!.argv.find(a => a.endsWith('/helper/viewpipe.py'))!, 'keep', 'timeline', '--root', CWD])
})

test("the file browser's helper runs in the sandbox", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-files', args: '' } as never)
  await settle()
  const run = runOf(w, '/helper/files.py')
  expect(run).toBeDefined()
  expectBoxed(run, ['python3', run!.argv.find(a => a.endsWith('/helper/files.py'))!, 'tree', '--root', CWD])
})

test("a code label's run, which runs the label's code, runs in the sandbox", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-label', args: 'w kind=code definition="def label(u): return (\'yes\', 1)" paths=a.jsonl --all' } as never)
  await settle()
  const run = w.runs.find(r => r.argv.some(a => a.endsWith('/helper/labels.py')) && r.argv.includes('run'))
  expect(run).toBeDefined()
  const helper = run!.argv.find(a => a.endsWith('/helper/labels.py'))!
  expectBoxed(run, ['python3', helper, ...run!.argv.slice(run!.argv.indexOf(helper) + 1)])
})

test('where no sandbox can run, a script runs as before and the transcript says so once', async ($, on) => {
  const w = world(on)
  w.plan = { ...PLAN, wrap: 'none', prefix: [], python: '/usr/bin/python3.12', env: {}, line: "run unsandboxed, with your user's access (bubblewrap cannot create namespaces here)" }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await lastReply($)
  for (let i = 0; i < 2; i++) {
    await $.command.run({ command: 'thimble-card', args: '1' } as never)
    const pane = (await $.ui.mount(PANE)) as unknown as M
    await pane.press({ key: 'rerun' })
    await pane.unmount()
    await settle()
  }
  expect(w.runs.filter(r => r.argv.includes(SCRIPT)).map(r => r.argv)).toEqual([['python3', SCRIPT], ['python3', SCRIPT]])
  expect(w.logs.filter(l => /unsandboxed/.test(l))).toEqual(["the scripts the mod runs itself (card reruns, verifications, views' checks, labels) run unsandboxed, with your user's access (bubblewrap cannot create namespaces here)"])
})

test('a sandbox named in THIMBLE_KERNEL_WRAP that cannot run: the script does not run, and its card says why', async ($, on) => {
  const w = world(on)
  w.plan = { ...PLAN, wrap: 'srt', prefix: [], error: 'THIMBLE_KERNEL_WRAP=srt names a sandbox that cannot run here (Node is not installed)' }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await lastReply($)
  await $.command.run({ command: 'thimble-card', args: '1' } as never)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'rerun' })
  await pane.unmount()
  await settle()
  expect(runOf(w, SCRIPT)).toBeUndefined()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(JSON.stringify(await pane.drawn())).toContain('names a sandbox that cannot run here')
  await pane.unmount()
})

test('a helper that gives no plan: scripts run as before, and the transcript says why once', async ($, on) => {
  const w = world(on)
  w.plan = 'Traceback (most recent call last): boom'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-files', args: '' } as never)
  await settle()
  expect(runOf(w, '/helper/files.py')!.argv[0]).toBe('python3')
  expect(w.logs.filter(l => /unsandboxed/.test(l))).toHaveLength(1)
  expect(w.logs.find(l => /unsandboxed/.test(l))).toContain('the sandbox helper gave no plan')
})
