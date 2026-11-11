// A citation whose source changed after its check (marks/stale.ts): the pass stats each cited file once, from the index
// of cited files (store.ts citedFiles), and sends the kernel only the citations that rest on a file whose stat changed;
// a citation whose cited lines changed draws stale in the answer, and its card says stale and offers x,
// which checks it again against the files as they are now, and so each x after it until one of those checks passes,
// with the other stale citations of its sentence. Cited lines that only moved take their new numbers. A rewritten
// sentence's card says its status and no more. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { endCheck, launchRepair, noteRow, repairOf, startCheck } from '../marks/checker'
import { rewritesIn } from '../marks/message.js'
import { examineSources } from '../marks/stale'
import { citedFiles, editReply, newReply, replyOf, rowMarks, type MarkItem } from '../marks/store'
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

/** A session whose kept reply holds `item` (reply row-t1, turn t1), with the cited file as `file()` says it stands and
 *  a kernel that answers `cited(req)`; each request it gets is in `asked`. */
async function session($: Any, on: Any, item: Any, file: () => Any, cited: (req: Any) => Any = req => ({ cited: req.cited })) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-stale' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const kept: Record<string, string> = {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: [item] }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: TEXT, at: 1 }] }),
  }
  const keptOf = (path: string) => Object.keys(kept).find(k => path.endsWith(`/${k}`))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: keptOf(e.path) ? kept[keptOf(e.path)!] : promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: [...new Set(Object.keys(kept).filter(k => String(e.path).endsWith(`/${k.split('/')[0]}`)).map(k => k.split('/').slice(0, 3).join('/')))].map(k => ({ name: k.split('/')[1], kind: k.split('/').length > 2 ? 'dir' : 'file' })) }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_$: unknown, e: { path: string }) => ({ value: e.path === FILE ? file() : { kind: 'missing', size: 0, mtimeMs: 0, isLink: false } }))
  const asked: Any[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    const t = tempRun(e.argv)
    if (t) return { value: { ...t, isStdoutTruncated: false, isStderrTruncated: false } }
    const req = JSON.parse(String(e.init?.stdin || '{}'))
    if (Array.isArray(req.cited)) asked.push(req.cited)
    const out = Array.isArray(req.cited) ? cited(req) : {}
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
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  // Claude's Bash call, after which the hooks compare the cited files with what their checks read, waiting for none of
  // it
  let calls = 0
  const bash = async () => {
    await $.tool.call({ tool: 'Bash', tool_use_id: `toolu_${++calls}`, command: 'make report' } as never)
    for (let i = 0; i < 20; i++) await settle()
  }
  return { asked, bash }
}

test('a citation whose cited lines changed after its check draws stale; its card says stale and offers x, and no more', CITES, async ($, on) => {
  // the cited file as it stands: as the check read it, until Claude's edit changes its size and mtime
  let file = { kind: 'file', size: 30, mtimeMs: 1000.0004, isLink: false }
  // the kernel: the cited lines hashed again, now another hash
  const { asked, bash } = await session($, on, QUOTED, () => file, req => ({ cited: req.cited.map((c: Any) => ({ sources: c.sources.map((s: Any) => ({ ...s, changed: true })) })) }))

  // the file stands as the check read it: no kernel call, and the citation is verified
  await bash()
  expect(asked).toEqual([])
  expect(textOf(await $.ui.render(answer('row-t1', TEXT)))).not.toContain('↻')

  // the file changed: the citation that rests on it goes to the kernel, which finds the cited lines changed
  file = { ...file, size: 31, mtimeMs: 2000 }
  await bash()
  expect(asked.length).toBe(1)
  expect(asked[0][0].sources[0]).toMatchObject({ path: FILE, line: '4', sha256: 'a1' })
  expect(asked[0][0].evidence).toMatchObject({ file: 'runs/summary.txt', line: '4' })
  // its own mark changes in the answer: the words in the warning color, ↻ after them
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  expect(textOf(drawn)).toContain('12 of 40 ↻')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === '12 of 40')?.props).toMatchObject({ color: 'warning', underline: true })
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === ' ↻')?.props).toMatchObject({ color: 'warning' })
  // a file as the last pass saw it goes to the kernel no more
  await bash()
  expect(asked.length).toBe(1)

  // its card: the status says stale, x repair first among its keys checks it again, and no line says which file
  // changed or what x does
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('↻ stale  x repair · a ask · 0 close')
  expect(band).not.toContain('changed after the check')
  expect(band).not.toContain('repair:')
  expect(band).toContain('runs/summary.txt · line 4')
})

test("a sentence the check rewrote: its card says verified and shows its evidence, with no line of what the sentence was", CITES, async ($, on) => {
  const rewrite = 'Of the runs, [15 of 40] failed on the p95 check.'
  const item = { ...QUOTED, status: 'corrected', shown: '15 of 40', was: '12 of 40', rewrite, repair: true, evidence: { ...QUOTED.evidence, lines: [{ n: 4, text: 'failed: 15', highlight: [8, 10] }] } }
  await session($, on, item, () => ({ kind: 'file', size: 30, mtimeMs: 1000, isLink: false }))
  expect(textOf(await $.ui.render(answer('row-t1', TEXT)))).toContain('15 of 40')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('✓ verified')
  expect(band).toContain('failed: 15')
  expect(band).not.toContain('repaired')
  expect(band).not.toContain('sentence rewritten')
  expect(band).not.toContain('was ')
})

const FORK = 'a0f0e0d0c0b0a0901'
const REPLY = 'The backend listens on [port 8000](#).'
const CHECKED = { file: 'README.md', path: '/made-up/data/README.md', line: '2', size: 40, mtime: 5, sha256: 'b2' }

/** An engine with versioned state (each read of a reply counted in `reads`), files that stand as `files` says, a fork
 *  that starts, and a validator that answers `validated(stdin)`. */
function engine(validated: (req: Any) => Any, files: Record<string, { size: number; mtimeMs: number }> = {}) {
  const written = new Map<string, string>()
  const state = new Map<string, { value: unknown; version: number }>()
  let forks = 0
  const seen = { spawned: [] as Any[], stdin: [] as Any[], stats: [] as string[], reads: [] as string[] }
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { cwd: async () => '/made-up/data', id: async () => 's-stale', messages: async () => [] },
    fs: {
      read: async (p: string) => {
        if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}'
        if (p.endsWith('/prompts/notices.md')) return NOTICES
        if (written.has(p)) return written.get(p)
        throw new Error(`no file ${p}`)
      },
      write: async (p: string, text: string) => { written.set(p, text) },
      list: async () => [],
      exists: async () => false,
      stat: async (p: string) => {
        seen.stats.push(p)
        const f = files[p] ?? { size: 41, mtimeMs: 9 }
        return { kind: 'file', ...f }
      },
    },
    process: { run: async (argv: string[], init: Any) => { const t = tempRun(argv); if (t) return t; const req = JSON.parse(String(init?.stdin ?? '{}')); seen.stdin.push(req); return { exitCode: 0, stdout: JSON.stringify(validated(req)), stderr: '' } } },
    agent: { spawn: async (a: Any) => { seen.spawned.push(a); return { model: 'claude-opus-5-5', agentId: `${FORK}${forks++}` } }, list: async () => [] },
    state: {
      get: async (k: Any) => {
        if (k?.key === 'marks' && k.id) seen.reads.push(k.id)
        return state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 }
      },
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
    if (Array.isArray(req.cited)) return { cited: req.cited.map((c: Any) => ({ sources: c.sources.map((s: Any) => ({ ...s, changed: true })) })) }
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
  // a copy of the file kept from before the change is no evidence either
  expect((r as Any).prompt).toContain('The analyst pressed x on citation 1, since README.md changed after its first check. What this session read or printed before that change may be out of date. A copy of a file from before the change is no evidence. It may stand in an earlier reply than your last.\nCheck it again from the start.')
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
  expect(done.fresh).toBeUndefined()
})

test('a stale citation whose check again failed stays on checks of the files as they are now, until one passes', async () => {
  setOptions({ citations: 'auto + verify' })
  const results = [
    { n: 1, status: 'verified', shown: 'port 8000', reason: 'line 2 says so', sources: [CHECKED] },
    { n: 1, status: 'failed', failedBy: 'check', shown: 'port 8000', reason: 'Line 2 now says port 9000.' },
    { n: 1, status: 'corrected', shown: 'port 9000', was: 'port 8000', reason: 'line 2 says so', sources: [{ ...CHECKED, size: 41, mtime: 9, sha256: 'c3' }] },
  ]
  const { $, seen } = engine(req => (Array.isArray(req.cited)
    ? { cited: req.cited.map((c: Any) => ({ sources: c.sources.map((s: Any) => ({ ...s, changed: true })) })) }
    : { parsed: true, results: [results.shift()] }))
  await noteRow($, 'row-1', REPLY)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: `${FORK}0`, reason: 'answer', answer: '```json\n[]\n```' })
  await examineSources($)
  // x on the stale citation: its check fails, and the citation keeps the file that changed
  await launchRepair($, (await repairOf($, 'row-1', 1)) as Any, { until: 0, cancelled: false })
  await endCheck($, { agentId: `${FORK}1`, reason: 'answer', answer: '```json\n[]\n```' })
  const failed = (await rowMarks($, 'row-1'))!.items[0]!
  expect(failed).toMatchObject({ status: 'failed', fresh: ['README.md'] })
  // x again: the file as it is now, the session's earlier output no evidence, as for the first x
  const again = await repairOf($, 'row-1', 1)
  expect(again).toMatchObject({ again: true })
  expect((again as Any).prompt).toContain('The analyst pressed x on citation 1, since README.md changed after its first check.')
  await launchRepair($, again as Any, { until: 0, cancelled: false })
  await endCheck($, { agentId: `${FORK}2`, reason: 'answer', answer: '```json\n[]\n```' })
  expect(seen.stdin.filter(x => x.marks).map(x => !!x.fresh)).toEqual([false, true, true])
  // that check passed: the citation is checked as any is from now on
  const done = (await rowMarks($, 'row-1'))!.items[0]!
  expect(done).toMatchObject({ status: 'corrected', shown: 'port 9000' })
  expect(done.fresh).toBeUndefined()
})

test('x on one of two stale citations of a sentence checks both in one check, and the one rewrite of the sentence repairs both', async () => {
  setOptions({ citations: 'auto + verify' })
  const reply = 'The app runs on [port 8000](#): start it, then open [http://localhost:8000](#).'
  const url = { ...CHECKED, line: '3', sha256: 'b3' }
  const rewrite = 'The app runs on [port 9000]: start it, then open [http://localhost:9000].'
  let checks = 0
  const { $, seen } = engine(req => {
    if (Array.isArray(req.cited)) return { cited: req.cited.map((c: Any) => ({ sources: c.sources.map((s: Any) => ({ ...s, changed: true })) })) }
    if (++checks === 1) return { parsed: true, results: [{ n: 1, status: 'verified', shown: 'port 8000', sources: [CHECKED] }, { n: 2, status: 'verified', shown: 'http://localhost:8000', sources: [url] }] }
    return { parsed: true, results: [
      { n: 1, status: 'corrected', shown: 'port 9000', was: 'port 8000', rewrite, reason: 'line 2 says 9000', sources: [{ ...CHECKED, sha256: 'c2' }] },
      { n: 2, status: 'corrected', shown: 'http://localhost:9000', was: 'http://localhost:8000', rewrite, reason: 'line 3 says 9000', sources: [{ ...url, sha256: 'c3' }] },
    ] }
  })
  await noteRow($, 'row-1', reply)
  await startCheck($, { turnId: 't-1', reason: 'answer' })
  await endCheck($, { agentId: `${FORK}0`, reason: 'answer', answer: '```json\n[]\n```' })
  await examineSources($)
  expect((await rowMarks($, 'row-1'))!.items.map(m => staleOf(m).length)).toEqual([1, 1])
  // x on the first: the check takes the second with it, and its request says why
  const r = await repairOf($, 'row-1', 1)
  expect(r).toMatchObject({ n: 1, also: [2], again: true })
  const sentence = 'The app runs on [port 8000]: start it, then open [http://localhost:8000].'
  expect((r as Any).prompt).toContain(`CHECK\n1. [port 8000] in: ${sentence}\n2. [http://localhost:8000] in: ${sentence}`)
  expect((r as Any).prompt).toContain('It may stand in an earlier reply than your last. Citation 2 stands in the same sentence, and README.md changed after its first check too. Check it again as well.\nCheck it again from the start.')
  expect(await launchRepair($, r as Any, { until: 0, cancelled: false })).toBe('')
  expect((await rowMarks($, 'row-1'))!.items.map(m => m.status)).toEqual(['checking', 'checking'])
  // a second x on either finds the check running
  expect(await repairOf($, 'row-1', 2)).toBe(null)
  await endCheck($, { agentId: `${FORK}1`, reason: 'answer', answer: '```json\n[]\n```' })
  const last = seen.stdin.filter(x => x.marks).pop()
  expect(last.marks.map((m: Any) => m.n)).toEqual([1, 2])
  expect(last.fresh).toBe(true)
  // both repaired, the one rewrite in place of the sentence
  const items = (await rowMarks($, 'row-1'))!.items
  expect(items.map(m => [m.status, m.shown, staleOf(m).length])).toEqual([['corrected', 'port 9000', 0], ['corrected', 'http://localhost:9000', 0]])
  const shown = rewritesIn(reply, items)
  expect(shown.text).toBe('The app runs on [port 9000](#): start it, then open [http://localhost:9000](#).')
  expect([...shown.placed]).toEqual([0, 1])
})

test('a pass stats each cited file once and reads only the replies whose citations rest on a file that changed; moved lines take their new numbers', async () => {
  setOptions({ citations: 'auto + verify' })
  const A = { file: 'a.md', path: '/made-up/data/a.md', line: '3', size: 10, mtime: 1, sha256: 'aa' }
  const B = { file: 'b.md', path: '/made-up/data/b.md', line: '7', size: 20, mtime: 2, sha256: 'bb' }
  const place = (s: Any, n: number) => ({ kind: 'quote', file: s.file, line: String(n), lines: [{ n, text: 'the words', highlight: [4, 9] }] })
  const mark = (n: number, s: Any): MarkItem => ({ n, row: 'r', words: 'the words', start: 0, end: 9, sentence: 's', status: 'verified', shown: 'the words', evidence: place(s, Number(s.line)) as never, sources: [s] })
  const files: Record<string, { size: number; mtimeMs: number }> = { [A.path]: { size: 10, mtimeMs: 1 }, [B.path]: { size: 20, mtimeMs: 2 } }
  // the kernel finds b.md's cited line two lines down, as it read
  const { $, seen } = engine(req => ({ cited: req.cited.map((c: Any) => ({ sources: c.sources.map((s: Any) => ({ ...s, line: '9' })), evidence: { ...c.evidence, line: '9', lines: [{ n: 9, text: 'the words', highlight: [4, 9] }] } })) }), files)
  for (const [key, items] of [['row-a', [mark(1, A), mark(2, A)]], ['row-b', [mark(1, B)]]] as const) {
    await newReply($, { key, turnId: key, rows: [key], startedAt: 0, settledAt: 1, items: [] })
    await editReply($, key, r => ({ ...r, items: [...items] }))
  }
  expect(Object.keys(await citedFiles($)).sort()).toEqual([A.path, B.path])
  expect((await citedFiles($))[A.path]!.by).toEqual({ 'row-a': [1, 2] })

  // nothing changed: a stat of each file, no reply read, no kernel call
  seen.reads.length = 0
  await examineSources($)
  expect(seen.stats.sort()).toEqual([A.path, B.path])
  expect(seen.reads).toEqual([])
  expect(seen.stdin).toEqual([])

  // b.md changed: only its citation goes to the kernel, and only its reply is read
  files[B.path] = { size: 23, mtimeMs: 3 }
  seen.stats.length = 0
  await examineSources($)
  expect(seen.stats.sort()).toEqual([A.path, B.path])
  expect(seen.stdin.length).toBe(1)
  expect(seen.stdin[0].cited.map((c: Any) => c.sources.map((s: Any) => s.path))).toEqual([[B.path]])
  expect(new Set(seen.reads)).toEqual(new Set(['row-b']))
  // its lines moved: not stale, at their new numbers in its sources and in the place it shows
  const b = (await replyOf($, 'row-b'))!.items[0]!
  expect(staleOf(b)).toEqual([])
  expect(b.sources![0]).toMatchObject({ line: '9', sha256: 'bb' })
  expect(b.evidence).toMatchObject({ line: '9', lines: [{ n: 9 }] })
  expect((await citedFiles($))[B.path]!.seen).toEqual({ size: 23, mtime: 3 })

  // a check of it again takes it off the index while it runs; a file no citation rests on leaves the index
  await editReply($, 'row-b', r => ({ ...r, items: r.items.map(m => { const { sources: _s, ...rest } = m; return { ...rest, status: 'checking' as const } }) }))
  expect(Object.keys(await citedFiles($))).toEqual([A.path])
})
