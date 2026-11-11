// A citation whose source changed after its check (marks/stale.ts): the pass compares each checked citation's sources
// with their files, a stat first and the kernel only for a stat that changed; a citation whose cited lines changed
// draws stale in the answer, and its card says which file changed and offers x, which checks it again against the files
// as they are now. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { endCheck, launchRepair, noteRow, repairOf, startCheck } from '../marks/checker'
import { examineSources } from '../marks/stale'
import { rowMarks } from '../marks/store'
import { setOptions } from '../settings/features.mjs'
import { staleOf } from '../tray/tray.mjs'
import { test } from './kit'
import { NOTICES, promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : n.type === 'Code' ? String(n.props.source) : '') + textOf(n.children)
}
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  all(n.children, out)
  return out
}

const CITES = { options: { citations: 'auto + verify' } }
const TEXT = 'Of the runs, [12 of 40](#) failed on the p95 check.'
const view = { columns: 100, rows: 40, isFullscreen: true }
const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: view, props: { text, isFirstOfReply: true } }) as never
const above = (maxRows = 20) => ({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} }, viewport: view }) as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never

const FILE = '/made-up/data/runs/summary.txt'
// what the check read: line 4 of the file, as its size, mtime and hash then
const SOURCE = { file: 'runs/summary.txt', path: FILE, line: '4', size: 30, mtime: 1000, sha256: 'a1' }
const QUOTED = {
  n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40', reason: 'Line 4 says 12 failed.',
  evidence: { kind: 'quote', file: 'runs/summary.txt', line: '4', lines: [{ n: 3, text: 'runs: 40' }, { n: 4, text: 'failed: 12', highlight: [8, 10] }, { n: 5, text: 'passed: 28' }] },
  sources: [SOURCE],
}

const settle = () => new Promise(r => setTimeout(r, 5))

test('a citation whose cited lines changed after its check draws stale; its card says which file changed and offers x', CITES, async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-stale' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const kept: Record<string, string> = {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: [QUOTED] }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: TEXT, at: 1 }] }),
  }
  const keptOf = (path: string) => Object.keys(kept).find(k => path.endsWith(`/${k}`))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: keptOf(e.path) ? kept[keptOf(e.path)!] : promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: [...new Set(Object.keys(kept).filter(k => String(e.path).endsWith(`/${k.split('/')[0]}`)).map(k => k.split('/').slice(0, 3).join('/')))].map(k => ({ name: k.split('/')[1], kind: k.split('/').length > 2 ? 'dir' : 'file' })) }))
  on('fs.exists', () => ({ value: false }))
  // the cited file as it stands: as the check read it, until Claude's edit changes its size and mtime
  let file = { kind: 'file', size: 30, mtimeMs: 1000.0004, isLink: false }
  on('fs.stat', (_$: unknown, e: { path: string }) => ({ value: e.path === FILE ? file : { kind: 'missing', size: 0, mtimeMs: 0, isLink: false } }))
  // the kernel: each source it is given, its lines hashed again, now another hash
  const asked: Any[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    const t = tempRun(e.argv)
    if (t) return { value: { ...t, isStdoutTruncated: false, isStderrTruncated: false } }
    const req = JSON.parse(String(e.init?.stdin || '{}'))
    if (Array.isArray(req.sources)) asked.push(req.sources)
    const out = Array.isArray(req.sources) ? { sources: req.sources.map((s: Any) => ({ ...s, size: file.size, mtime: file.mtimeMs, changed: true })) } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  for (const ev of ['env.set', 'config.list', 'ui.panes'] as const) on(ev, () => ({ value: ev === 'env.set' ? {} : [] }) as never)
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('agent.spawn', () => ({ model: 'claude-made-up', agentId: 'agent-repair-1' }) as never)
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => ({ text: e.text }))
  on('tool.call', () => ({ result: '' }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  // Claude's Bash call, after which the hooks compare the sources with their files, waiting for none of it
  let calls = 0
  const bash = async () => {
    await $.tool.call({ tool: 'Bash', tool_use_id: `toolu_${++calls}`, command: 'make report' } as never)
    for (let i = 0; i < 20; i++) await settle()
  }
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)

  // the file stands as the check read it: no kernel call, and the citation is verified
  await bash()
  expect(asked).toEqual([])
  expect(textOf(await $.ui.render(answer('row-t1', TEXT)))).not.toContain('↻')

  // the file changed: its stat goes to the kernel, which finds the cited lines changed
  file = { ...file, size: 31, mtimeMs: 2000 }
  await bash()
  expect(asked.length).toBe(1)
  expect(asked[0][0]).toMatchObject({ path: FILE, line: '4', sha256: 'a1' })
  // its own mark changes in the answer: the words in the warning color, ↻ after them
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  expect(textOf(drawn)).toContain('12 of 40 ↻')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === '12 of 40')?.props).toMatchObject({ color: 'warning', underline: true })
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === ' ↻')?.props).toMatchObject({ color: 'warning' })
  // a stat as last seen goes to the kernel no more
  await bash()
  expect(asked.length).toBe(1)

  // its card: the status says stale, which file changed, and x checks it again
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('↻ stale')
  expect(band).toContain('runs/summary.txt changed after the check.')
  expect(band).toContain('x repair: check it again against the file as it is now')
})

const FORK = 'a0f0e0d0c0b0a0901'
const REPLY = 'The backend listens on [port 8000](#).'
const CHECKED = { file: 'README.md', path: '/made-up/data/README.md', line: '2', size: 40, mtime: 5, sha256: 'b2' }

/** An engine with versioned state, a fork that starts, and a validator that answers `validated(stdin)`. */
function engine(validated: (req: Any) => Any) {
  const files = new Map<string, string>()
  const state = new Map<string, { value: unknown; version: number }>()
  let forks = 0
  const seen = { spawned: [] as Any[], stdin: [] as Any[] }
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { cwd: async () => '/made-up/data', id: async () => 's-stale', messages: async () => [] },
    fs: {
      read: async (p: string) => {
        if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}'
        if (p.endsWith('/prompts/notices.md')) return NOTICES
        if (files.has(p)) return files.get(p)
        throw new Error(`no file ${p}`)
      },
      write: async (p: string, text: string) => { files.set(p, text) },
      list: async () => [],
      exists: async () => false,
      stat: async () => ({ kind: 'file', size: 41, mtimeMs: 9 }),
    },
    process: { run: async (argv: string[], init: Any) => { const t = tempRun(argv); if (t) return t; const req = JSON.parse(String(init?.stdin ?? '{}')); seen.stdin.push(req); return { exitCode: 0, stdout: JSON.stringify(validated(req)), stderr: '' } } },
    agent: { spawn: async (a: Any) => { seen.spawned.push(a); return { model: 'claude-opus-5-5', agentId: `${FORK}${forks++}` } }, list: async () => [] },
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
    clock: { now: async () => (now += 100), after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
  }
  return { $, seen }
}

test('x on a stale citation checks it again against the files as they are now; only its own calls are computed evidence', async () => {
  setOptions({ citations: 'auto + verify' })
  let checks = 0
  const { $, seen } = engine(req => {
    if (Array.isArray(req.sources)) return { sources: req.sources.map((s: Any) => ({ ...s, size: 41, mtime: 9, changed: true })) }
    checks++
    return { parsed: true, results: [{ n: 1, status: checks === 1 ? 'verified' : 'corrected', shown: checks === 1 ? 'port 8000' : 'port 9000', reason: 'line 2 says so', ...(checks === 1 ? { sources: [CHECKED] } : { was: 'port 8000', sources: [{ ...CHECKED, size: 41, mtime: 9, sha256: 'c3' }] }) }] }
  })
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: `${FORK}0`, reason: 'answer', answer: '```json\n[]\n```' })
  expect((await rowMarks($, 'row-1'))!.items[0]).toMatchObject({ status: 'verified', sources: [CHECKED] })
  // a verified citation that reads as its check read it has nothing to repair
  expect(await repairOf($, 'row-1', 1)).toBe(null)
  await examineSources($)
  expect(staleOf((await rowMarks($, 'row-1'))!.items[0]).length).toBe(1)
  const r = await repairOf($, 'row-1', 1)
  expect(r).toMatchObject({ again: true })
  expect((r as Any).prompt).toContain('The analyst pressed x on citation 1, since README.md changed after its first check. What this session read or printed before that change may be out of date. It may stand in an earlier reply than your last.\nCheck it again from the start.')
  expect(await launchRepair($, r as Any, { until: 0, cancelled: false })).toBe('')
  // while it runs it is checked again, its old sources gone
  const running = (await rowMarks($, 'row-1'))!.items[0]!
  expect(running).toMatchObject({ status: 'checking', repair: true })
  expect(running.sources).toBeUndefined()
  await endCheck($, { agentId: `${FORK}1`, reason: 'answer', answer: '```json\n[]\n```' })
  // the validator took only this check's own calls as computed evidence
  expect(seen.stdin.filter(x => x.marks).map(x => !!x.fresh)).toEqual([false, true])
  const done = (await rowMarks($, 'row-1'))!.items[0]!
  expect(done).toMatchObject({ status: 'corrected', shown: 'port 9000', sources: [{ sha256: 'c3' }] })
  expect(staleOf(done)).toEqual([])
})
