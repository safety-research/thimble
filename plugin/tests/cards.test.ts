// Cards' hooks (cards/): a card call keeps the card and answers what it read and its text copy; the call's row draws
// the one Client with the runner's tree; a new version draws in the card's place; a key at an empty prompt, and a burst
// of keys, reach the card on screen that takes them; a card a designer fork drew draws under its answer; a ready kind's
// call keeps its data (the call's fields over the last call's, an example's records read from their files) and says
// what to fix in its data. The runner is answered here, at http.fetch (cards/test/runner.test.mjs and kinds.test.mjs
// test the real one).
// All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import Card from '../cards/client'
import { cardWidth, rowsCut, rowsWord } from '../cards/draw'
import { STUB } from '../cards/kinds.js'
import { callLine } from '../cards/register'
import { treeRows } from '../core/trail.mjs'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const DATA = '/made-up/data'
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 200, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 200, rows: 40, isFullscreen: true } } as never
const TOOL = 'mcp__thimble__card'
const TREE = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['ada 3'] }, { t: 'Text', p: {}, c: ['bram 5'] }] }
const SORTED = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['bram 5'] }, { t: 'Text', p: {}, c: ['ada 3'] }] }
// a bar chart whose second bar a click selected, marked with ▸ as the card guide asks
const PICKED = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['  ada  ███ 3'] }, { t: 'Text', p: {}, c: ['▸ bram █████ 5'] }] }
const VIEW = 'const keys = "o"\nfunction onKey(k, s) { s.setState({ sorted: true }) }\nfunction view(p, s) { return s.elements.Text({ children: "x" }) }'
// a card of 42 rows, one per run: taller than the 30 rows its frame shows (draw.ts CARD_ROWS)
const TALL_LINES = Array.from({ length: 42 }, (_, i) => `run ${i + 1}  passed`)
const TALL = { t: 'Box', p: { flexDirection: 'column' }, c: TALL_LINES.map(l => ({ t: 'Text', p: {}, c: [l] })) }

function elements(n: Any, out: Any[] = []): Any[] {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { for (const x of n) elements(x, out); return out }
  out.push(n)
  elements(n.props?.children, out)
  elements(n.children, out)
  return out
}

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

function world(on: Any, o: { crash?: string; ask?: boolean; sandbox?: Record<string, unknown>; firstSetupHangs?: boolean; noRunner?: boolean; runnerEnds?: { stderr: string; code: number | null; signal: string | null }; runnerHangs?: boolean; deadRunner?: boolean; refused?: boolean; wide?: boolean; env?: Record<string, string>; stat?: (path: string) => Any; prompts?: Record<string, string>; cwd?: string } = {}) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', ...o.env })
  const clock = mock.clock(on, { now: 0 })
  const files: Record<string, string> = {}
  const asked: string[] = []
  // what each load asked the runner for
  const loads: Any[] = []
  // the width the runner holds the card at, which each of its answers says, as the runner does; with `wide`, its
  // drawings show that width and whether a key sorted them
  let runnerWidth = 0
  let sorted = false
  let seq = 0
  // a request the test holds (hold, which answers once it came): the runner did it (its width, its seq), and its answer
  // comes when the test lets it go (release), after the answers of the requests that came later
  const held: { op: string; go: () => void; came: () => void } = { op: '', go: () => undefined, came: () => undefined }
  // Claude Code's theme setting (/config), and the theme the runner was last asked to draw in (a light one says so)
  const look = { theme: 'dark', runner: 'dark' }
  on('config.list', () => ({ value: [{ key: 'theme', value: look.theme, isLocked: false }] }) as never)
  const laidOut = () => ({ t: 'Text', p: {}, c: [`${sorted ? 'sorted' : 'rows'} at ${runnerWidth}${look.runner === 'light' ? ' light' : ''}`] })
  on('session.id', () => ({ value: 's-cards' }))
  // the shell's working folder, which a `cd` moves (`cwd`), and the folder the session started in
  on('session.cwd', () => ({ value: o.cwd ?? DATA }))
  on('session.root', () => ({ value: DATA }))
  on('session.usage', () => ({ value: {} }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('session.end', () => ({ sessionId: 's-cards' }) as never)
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__thimble__${e.name}` } }))
  // a prompt text a test gives (`prompts`, by its name) with its placeholders, else the stub's
  const prompt = (path: string) => Object.entries(o.prompts ?? {}).find(([k]) => path.endsWith(`/prompts/${k}.md`))?.[1]
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? prompt(e.path) ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  const dirs: Record<string, string[]> = {}
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: (dirs[e.path ?? ''] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  // a path's real path, `.` and `..` folded
  const real = (p: string) => `/${p.split('/').reduce((a: string[], x) => (x === '..' ? a.slice(0, -1) : x && x !== '.' ? [...a, x] : a), []).join('/')}`
  // when the runner's code on disk was last changed (a test patches it in place)
  const code = { mtimeMs: 1 }
  on('fs.stat', (_$: unknown, e: { path: string }) => ({
    // escape.json looks local but its real target is outside every allowed root (a symlink out of the folder); so does
    // link.json in the temp folder; `stat` gives a test's own files first
    value: o.stat?.(e.path) ?? (e.path.endsWith('/cards/argv.mjs') ? { kind: 'file', size: 64, mtimeMs: code.mtimeMs, isLink: false, realPath: e.path }
      : e.path === `${DATA}/escape.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: true, realPath: '/etc/shadow' }
      : e.path.endsWith('/link.json') ? { kind: 'file', size: 64, mtimeMs: 0, isLink: true, realPath: '/made-up/home/.ssh/id' }
        : e.path === `${DATA}/runs.json` || e.path === `${DATA}/secret.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: false, realPath: e.path }
          : e.path === DATA || e.path.startsWith('/made-up/tmp') ? { kind: e.path.endsWith('.json') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: real(e.path) }
            : { kind: 'missing', size: 0, mtimeMs: 0, isLink: false }),
  }))
  const spawned: string[][] = []
  const runs: string[][] = []
  // the forks a card's header starts (cards/head.ts)
  const forks: Any[] = []
  on('agent.spawn', (_$: unknown, e: Any) => { forks.push(e); return { model: 'claude-made-up' } as never })
  let setups = 0
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    // a copy of a made-up file (a card's rows into its version's folder) holds what the file holds; sed prints its
    // lines and grep finds words in it, as ready.ts reads a record of a file too large to read whole
    if (e.argv[0] === 'cp' && e.argv[2]! in files) files[e.argv[3]!] = files[e.argv[2]!]!
    const lines = (path: string) => files[path]!.split('\n')
    const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'sed' && e.argv[4]! in files) {
      const [, a, b] = /^(\d+),(\d+)p;/.exec(e.argv[2]!)!
      return ran(lines(e.argv[4]!).slice(Number(a) - 1, Number(b)).map(l => `${l}\n`).join(''))
    }
    if (e.argv[0] === 'grep' && e.argv[7]! in files) {
      const hits = lines(e.argv[7]!).map((l, i) => (l.includes(e.argv[6]!) ? `${i + 1}:${l}\n` : '')).filter(Boolean)
      return ran(hits.join(''), hits.length ? 0 : 1)
    }
    // the session start's setup.mjs installs srt on a slow network, and has not answered yet
    if (String(e.argv[1] ?? '').endsWith('/sandbox/setup.mjs') && setups++ === 0 && o.firstSetupHangs) return new Promise(() => undefined) as never
    return { value: { ...(tempRun(e.argv, o.sandbox) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$: unknown, e: { argv: string[] }) {
    spawned.push(e.argv)
    // a runner that ends before it listens, and says why; one that neither listens nor ends while the hooks wait
    if (o.runnerEnds) {
      yield { stream: 'stderr', text: o.runnerEnds.stderr }
      return { value: { code: o.runnerEnds.code, signal: o.runnerEnds.signal } }
    }
    // the one that hangs prints a line each second: a wait held through all of the hooks' 5 s of tries is let go once
    // it was held 10 s of real time (a hook's budget), as on a busy machine, and the runner then seems to end
    if (o.runnerHangs) for (;;) { await clock.sleep(1000); yield { stream: 'stdout', text: 'starting\n' } }
    return { value: { code: 0, signal: null } }
  })
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('http.fetch', (_$: unknown, e: { url: string; init?: { body?: string } }) => {
    const op = e.url.replace('http://runner/', '')
    asked.push(op)
    // no runner listens when the sandbox cannot start
    if (o.sandbox?.ok === false) throw new Error('made-up: no such socket')
    // Claude Code refuses the plugin's requests, its Unix socket's too
    if (o.refused) return { deny: '$.http.fetch: refused: nonessential network traffic is disabled for this session' }
    // no runner listens until the hooks start one; with `runnerEnds` or `runnerHangs`, none ever does
    if (o.noRunner && op === 'ping' && !spawned.length) throw new Error('made-up: no such socket')
    if ((o.runnerEnds || o.runnerHangs) && op === 'ping') throw new Error('made-up: no such socket')
    if (o.deadRunner && op === 'ping') throw new Error('made-up: no such socket')
    // a view that takes all the runner's memory: the socket closes while it answers
    if (op === o.crash) throw new Error('made-up: socket hang up')
    const body = JSON.parse(e.init?.body || '{}')
    if (op === 'load') loads.push(body)
    const reply = (answer: object) => {
      const r = { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
      if (held.op !== op) return r
      held.op = ''
      held.came()
      return new Promise(resolve => { held.go = () => resolve(r) })
    }
    // a view that does not parse, and one that throws at a narrow width
    if (op === 'load' && String(body.view).includes('BROKEN')) return reply({ ok: false, phase: 'view', error: 'the view does not parse (line 1): Unexpected token' })
    if (op === 'draw' && body.width < 30) return reply({ ok: false, phase: 'draw', error: 'line 4: Invalid count value: -1' })
    if ((op === 'load' || op === 'draw') && body.width) runnerWidth = body.width
    if (body.theme === 'dark' || body.theme === 'light') look.runner = body.theme
    if (o.wide && op === 'key' && body.key === 'o') sorted = true
    if (o.wide && op !== 'load' && op !== 'copy' && op !== 'ping') return reply({ ok: true, handled: body.key === 'o', tree: laidOut(), width: runnerWidth, state: 'null', seq: ++seq })
    // a view whose tree the terminal refuses: a Text whose bold is not a boolean; a view, or a ready kind's data, that
    // says TALL draws taller than the frame
    const tall = String(body.view ?? '').includes('TALL') || String(files[body.rows] ?? '').includes('TALL')
    // a view of `// ROWS n`: n rows, one per run
    const many = Number(/\/\/ ROWS (\d+)/.exec(String(body.view ?? ''))?.[1] ?? 0)
    const runs = many ? Array.from({ length: many }, (_, i) => `run ${i + 1}  passed`) : null
    const tree = String(body.view ?? '').includes('BOLD') ? { t: 'Text', p: { bold: 'yes' }, c: ['ada 3'] } : String(body.view ?? '').includes('SELECTED') ? PICKED
      : runs ? { t: 'Box', p: { flexDirection: 'column' }, c: runs.map(l => ({ t: 'Text', p: {}, c: [l] })) } : tall ? TALL : TREE
    const answers: Record<string, unknown> = {
      ping: { ok: true },
      load: {
        ok: true, tree, width: runnerWidth, state: 'null', keys: /const keys = "([^"]*)"/.exec(String(body.view ?? ''))?.[1] ?? '', lines: runs ?? (tall ? TALL_LINES : ['ada 3', 'bram 5']), cut: [], summary: { rows: 2, read: '2 rows', columns: ['name', 'score'], first: '{"name":"ada","score":3}' },
      },
      key: { ok: true, handled: body.key === 'o', tree: SORTED, width: runnerWidth, state: '{"sorted":true}' },
      draw: { ok: true, tree: TREE, width: runnerWidth, state: 'null' },
      // with `wide`, a copy says the width it is laid out at
      copy: { ok: true, lines: o.wide ? [`copy at ${body.width}`] : ['ada 3', 'bram 5'], cut: [] },
      undo: { ok: true, tree: TREE, width: runnerWidth, state: 'null' },
      // a click on words that stand on no item
      pick: { ok: true, handled: false },
    }
    return reply({ ...(answers[op] ?? { ok: false, error: 'no such request' }) as object, ...(o.wide ? { seq: ++seq } : {}) })
  })
  // the person's permission rules: a deny rule for reading `secret.json`; with `ask`, the mode asks about every file
  // outside the folder, and a rule of the person's asks about made-up/tmp/mine
  on('tool.check', (_$: unknown, e: Any) => (e.tool === 'Read' && String(e.input?.file_path).endsWith('secret.json') ? { decision: 'deny', reason: 'a made-up deny rule', rule: 'Read(./secret.json)' }
    : o.ask && String(e.input?.file_path).startsWith('/made-up/tmp/mine') ? { decision: 'ask', rule: 'Read(/made-up/tmp/mine/**)' }
      : o.ask && !String(e.input?.file_path).startsWith(DATA) ? { decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' } : { decision: 'allow' }) as never)
  // the words of each answer the engine draws itself, as the hooks hand them to it
  const answers: string[] = []
  on('ui.render', (_$: unknown, e: Any) => {
    if (e.component === 'AssistantMessage') answers.push(String(e.props?.text ?? ''))
    return { type: 'Text', props: {}, children: [e.props?.output ?? 'the engine'] } as never
  })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const hold = (op: string) => new Promise<void>(resolve => { held.op = op; held.came = resolve })
  const release = () => held.go()
  return { files, asked, loads, dirs, clock, spawned, runs, look, forks, answers, code, hold, release }
}

const callRow = (toolUseId: string, input: Record<string, unknown>) => ({
  component: 'ToolUse', surface: 'terminal', requestId: toolUseId, viewport: { columns: 100, rows: 40, isFullscreen: true },
  props: { tool_use_id: toolUseId, tool: TOOL, input, isRunning: false, isErrored: false, isInterrupted: false },
}) as never

/** The row as the terminal shows it: its card's Client runs, and posts that it is drawn (client.tsx). */
const shown = ($: Any, row: Any) => $.ui.mount({ plugin: 'thimble', ...row })

test('a card call keeps the card and answers what it read and what it draws; its row draws the Client', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1', ...input } as never)) as Any
  const text = String(r.result)
  expect(text).toContain('“Scores” is drawn where this call stands')
  expect(text).toContain('It read 2 rows from runs.json, with the columns name, score.')
  expect(text).toContain('ada 3\nbram 5')
  // one request draws the card and makes its copy
  expect(w.asked).toEqual(['ping', 'load'])
  const meta = Object.entries(w.files).find(([p]) => p.endsWith('/meta.json'))
  expect(JSON.parse(meta![1]).keys).toEqual(['o'])
  expect(Object.keys(w.files).filter(p => /\/v1\/view\.js$/.test(p))).toEqual([expect.any(String)])

  const row = await $.ui.render(callRow('toolu_made_up_1', input))
  const client = elements(row).find(n => n.type === 'Client')
  expect(client?.props.module).toContain('client.tsx')
  expect(client?.props.props.tree).toEqual(TREE)
  // what a part of it shows under the pointer: thimble's tint behind it and its color on a bar, never white inverse
  expect(client?.props.props.tint).toMatch(/^#[0-9a-f]{6}$/)
  expect(client?.props.props.accent).toBe('merged')
  // once its Client says it is drawn, the card is on screen and lists the keys that reach it
  const id = JSON.parse(meta![1]).id
  await shown($, callRow('toolu_made_up_1', input))
  // the frame holds the title and the card, with no line of thimble's own under or over it
  expect(textOf(await $.ui.render(callRow('toolu_made_up_1', input)))).not.toContain('at an empty prompt')

  // a new version takes the card's place, under the first call; the newer call points to it
  const r2 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1b', ...input, id } as never)) as Any
  expect(String(r2.result)).toContain('Version 2 of “Scores” is drawn in place of version 1, under the call that first drew the card')
  const second = await $.ui.render(callRow('toolu_made_up_1b', input))
  expect(elements(second).some(n => n.type === 'Client')).toBe(false)
  const first = await $.ui.render(callRow('toolu_made_up_1', input))
  expect(elements(first).some(n => n.type === 'Client')).toBe(true)
  expect(textOf(first)).not.toContain('version 2')
  const resultOf = (toolUseId: string) => $.ui.render({ ...(callRow(toolUseId, input) as Any), component: 'ToolResult', props: { tool_use_id: toolUseId, tool: TOOL, output: 'the copy', isExpanded: false } } as never)
  // each call's row is one line that says what it did; the result under it draws nothing (Claude's copy is in ctrl+o)
  const lineOf = async (toolUseId: string, call: Record<string, unknown>) => textOf(await $.ui.render(callRow(toolUseId, call)))
  expect(textOf(await resultOf('toolu_made_up_1b'))).toBe('')
  expect(await lineOf('toolu_made_up_1b', { ...input, id })).toBe('● Changed card “Scores” to version 2 (new title, new rows, new view) · ↑ shown in its place above')
  expect((await lineOf('toolu_made_up_1', input)).startsWith('● Drew card “Scores” · 2 rows from runs.json')).toBe(true)

  // a small change: edits to the view, its rows and title kept (no `view`, no `data`, no `title`)
  const r3 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1c', id, edits: [{ old: 'children: "x"', new: 'children: "y"' }] } as never)) as Any
  expect(String(r3.result)).toContain('Version 3 of “Scores” is drawn')
  expect(String(r3.result)).toContain('It read 2 rows from runs.json')
  expect(Object.entries(w.files).find(([p]) => /\/v3\/view\.js$/.test(p))?.[1]).toBe(VIEW.replace('children: "x"', 'children: "y"'))
  expect(await lineOf('toolu_made_up_1b', { ...input, id })).toBe('● Changed card “Scores” to version 2 (new title, new rows, new view) · ↑ shown in its place above, now version 3')
  expect(await lineOf('toolu_made_up_1c', { id, edits: [{ old: 'children: "x"', new: 'children: "y"' }] })).toBe('● Changed card “Scores” to version 3 (1 edit to its view) · ↑ shown in its place above')
  // an edit whose text is not in the view draws nothing, and says why
  const r4 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1d', id, edits: [{ old: 'no such text', new: 'z' }] } as never)) as Any
  expect(String(r4.result)).toContain('edit 1: its `old` text is not in the view of your last call')
  // a new card needs a title
  const r5 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1e', data: 'runs.json', view: VIEW } as never)) as Any
  expect(String(r5.result)).toContain('`title` is empty')
  // a call with no argument at all (its input did not parse): it says so, and blames no one field
  const r6 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1f' } as never)) as Any
  expect(String(r6.result)).toBe('The card did not draw: the call\'s input was empty or did not parse as JSON. Send the call again, whole.')
})

test('a call\'s line names no title until the call\'s input names one; then it names the card', async () => {
  // Claude Code draws the call's row while its input still streams in: no word stands in quotes as if it were a title
  expect(callLine({}, null, 'toolu_made_up_s1', true)).not.toContain('“')
  expect(callLine({ data: 'runs.json' }, null, 'toolu_made_up_s1', true)).not.toContain('“')
  expect(callLine({ title: 'Scores' }, null, 'toolu_made_up_s1', true)).toContain('“Scores”')
  // a call that changes a card names the card it knows
  expect(callLine({ id: 'c0123456789ab', edits: [{ old: 'a', new: 'b' }] }, { title: 'Scores', calls: {} }, 'toolu_made_up_s2', true)).toContain('“Scores”')
  // a new card refused before it had a title says why, and names no title
  const refused = callLine({ view: 'x' }, { title: '', calls: { toolu_made_up_s3: { version: 0, error: '`title` is empty' } } }, 'toolu_made_up_s3', false)
  expect(refused).toContain('did not draw: `title` is empty')
  expect(refused).not.toContain('“')
})

test('a call with a card\'s id alone moves the card as it is to that call; the earlier call points down to it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_p1', ...input } as never)) as Any
  const id = /Its id is "(c[0-9a-f]+)"/.exec(String(r.result))![1]
  const before = w.asked.length
  const placed = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_p2', id } as never)) as Any
  expect(String(placed.result)).toContain('“Scores” (version 1) is drawn here now')
  // nothing runs again
  expect(w.asked.length).toBe(before)
  expect(elements(await $.ui.render(callRow('toolu_made_up_p2', { id }))).some(n => n.type === 'Client')).toBe(true)
  expect(elements(await $.ui.render(callRow('toolu_made_up_p1', input))).some(n => n.type === 'Client')).toBe(false)
  const resultOf = (toolUseId: string) => $.ui.render({ ...(callRow(toolUseId, input) as Any), component: 'ToolResult', props: { tool_use_id: toolUseId, tool: TOOL, output: 'the copy', isExpanded: false } } as never)
  expect(textOf(await resultOf('toolu_made_up_p1'))).toBe('')
  expect(textOf(await $.ui.render(callRow('toolu_made_up_p1', input)))).toBe('● Drew card “Scores” · ↓ shown further down')
  expect(textOf(await $.ui.render(callRow('toolu_made_up_p2', { id }))).startsWith('● Moved card “Scores” here · 2 rows from runs.json')).toBe(true)
  // a later version draws in the new place
  const r3 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_p3', id, edits: [{ old: 'children: "x"', new: 'children: "y"' }] } as never)) as Any
  expect(String(r3.result)).toContain('Version 2 of “Scores” is drawn in place of version 1')
  expect(elements(await $.ui.render(callRow('toolu_made_up_p2', { id }))).some(n => n.type === 'Client')).toBe(true)
})

test('a line of the reply that holds only a card\'s link draws the card there; its call folds to one line', async ($, on) => {
  world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_q1', ...input } as never)) as Any
  const id = /Its id is "(c[0-9a-f]+)"/.exec(String(r.result))![1]
  const text = `Ada leads.\n\n[Scores](card:${id})\n\nBram is second.`
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-made-up-q' } as never)
  const reply = await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: 'row-made-up-q', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } } as never)
  expect(elements(reply).some(n => n.type === 'Client')).toBe(true)
  // it stands in the text's column, 2 columns in, so it is 2 narrower than a card under an answer: its frame keeps the
  // 2 columns at the right free
  expect(elements(reply).find(n => n.type === 'Client')?.props.width).toBe(cardWidth(98))
  expect(textOf(reply)).not.toContain('card:')
  expect(elements(await $.ui.render(callRow('toolu_made_up_q1', input))).some(n => n.type === 'Client')).toBe(false)
  const res = await $.ui.render({ ...(callRow('toolu_made_up_q1', input) as Any), component: 'ToolResult', props: { tool_use_id: 'toolu_made_up_q1', tool: TOOL, output: 'the copy', isExpanded: false } } as never)
  expect(textOf(res)).toBe('')
  expect(textOf(await $.ui.render(callRow('toolu_made_up_q1', input)))).toBe('● Drew card “Scores” · ↓ shown in the answer')
  // a later reply that places it again: the card stands there, and the earlier reply points to it
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `Sorted.\n\n[Scores](card:${id})` }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-made-up-q2' } as never)
  const again = await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: 'row-made-up-q', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } } as never)
  expect(elements(again).some(n => n.type === 'Client')).toBe(false)
  expect(textOf(again)).toContain('↓ “Scores” is drawn further down')
  // a later call changes it where it stands: its line points up to the answer above
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_q3', id, edits: [{ old: 'children: "x"', new: 'children: "y"' }] } as never)
  expect(textOf(await $.ui.render(callRow('toolu_made_up_q3', { id, edits: [{ old: 'children: "x"', new: 'children: "y"' }] })))).toBe('● Changed card “Scores” to version 2 (1 edit to its view) · ↑ shown in the answer above')
})

test('a card\'s link among an answer\'s words reads as the card\'s title, whether Claude Code or thimble draws the words', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_r1', ...input } as never)) as Any
  const id = /Its id is "(c[0-9a-f]+)"/.exec(String(r.result))![1]
  const row = (requestId: string, text: string) => ({ component: 'AssistantMessage', surface: 'terminal', requestId, viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } }) as never
  const append = (uuid: string, text: string) => $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid } as never)
  // nothing of thimble's to draw in the answer: Claude Code draws it, given the link as its words
  const text = `Ada leads; the scores are in the card above ([Scores](card:${id})).`
  await append('row-made-up-r1', text)
  await $.ui.render(row('row-made-up-r1', text))
  expect(w.answers.at(-1)).toBe('Ada leads; the scores are in the card above (Scores).')
  // an answer that also places the card on a line of its own: thimble draws it, and its words name the card alone
  const placed = `Ada leads.\n\n[Scores](card:${id})\n\nThe card above ([Scores](card:${id})) sorts by score.`
  await append('row-made-up-r2', placed)
  const reply = await $.ui.render(row('row-made-up-r2', placed))
  expect(elements(reply).some(n => n.type === 'Client')).toBe(true)
  const words = elements(reply).filter(n => n.type === 'Markdown').map(n => String(n.props.text)).join('\n')
  expect(words).toContain('The card above (Scores) sorts by score.')
  expect(words).not.toContain('card:')
})

test('a new card waits while the run of calls above it is live and draws once it folds; a card drawn before stays when a later run is live', async ($, on) => {
  world(on)
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'how many runs failed?', turnId: 't-runs' } as never)
  // Claude Code's run of commands above the card's call: live until its next request, then folded into one line
  const run = (row: string, isActive: boolean) => ({
    component: 'ToolGroup', surface: 'terminal', requestId: row, viewport: { columns: 100, rows: 40, isFullscreen: true },
    props: { calls: [{ tool_use_id: `${row}-ls`, tool: 'Bash', input: { command: 'ls runs' }, isRunning: false, isErrored: false, isInterrupted: false }], isActive, isExpanded: false },
  }) as never
  const drawn = async (toolUseId: string, input: Record<string, unknown>) => elements(await $.ui.render(callRow(toolUseId, input))).some(n => n.type === 'Client')
  await $.ui.render(run('run-1', true))
  const input = { title: 'Runs', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_w1', ...input } as never)
  expect(await drawn('toolu_made_up_w1', input)).toBe(false)
  await $.ui.render(run('run-1', false))
  expect(await drawn('toolu_made_up_w1', input)).toBe(true)
  // a later run that goes live leaves the card on screen
  await $.ui.render(run('run-2', true))
  expect(await drawn('toolu_made_up_w1', input)).toBe(true)
  // a run that never says it folded: the end of the turn draws the card
  const second = { title: 'Failures', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_w2', ...second } as never)
  expect(await drawn('toolu_made_up_w2', second)).toBe(false)
  await $.turn.complete({ turnId: 't-runs', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  expect(await drawn('toolu_made_up_w2', second)).toBe(true)
})

test('a view that did not parse is fixed with edits, its rows kept; the card on screen stays meanwhile', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const broken = VIEW.replace('children: "x"', 'children: "x" BROKEN')
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_9', title: 'Scores', data: 'runs.json', view: broken } as never)) as Any
  expect(String(r.result)).toContain('the view does not parse')
  const id = /id "(c[0-9a-f]+)"/.exec(String(r.result))![1]
  const fixed = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_9b', id, edits: [{ old: ' BROKEN', new: '' }] } as never)) as Any
  expect(String(fixed.result)).toContain('“Scores” is drawn where this call stands')
  expect(Object.entries(w.files).find(([p]) => /\/v1\/view\.js$/.test(p))?.[1]).toBe(VIEW)
  // the card stands under the call that drew it; the call that failed says so
  expect(elements(await $.ui.render(callRow('toolu_made_up_9b', {}))).some(n => n.type === 'Client')).toBe(true)
  // a version that fails after one drew leaves that one on screen, and edits go to the view that failed
  const again = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_9c', id, edits: [{ old: 'children: "x"', new: 'children: "x" BROKEN' }] } as never)) as Any
  expect(String(again.result)).toContain('The version on screen stays.')
  const fixed2 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_9d', id, edits: [{ old: ' BROKEN', new: ' ' }] } as never)) as Any
  expect(String(fixed2.result)).toContain('Version 2 of “Scores” is drawn in place of version 1')
  // new rows alone keep the view of the last call
  const rows = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_9e', id, data: 'runs.json' } as never)) as Any
  expect(String(rows.result)).toContain('Version 3 of “Scores” is drawn in place of version 2')
  expect(Object.entries(w.files).find(([p]) => /\/v3\/view\.js$/.test(p))?.[1]).toBe(VIEW.replace('children: "x"', 'children: "x" '))
})

test('a card at each width: in a side pane the card and its copy each draw at their own width, a post sent before the frame narrowed is answered at its width now, a drawing that fails at a narrow width holds only there, and the call copies the card at the width it is drawn at only', async ($, on) => {
  const w = world(on, { wide: true })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  // a side pane opens: the card in the conversation and its copy in the pane each draw at their own width, and never
  // show a drawing laid out for another
  {
    const input = { title: 'Scores', data: 'runs.json', view: VIEW }
    await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_11', ...input } as never)
    // the pane's copy is a second instance of the card's frame, at the pane's width
    const at = (columns: number) => ({ ...(callRow('toolu_made_up_11', input) as Any), ...(columns < 50 ? { requestId: 'pane-copy' } : {}), viewport: { columns, rows: 40, isFullscreen: true } })
    const client = async (columns: number) => elements(await $.ui.render(at(columns))).find(n => n.type === 'Client')?.props
    // the pane opens and the conversation narrows to 70 columns: the drawing at 92 columns is not drawn at 62
    const narrowed = await client(70)
    expect(narrowed.props.tree).toBe(null)
    // version 1 at 62 columns, of the card as its load left it (the load's answer, the runner's second)
    expect(narrowed.props.need).toBe('1:62:2')
    expect(narrowed.width).toBe(62)
    // the conversation's Client and the pane's copy (40 columns) both on screen: each draws at its own width
    const main = await shown($, at(70))
    const pane = await shown($, at(40))
    expect((await client(70)).props.tree).toEqual({ t: 'Text', p: {}, c: ['rows at 62'] })
    expect((await client(40)).props.tree).toEqual({ t: 'Text', p: {}, c: ['rows at 32'] })
    // what each Client draws, and a post from either answering the drawing at that Client's width
    const key = (await client(70)).key ?? elements(await $.ui.render(at(70))).find(n => n.type === 'Client')?.key
    const drawnIn = async (m: Any) => textOf(await m.drawn({ in: key }))
    expect(await drawnIn(main)).toContain('rows at 62')
    expect(await drawnIn(pane)).toContain('rows at 32')
    await main.post({ client: 'made-up', width: 62, events: [{ n: 1, rows: 4 }] }, { in: key })
    await pane.post({ client: 'made-up-2', width: 32, events: [{ n: 1, rows: 4 }] }, { in: key })
    expect(await drawnIn(main)).toContain('rows at 62')
    expect(await drawnIn(pane)).toContain('rows at 32')
    // a key changes the card: the drawing at the other width is gone, and that width draws again
    const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
    expect(await edit('o')).toEqual({ text: '', cursor: 0 })
    expect((await client(40)).props.tree).toEqual({ t: 'Text', p: {}, c: ['sorted at 32'] })
    expect((await client(70)).props.tree).toBe(null)
    await main.unmount()
    await (await shown($, at(70))).unmount()
    expect((await client(70)).props.tree).toEqual({ t: 'Text', p: {}, c: ['sorted at 62'] })
    expect((await client(40)).props.tree).toEqual({ t: 'Text', p: {}, c: ['sorted at 32'] })
    // a Button pressed in the pane's copy: the runner holds the card at the pane's width first, so the press is the one
    // of the drawing the person saw
    await pane.post({ client: 'made-up-2', width: 32, events: [{ n: 2, press: 0, width: 32 }] }, { in: key })
    expect(w.asked.slice(-2)).toEqual(['draw', 'press'])
    await pane.unmount()
  }
  // a post the Client sent before its frame narrowed is answered with the drawing at the frame's width now, so no row
  // of the wider one wraps
  {
    const input = { title: 'Scores', data: 'runs.json', view: VIEW }
    await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_16', ...input } as never)
    const at = (columns: number) => ({ ...(callRow('toolu_made_up_16', input) as Any), viewport: { columns, rows: 40, isFullscreen: true } })
    const keyOf = async () => elements(await $.ui.render(at(70))).find(n => n.type === 'Client')?.props?.key
    // the card at the screen's width, then a side pane narrows the chat: the frame draws at 62 columns (sorted or not,
    // as the key above left the runner)
    await (await shown($, at(100))).unmount()
    const main = await shown($, at(70))
    const key = await keyOf()
    const drawnIn = async () => textOf(await main.drawn({ in: key }))
    expect(await drawnIn()).toContain(' at 62')
    // a post the Client sent while it still drew at 92 columns (its rows changed as the region narrowed) is answered
    // now: with the drawing at 62, not the one at 92 its post named
    await main.post({ client: 'made-up', width: 92, events: [{ n: 1, rows: 4 }] }, { in: key })
    expect(await drawnIn()).toContain(' at 62')
    expect(await drawnIn()).not.toContain(' at 92')
    await main.unmount()
  }
  // a drawing that fails at a narrow width holds only there: the card keeps its drawing and keys, and draws again at
  // a new width
  {
    const input = { title: 'Scores', data: 'runs.json', view: VIEW }
    await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_10', ...input } as never)
    const at = (columns: number) => ({ ...(callRow('toolu_made_up_10', input) as Any), viewport: { columns, rows: 40, isFullscreen: true } })
    // the row as the terminal draws it at a width (a resize draws the row again, with its Client)
    const drawn = async (columns: number) => (await shown($, at(columns))).unmount()
    await drawn(100)
    // a side pane narrows the card: the drawing at 20 columns fails, and the card says so
    await drawn(28)
    const narrow = textOf(await $.ui.render(at(28)))
    expect(narrow).toContain('at 20 columns the view failed (line 4: Invalid count value: -1)')
    // the pane closes: the card draws again at its width, with no failure
    const drawsBefore = w.asked.filter(x => x === 'draw').length
    await drawn(100)
    expect(w.asked.filter(x => x === 'draw').length).toBe(drawsBefore + 1)
    const wide = textOf(await $.ui.render(at(100)))
    expect(wide).not.toContain('failed')
  }
  // B32: the call gives the text copy at the width the card is drawn at only. A copy at the narrower width a side pane
  // would leave it gave Claude a reason to change a card that fits where it is shown, so the call asks the runner for
  // none, and its answer names no side pane
  {
    const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_17', title: 'Scores', data: 'runs.json', view: VIEW } as never)) as Any
    expect(w.loads.at(-1).width).toBeGreaterThan(0)
    expect(w.loads.at(-1).beside).toBeUndefined()
    expect(String(r.result)).toContain('What it draws,')
    expect(String(r.result)).not.toContain('side pane')
  }
})

// The card in the conversation and its copy in a side pane draw at two widths, and the runner holds the card at the
// width of the last drawing it was asked for. A key that comes while the answer to the other frame's drawing is on its
// way is drawn at that frame's width, and its answer can come first: the hooks keep it at the width it says
test("a key while a drawing at another width is on its way: its drawing is kept at the width the runner drew it at, so the card in the conversation never draws the side pane's copy", async ($, on) => {
  const w = world(on, { wide: true })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_19', ...input } as never)
  // the card in the conversation at 62 columns, its copy in a side pane at 32
  const at = (columns: number) => ({ ...(callRow('toolu_made_up_19', input) as Any), ...(columns < 50 ? { requestId: 'pane-copy' } : {}), viewport: { columns, rows: 40, isFullscreen: true } })
  const client = async (columns: number) => elements(await $.ui.render(at(columns))).find(n => n.type === 'Client')?.props
  const laid = (words: string) => ({ t: 'Text', p: {}, c: [words] })
  const pane = await shown($, at(40))
  const main = await shown($, at(70))
  expect((await client(70)).props.tree).toEqual(laid('rows at 62'))
  expect((await client(40)).props.tree).toEqual(laid('rows at 32'))
  // the pane's copy asks for its drawing again: the runner moves the card to 32 columns, and its answer is on its way
  const paneKey = (await client(40)).key
  const came = w.hold('draw')
  const asked = pane.post({ client: 'made-up-2', width: 32, events: [{ n: 1, draw: '1:32' }] }, { in: paneKey })
  await came
  // a key now: the runner draws it at 32 columns, and its answer comes first
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  expect(await edit('o')).toEqual({ text: '', cursor: 0 })
  // the card in the conversation does not draw a drawing laid out at 32 columns; the copy in the pane draws it
  const waits = await client(70)
  expect(waits.props.tree).toBe(null)
  expect(waits.props.need).toMatch(/^1:62(:|$)/)
  expect((await client(40)).props.tree).toEqual(laid('sorted at 32'))
  w.release()
  await asked
  // it asks for its own, which the runner draws at 62 columns
  await main.unmount()
  await (await shown($, at(70))).unmount()
  expect((await client(70)).props.tree).toEqual(laid('sorted at 62'))
  await pane.unmount()
})

// The other order: the conversation's card asked for its drawing, the runner moved the card to its width, and the side
// pane's copy asked for its own and a key came before that first answer did. The first answer shows the card before the
// key, so it is dropped, and the card in the conversation asks again; else it would draw `drawing…` from then on
test('a frame that asked for its drawing before a key changed the card asks again, and does not stay at `drawing…`', async ($, on) => {
  const w = world(on, { wide: true })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_20', ...input } as never)
  const at = (columns: number) => ({ ...(callRow('toolu_made_up_20', input) as Any), ...(columns < 50 ? { requestId: 'pane-copy' } : {}), viewport: { columns, rows: 40, isFullscreen: true } })
  const client = async (columns: number) => elements(await $.ui.render(at(columns))).find(n => n.type === 'Client')?.props
  const laid = (words: string) => ({ t: 'Text', p: {}, c: [words] })
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  // the card in the conversation asks for its drawing at 62 columns: the runner moves the card there, and its answer is
  // on its way
  const came = w.hold('draw')
  const main = shown($, at(70))
  await came
  // its copy in a side pane asks for its own at 32 columns, and a key comes, which the runner draws at 32
  const pane = await shown($, at(40))
  expect(await edit('o')).toEqual({ text: '', cursor: 0 })
  expect((await client(40)).props.tree).toEqual(laid('sorted at 32'))
  // the drawing at 62 comes, of the card before the key, and is dropped; Claude Code runs the Client again with the props
  // its post's answer gave it, and it asks again: the card in the conversation draws the key at 62 columns
  w.release()
  const shownMain = await main
  const draws = w.asked.filter(x => x === 'draw').length
  expect(textOf(await shownMain.drawn({ in: (await client(70)).key }))).toContain('sorted at 62')
  expect(w.asked.filter(x => x === 'draw').length).toBe(draws + 1)
  expect((await client(70)).props.tree).toEqual(laid('sorted at 62'))
  await shownMain.unmount()
  await pane.unmount()
})

// A side thread's pane draws the card at the pane's width, so the runner's newest drawing is the pane's. A text copy
// Claude reads is laid out at the width of the surface its reader relates to, not at the newest drawing's: main's at the
// conversation's, the side thread's at its pane's while the pane draws the card
test("the side pane drew the card last: main's next card call still answers the copy at the conversation's width, and the side thread reads the card as its pane draws it", async ($, on) => {
  const w = world(on, { wide: true })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_23', ...input } as never)) as Any
  const id = /Its id is "(c[0-9a-f]+)"/.exec(String(r.result))![1]
  // the card in the conversation at 92 columns; a side thread about it, whose pane (50 columns) draws it whole at 44
  const row = await shown($, callRow('toolu_made_up_23', input))
  await row.press({ key: 'ask-visible' })
  const pane = await $.ui.mount({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'Scores', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never)
  await pane.press({ key: 'thread-key-e' })
  expect(textOf(await pane.drawn({ in: `card-${id}-1` }))).toContain('rows at 44')
  // main draws a new version: its copy is the card the conversation shows, not the pane's
  const r2 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_23b', id, edits: [{ old: 'children: "x"', new: 'children: "y"' }] } as never)) as Any
  expect(String(r2.result)).toContain('What it draws, 92 columns wide:')
  // a question in the side thread: its fork reads the card as the pane draws it, and once e folded the card to its
  // title, as the conversation draws it
  const ask = async (text: string) => {
    await (pane as Any).input({ key: String((await pane.find({ type: 'Input' }))?.key), text })
    return String(w.forks.at(-1)?.prompt)
  }
  expect(await ask('why is ada first?')).toContain('What the card draws now, as text:\ncopy at 44')
  await pane.press({ key: 'thread-key-e' })
  expect(await ask('and bram?')).toContain('What the card draws now, as text:\ncopy at 92')
  await pane.unmount()
  await row.unmount()
})

test('a key at an empty prompt reaches the focused card in view when it lists the key, and other keys type; a card scrolled out of view takes none', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_2', ...input } as never)
  const edit = (key: string, text = '') => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key } as never) as Any
  // a card not yet on screen takes no keys
  expect((await edit('o')).text).toBe('o')
  await shown($, callRow('toolu_made_up_2', { title: 'Scores', data: 'runs.json', view: VIEW }))
  expect(await edit('o')).toEqual({ text: '', cursor: 0 })
  expect(w.asked).toContain('key')
  const row = await $.ui.render(callRow('toolu_made_up_2', { title: 'Scores', data: 'runs.json', view: VIEW }))
  expect(elements(row).find(n => n.type === 'Client')?.props.props.tree).toEqual(SORTED)
  // a letter typed straight after a key the card took: a word that starts with that key, which goes back whole
  expect((await edit('q')).text).toBe('oq')
  expect(w.asked).toContain('undo')
  await w.clock.advance(1000)
  expect((await edit('q')).text).toBe('q')
  expect((await edit('o', 'a')).text).toBe('ao')
  // keys that come quickly arrive as one edit: each reaches the card; a burst with a letter no card takes is typed
  const burst = (inputText: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText } as never) as Any
  const keysBefore = w.asked.filter(x => x === 'key').length
  expect(await burst('ooo')).toEqual({ text: '', cursor: 0 })
  expect(w.asked.filter(x => x === 'key').length).toBe(keysBefore + 3)
  await w.clock.advance(1000)
  expect((await burst('oq')).text).toBe('oq')
  // a card scrolled out of view takes no keys, and the one in view does
  await w.clock.advance(1000)
  const at = (onScreen: Any) => ({ ...(callRow('toolu_made_up_2', input) as Any), props: { ...(callRow('toolu_made_up_2', input) as Any).props, onScreen } })
  await $.ui.render(at({ first: 0, last: 9, of: 10 }))
  expect(await edit('o')).toEqual({ text: '', cursor: 0 })
  await w.clock.advance(1000)
  await $.ui.render(at(null))
  expect((await edit('o')).text).toBe('o')
})

test('a card the designer fork drew draws under the answer v was pressed on, also in a resumed session', async ($, on) => {
  const w = world(on)
  // the card as tool.ts keeps a designer fork's call: its anchor is the answer's row
  const dir = '/made-up/.thimble/conversations/s-cards/cards/c0123456789ab'
  const meta = { id: 'c0123456789ab', version: 1, title: 'Scores', toolUseId: 'toolu_made_up_3', agentId: 'a-made-up', anchorRow: 'row-made-up', keys: ['o'], read: '2 rows', columns: ['name', 'score'], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_3: { version: 1 } }, at: 1 }
  w.files[`${dir}/meta.json`] = JSON.stringify(meta)
  w.files[`${dir}/v1/view.js`] = VIEW
  w.dirs['/made-up/.thimble/conversations/s-cards/cards'] = ['c0123456789ab']
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const answer = (requestId: string) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId, viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text: 'An answer.', isFirstOfReply: true } } as never)
  // with no drawing yet, its Client asks for one at its width; the runner loads the card from its copy
  const first = await answer('row-made-up')
  expect(textOf(first)).toContain('Scores')
  expect(elements(first).find(n => n.type === 'Client')?.props.props.need).toBe('1:92:0')
  await $.ui.mount({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: 'row-made-up', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text: 'An answer.', isFirstOfReply: true } } as never)
  expect(w.asked).toContain('draw')
  expect(elements(await answer('row-made-up')).find(n => n.type === 'Client')?.props.props.tree).toEqual(TREE)
  expect(textOf(await answer('another-row'))).not.toContain('Scores')
  // words of that answer that place it (a squeeze's version) draw it on their line, once, not under the answer too
  const placing = (requestId: string) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId, viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text: 'An answer.\n\n[Scores](card:c0123456789ab)\n\nMore of it.', isFirstOfReply: true } } as never)
  const there = await placing('row-made-up')
  expect(elements(there).filter(n => n.type === 'Client').length).toBe(1)
  expect(textOf(there)).not.toContain('card:')
  // thimble draws the words, with the card on its line, rather than Claude Code's drawing with the card under it
  expect(textOf(there)).not.toContain('the engine')
  // another answer's line points to it
  const other = await placing('another-row')
  expect(elements(other).some(n => n.type === 'Client')).toBe(false)
  expect(textOf(other)).toContain('↑ “Scores” is drawn under an earlier answer')
  // its call's row in the fork draws no second card
  const row = await $.ui.render(callRow('toolu_made_up_3', { title: 'Scores', data: 'runs.json', view: VIEW }))
  expect(elements(row).some(n => n.type === 'Client')).toBe(false)
})

test('a card placed in the middle of an answer takes keys while the screen shows it, not while it shows the text after it', async ($, on) => {
  const w = world(on)
  const dir = '/made-up/.thimble/conversations/s-cards/cards/c0123456789ab'
  const meta = { id: 'c0123456789ab', version: 1, title: 'Scores', toolUseId: 'toolu_made_up_3', agentId: 'a-made-up', anchorRow: 'row-made-up', keys: ['o'], read: '2 rows', columns: ['name', 'score'], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_3: { version: 1 } }, at: 1 }
  w.files[`${dir}/meta.json`] = JSON.stringify(meta)
  w.files[`${dir}/v1/view.js`] = VIEW
  w.dirs['/made-up/.thimble/conversations/s-cards/cards'] = ['c0123456789ab']
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  // a long answer that places the card after its first paragraph
  const after = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} after the card.`).join('\n\n')
  const text = `An answer.\n\n[Scores](card:c0123456789ab)\n\n${after}`
  const at = (onScreen?: Any) => ({ component: 'AssistantMessage', surface: 'terminal', requestId: 'row-made-up', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true, ...(onScreen !== undefined ? { onScreen } : {}) } })
  const row = (onScreen?: Any) => $.ui.render(at(onScreen) as never)
  // the card's Client draws (Claude Code mounts it), so the card has been on screen
  await $.ui.mount({ plugin: 'thimble', ...at() } as never)
  const of = treeRows(await row(), 97)
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  // the screen shows the answer's top, with the card: the card takes o
  await row({ first: 0, last: 20, of })
  expect(await edit('o')).toEqual({ text: '', cursor: 0 })
  await w.clock.advance(1000)
  // the screen shows only the paragraphs after the card: the card is scrolled away, so o is typed
  await row({ first: of - 15, last: of - 1, of })
  expect((await edit('o')).text).toBe('o')
})

test("a card kept from before w was thimble's own still lists w: the bar names only the keys it can get, and w never reaches it", async ($, on) => {
  const w = world(on)
  const dir = '/made-up/.thimble/conversations/s-cards/cards/c0123456789ab'
  // its keys as the card tool kept them before w was thimble's own
  const meta = { id: 'c0123456789ab', version: 1, title: 'Scores', toolUseId: 'toolu_made_up_3', agentId: 'a-made-up', anchorRow: 'row-made-up', keys: ['o', 'w'], read: '2 rows', columns: ['name', 'score'], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_3: { version: 1 } }, at: 1 }
  w.files[`${dir}/meta.json`] = JSON.stringify(meta)
  w.files[`${dir}/v1/view.js`] = VIEW
  w.dirs['/made-up/.thimble/conversations/s-cards/cards'] = ['c0123456789ab']
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  // the card's Client draws under its answer (Claude Code mounts it), so the card is on screen
  await $.ui.mount({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: 'row-made-up', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text: 'An answer.', isFirstOfReply: true } } as never)
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  // the bar names o, its one key it can get
  const bar = textOf(await $.ui.render(BAND))
  expect(bar).toContain('o card keys')
  expect(bar).not.toContain('w card keys')
  // w never reaches it: nothing names w here, so it is typed, and the card is asked nothing
  const asked = w.asked.filter(x => x === 'key').length
  expect((await edit('w')).text).toBe('w')
  expect(w.asked.filter(x => x === 'key').length).toBe(asked)
  // o does
  await w.clock.advance(1000)
  expect(await edit('o')).toEqual({ text: '', cursor: 0 })
  expect(w.asked.filter(x => x === 'key').length).toBe(asked + 1)
})

test("a card call the person's permission rules refuse draws nothing, and says why", async ($, on) => {
  const w = world(on)
  w.files[`${DATA}/secret.json`] = '[]'
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_5', title: 'Secret', data: 'secret.json', view: VIEW } as never)) as Any
  expect(String(r.result)).toBe('The card did not draw: a made-up deny rule.')
  expect(w.asked).not.toContain('load')
})

test('a data file whose real path leaves this folder (a symlink out) is refused, and the runner is never asked', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_8', title: 'Out', data: 'escape.json', view: VIEW } as never)) as Any
  expect(String(r.result)).toContain('is outside this folder and the temp folder')
  expect(w.asked).not.toContain('load')
})

test("R2: a data file a command in Claude Code's Bash sandbox wrote at $TMPDIR, Claude Code's own temp folder there, draws as one in thimble's does; where both hold the file, the newer one; where neither does, no file", async ($, on) => {
  // thimble's temp folder is thimble/ in the person's TMPDIR, made-up/t; Claude Code keeps its own, claude-1000/, in
  // CLAUDE_CODE_TMPDIR, made-up/cc, and a sandboxed command gets that one as its TMPDIR
  const C = '/made-up/cc/claude-1000'
  const T = '/made-up/t/thimble'
  const at: Record<string, { kind: string; mtimeMs: number }> = { [C]: { kind: 'dir', mtimeMs: 0 }, [T]: { kind: 'dir', mtimeMs: 0 }, [`${C}/probe.json`]: { kind: 'file', mtimeMs: 5 } }
  const w = world(on, { env: { TMPDIR: '/made-up/t', CLAUDE_CODE_TMPDIR: '/made-up/cc' }, stat: p => (at[p] ? { ...at[p], size: 32, isLink: false, realPath: p } : undefined) })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const copied = () => w.runs.filter(a => a[0] === 'cp').map(a => a[2])
  const call = async (id: string, data: string) => String(((await $.tool.call({ tool: TOOL, tool_use_id: id, title: 'Probe', data, view: VIEW } as never)) as Any).result)
  expect(await call('toolu_made_up_r2a', '$TMPDIR/probe.json')).toContain('It read 2 rows from probe.json')
  expect(copied()).toEqual([`${C}/probe.json`])
  // the same name written since in thimble's own folder (by a command outside the sandbox): that one
  at[`${T}/probe.json`] = { kind: 'file', mtimeMs: 9 }
  expect(await call('toolu_made_up_r2b', '${TMPDIR}/probe.json')).toContain('is drawn')
  // the path as a sandboxed command printed it
  expect(await call('toolu_made_up_r2c', `${C}/probe.json`)).toContain('is drawn')
  expect(copied()).toEqual([`${C}/probe.json`, `${T}/probe.json`, `${C}/probe.json`])
  expect(await call('toolu_made_up_r2d', '$TMPDIR/none.json')).toBe('The card did not draw: there is no file at $TMPDIR/none.json.')
})

test('keys at an empty prompt: letters only, never a slash command; a word that starts with a card key and v goes back whole', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  // the view asks for "n" and "/"; the card gets the letter only
  const view = 'const keys = "n/"\nfunction onKey(k, s) {}\nfunction view(p, s) { return s.elements.Text({ children: "x" }) }'
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_6', title: 'Scores', data: 'runs.json', view } as never)) as Any
  expect(String(r.result)).toContain('a card takes letters only, so it does not get /')
  await shown($, callRow('toolu_made_up_6', { title: 'Scores', data: 'runs.json', view }))
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  const meta = JSON.parse(Object.entries(w.files).find(([p]) => p.endsWith('/meta.json'))![1])
  expect(meta.keys).toEqual(['n'])
  expect((await edit('/')).text).toBe('/')
  await w.clock.advance(1000)
  // "n" then "v" straight after (the person types "nvim"): a word, and v starts nothing
  expect(await edit('n')).toEqual({ text: '', cursor: 0 })
  expect((await edit('v')).text).toBe('nv')
  expect(w.asked).toContain('undo')
})

test('a view that stops the runner is not sent again, and the call says to draw less', async ($, on) => {
  const w = world(on, { crash: 'load' })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_7', title: 'Scores', data: 'runs.json', view: VIEW } as never)) as Any
  expect(w.asked.filter(x => x === 'load').length).toBe(1)
  expect(String(r.result)).toContain('the card stopped the card runner, most likely by using too much memory')
  expect(String(r.result)).toContain('Fix the view')
  expect(String(r.result)).not.toContain('cannot draw in this session')
})

test('when Claude Code refuses the requests to the runner, the call and the failure line say so, and not that the sandbox failed', async ($, on) => {
  const w = world(on, { refused: true })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(10)
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_9', title: 'Scores', data: 'runs.json', view: VIEW } as never)) as Any
  const text = String(r.result)
  expect(text).toContain("Claude Code refuses thimble's requests to its card runner in this session: nonessential network traffic is disabled for this session")
  expect(text).not.toContain('did not start in its sandbox')
  const bar = textOf(await $.ui.render(BAND))
  expect(bar).toContain("Claude Code refuses thimble's requests to its card runner")
  expect(w.asked).not.toContain('load')
})

test('when the sandbox cannot start, no card runs: the call and the failure line say why and the fix', async ($, on) => {
  const w = world(on, { sandbox: { ok: false, why: 'this machine lacks what the sandbox needs: bubblewrap (bwrap) not installed', fix: 'Install it: sudo apt-get install bubblewrap' } })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(10)
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_8', title: 'Scores', data: 'runs.json', view: VIEW } as never)) as Any
  const text = String(r.result)
  expect(text).toContain("cards run only in Anthropic's sandbox runtime, which cannot start here: this machine lacks what the sandbox needs: bubblewrap (bwrap) not installed. Install it: sudo apt-get install bubblewrap")
  expect(text).toContain('The view is not the cause')
  const bar = textOf(await $.ui.render(BAND))
  expect(bar).toContain('Cards cannot draw: cards run only in Anthropic')
  expect(bar).toContain('sudo apt-get install bubblewrap')
  expect(w.asked).not.toContain('load')
  expect(w.spawned.length).toBe(0)
  // the fix needs the person's sudo: a notice, not a failure line
  expect(bar).not.toContain('× Cards cannot draw')
  // no folder is made for a runner that cannot start
  expect(w.runs.some(a => a.some(x => /\/cards-[0-9a-f]+$/.test(x)))).toBe(false)
  // the call's row says the whole reason and the fix
  const result = textOf(await $.ui.render(callRow('toolu_made_up_8', { title: 'Scores' })))
  expect(result).toContain('bubblewrap (bwrap) not installed. Install it: sudo apt-get install bubblewrap · Claude got the error')
})

// the hooks run in Claude Code's engine, whose own Node is not the runner's: only setup.mjs's answer says which grants
// the runner's Node takes, whatever its version (a Node 24 that took the flag would get it too)
for (const [nodeVersion, net] of [['26.11.1', true], ['24.30.0', true], ['22.22.0', false]] as const) {
  test(`the hooks start the runner with the grants setup.mjs says its Node takes: Node ${nodeVersion} that ${net ? 'takes --allow-net gets it' : 'refuses --allow-net does not get it'}`, async ($, on) => {
    const w = world(on, { sandbox: { nodeVersion, grants: { '--allow-net': net } }, noRunner: true })
    await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
    await w.clock.advance(10)
    // the runner starts on the clock's next turn, and the hooks wait on the clock for its answer
    const call = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_15', title: 'Scores', data: 'runs.json', view: VIEW } as never)
    for (let i = 0; i < 10 && !w.spawned.length; i++) await w.clock.advance(20)
    expect(String(((await call) as Any).result)).not.toContain('did not draw')
    const argv = w.spawned.at(-1) ?? []
    const command = argv.slice(argv.indexOf('/made-up/bin/node', argv.indexOf('--')))
    expect(command.slice(0, 2)).toEqual(['/made-up/bin/node', '--permission'])
    expect(command[2] === '--allow-net').toBe(net)
    expect(command.includes('--allow-net')).toBe(net)
  })
}

// the report Node prints when an error ends the runner at its start: the error and its code come before the stack, and
// Node's version last
const REFUSED = `file:///made-up/cards/runner.mjs:792\n  const server = http.createServer(serve)\n                      ^\n\nError: made-up: refused\n${'    at serve (file:///made-up/cards/runner.mjs:792:23)\n'.repeat(10)} {\n  code: 'ERR_ACCESS_DENIED'\n}\n\nNode.js v24.30.0\n`

test('a runner that ends before it answers, while setup.mjs\'s own runner starts: the call and the line say how it ended, on which Node, and its error and code', async ($, on) => {
  const w = world(on, { sandbox: { nodeVersion: '24.30.0' }, runnerEnds: { stderr: REFUSED, code: 1, signal: null } })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(10)
  const call = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_16', title: 'Scores', data: 'runs.json', view: VIEW } as never)
  await w.clock.advance(100)
  const text = String(((await call) as Any).result)
  for (const said of ['exit 1', 'Node 24.30.0', '/made-up/bin/node', 'made-up: refused', 'ERR_ACCESS_DENIED']) expect(text).toContain(said)
  expect(text).not.toContain('Node.js v24.30.0')
  const bar = textOf(await $.ui.render(BAND))
  expect(bar).toContain('Cards cannot draw')
  for (const said of ['exit 1', 'Node 24.30.0', 'made-up: refused']) expect(bar).toContain(said)
  // setup.mjs's own runner, which the probe started, answered
  expect(w.runs.some(a => String(a[1] ?? '').endsWith('/sandbox/setup.mjs') && a.includes('--probe'))).toBe(true)
})

test('a runner that does not answer in time, while setup.mjs\'s own runner starts: the call says so, and not how the runner the hooks stopped ended', async ($, on) => {
  const w = world(on, { sandbox: { nodeVersion: '24.30.0' }, runnerHangs: true })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(10)
  const call = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_17', title: 'Scores', data: 'runs.json', view: VIEW } as never)
  await w.clock.advance(6000)
  const text = String(((await call) as Any).result)
  expect(text).toMatch(/did not answer in \d+ s/)
  expect(text).not.toContain('ended with')
  expect(w.spawned.length).toBe(1)
})

// the session's runner stops at once while setup.mjs's probe, which starts the code on disk, starts: when that code
// changed since the session loaded it (patched in place), the session runs the old code, and only a reload helps
for (const patched of [true, false]) {
  test(`a runner that does not start ${patched ? 'on card code patched on disk since the session loaded it says to type /reload-plugins' : 'on the code the session loaded says only that it stopped'}`, async ($, on) => {
    const w = world(on, { deadRunner: true })
    await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
    await w.clock.advance(10)
    if (patched) w.code.mtimeMs = 2
    let done = false
    const call = ($.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_16', title: 'Scores', data: 'runs.json', view: VIEW } as never) as Promise<Any>).finally(() => { done = true })
    for (let i = 0; i < 400 && !done; i++) await w.clock.advance(20)
    const text = String(((await call) as Any).result)
    const reload = "thimble's card code changed on disk after this session loaded it, so the session runs the old code: type /reload-plugins"
    if (patched) expect(text).toContain(reload)
    // how it ended is the runner's own line (tested above); unpatched code is told nothing about a reload
    else expect(text).toMatch(/the card runner did not (start in its sandbox|answer in)/)
    if (!patched) expect(text).not.toContain('/reload-plugins')
  })
}

test('a card called while the session start still installs the sandbox draws: it does not wait on that install\'s answer', async ($, on) => {
  const w = world(on, { firstSetupHangs: true })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(10)
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_12', title: 'Scores', data: 'runs.json', view: VIEW } as never)) as Any
  expect(String(r.result)).not.toContain('did not draw')
  expect(w.asked).toContain('load')
  expect(w.runs.filter(a => String(a[1] ?? '').endsWith('/sandbox/setup.mjs')).length).toBe(2)
})

test('with long user and folder names the runner\'s socket still fits a Unix socket\'s path, in a folder of its own', async ($, on) => {
  // a Unix socket's path holds at most 108 bytes (104 on macOS): every folder named after the user or a home is too long
  const user = 'a-rather-long-user-name-'.repeat(3)
  const w = world(on, { env: { USER: user, HOME: `/made-up/home/${user}`, THIMBLE_HOME: `/made-up/home/${user}/.thimble`, TMPDIR: `/made-up/tmp/${user}` } })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_14', title: 'Scores', data: 'runs.json', view: VIEW } as never)) as Any
  expect(String(r.result)).not.toContain('did not draw')
  // the runner's folder, made before it starts: the socket is `cards.sock` in it
  const made = w.runs.filter(a => a[0] === 'sh' && /\/cards-[0-9a-f]+$/.test(String(a[a.length - 1]))).map(a => String(a[a.length - 1]))
  expect(made.at(-1)).toMatch(/^\/tmp\/thimble-[0-9a-f]{12}\/cards-[0-9a-f]+$/)
  expect(`${made.at(-1)}/cards.sock`.length).toBeLessThanOrEqual(100)
  expect(w.asked).toContain('load')
})

test('the session ends: the runner stops and its folder goes', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_13', title: 'Scores', data: 'runs.json', view: VIEW } as never)
  const made = w.runs.find(a => a[0] === 'sh' && /\/cards-[0-9a-f]+$/.test(String(a[a.length - 1]))) as string[]
  expect(made).toBeTruthy()
  await $.session.end({ reason: 'exit', sessionId: 's-cards' } as never)
  expect(w.runs).toContainEqual(['rm', '-rf', '--', made[made.length - 1]])
})

// a bar chart's rows: a column of Text lines and of Box rows, each row a label, colored bars and a number side by side
const ROWS = { t: 'Box', p: { flexDirection: 'column' }, c: [
  { t: 'Text', p: { bold: true }, c: ['2 groups, 9 in all'] },
  { t: 'Box', p: {}, c: [{ t: 'Text', p: {}, c: ['  ada  '] }, { t: 'Text', p: { color: 'success' }, c: ['███'] }, { t: 'Text', p: { color: 'warning' }, c: ['█'] }, { t: 'Text', p: {}, c: [' 4'] }] },
  { t: 'Box', p: {}, c: [{ t: 'Text', p: {}, c: ['  bram '] }, { t: 'Text', p: { color: 'success' }, c: ['█████'] }, { t: 'Text', p: {}, c: [' 5'] }] },
] }

test('the Client makes every run of a card clickable without a Button that holds a Box: a bar takes thimble\'s color under the pointer, words its tint and an underline', async () => {
  const el = (type: string) => (p: Any) => ({ type, props: p })
  const posts: Any[] = []
  let pointer: Any = null
  const surface: Any = { elements: { Box: el('Box'), Text: el('Text'), Button: el('Button') }, columns: 60, rows: 0, post: (m: Any) => posts.push(m), onPointer: (f: Any) => { pointer = f } }
  const drawn = (Card as Any)({ tree: ROWS, width: 60, tint: '#f0e8ff', accent: 'merged' }, surface)
  const all = elements(drawn)
  const buttons = all.filter(n => n.type === 'Button')
  // each run asks on its own: the title, two labels, three bars, two numbers
  expect(buttons.length).toBe(8)
  // Claude Code draws no Button that holds a Box: each holds the one Text of its run
  for (const b of buttons) expect(b.props.children.map((c: Any) => c.type)).toEqual(['Text'])
  const of = (words: string) => buttons.find(b => textOf(b) === words)!
  expect(of('███').props.hover).toMatchObject({ inverse: false, color: 'merged' })
  expect(of('███').props.children[0].props).toMatchObject({ color: 'success', hover: { color: 'merged' } })
  expect(of('  bram ').props.hover).toMatchObject({ inverse: false, underline: true, backgroundColor: '#f0e8ff' })
  // a click on a bar: the run, its row's line and its place in the tree, which the runner reads for the item on that
  // line (a Button takes the click, so no pointer event comes)
  of('█████').props.onPress()
  expect(posts.at(-1).events.at(-1).ask).toEqual({ text: '█████', line: '  bram █████ 5', path: [2, 1] })
  // a click elsewhere still goes as a pointer event
  pointer({ type: 'down', x: 8, y: 2, button: 'left' })
  pointer({ type: 'up', x: 8, y: 2 })
  expect(posts.at(-1).events.at(-1).pointer).toEqual({ down: { x: 8, y: 2 }, up: { x: 8, y: 2 }, button: 'left' })
})

test('a card shows `a ask · p artifact` at its title\'s right, whose ask names the item selected; a click on words on no item asks a side thread about them', async ($, on) => {
  const w = world(on)
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  // nothing selected: `a ask`, the card the keys reach showing the letters
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_31', ...input } as never)
  const row = await shown($, callRow('toolu_made_up_31', input))
  let ask = elements(await $.ui.render({ plugin: 'thimble', ...(callRow('toolu_made_up_31', input) as Any) })).find(n => n.type === 'Button' && n.props?.key === 'ask-visible')
  expect(textOf(ask)).toBe('a ask')
  expect(ask.props.label).toBe('ask about the card "Scores"')
  const head = elements(await $.ui.render({ plugin: 'thimble', ...(callRow('toolu_made_up_31', input) as Any) })).find(n => n.props?.key === 'head-keys')
  expect(textOf(head)).toBe('a ask · p artifact')
  // a click on the words `bram 5`, on no item the card's keys select: the runner is asked, then a side thread about
  // them opens
  const key = elements(await $.ui.render({ plugin: 'thimble', ...(callRow('toolu_made_up_31', input) as Any) })).find(n => n.type === 'Client')?.key
  await row.post({ client: 'made-up', width: 92, events: [{ n: 1, ask: { text: 'bram 5', line: 'bram 5', path: [1] }, width: 92 }] }, { in: key })
  expect(w.asked).toContain('pick')
  expect(opened.some(e => /bram 5/.test(String(e.title)))).toBe(true)
  await row.unmount()
  // an item selected (▸): the words stay `ask`, and the question names the item
  const picked = { title: 'Picked', data: 'runs.json', view: `${VIEW}\n// SELECTED` }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_32', ...picked } as never)
  await (await shown($, callRow('toolu_made_up_32', picked))).unmount()
  ask = elements(await $.ui.render({ plugin: 'thimble', ...(callRow('toolu_made_up_32', picked) as Any) })).find(n => n.type === 'Button' && n.props?.key === 'ask-visible')
  expect(textOf(ask)).toBe('a ask')
  expect(ask.props.label).toBe('ask about "bram 5" in the card "Picked"')
  // the card the keys no longer reach (the newer one does): its words alone, which a click presses
  ask = elements(await $.ui.render({ plugin: 'thimble', ...(callRow('toolu_made_up_31', input) as Any) })).find(n => n.type === 'Button' && n.props?.key === 'ask-visible')
  expect(textOf(ask)).toBe('ask')
})

test('p on the card the keys reach starts the fork that makes an artifact of it, with artifact.md and the card\'s copy; a word starting with p starts nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_41', ...input } as never)
  await (await shown($, callRow('toolu_made_up_41', input))).unmount()
  const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never
  // p then a letter: the person types a word, and no fork starts
  expect(((await $.prompt.edit(key('p'))) as Any).text).toBe('')
  await w.clock.advance(100)
  expect(((await $.prompt.edit(key('l'))) as Any).text).toBe('pl')
  await w.clock.advance(1000)
  expect(w.forks.length).toBe(0)
  // p alone: the fork starts once the word window closed, with the card's title and its text copy
  expect(((await $.prompt.edit(key('p'))) as Any).text).toBe('')
  await w.clock.advance(100)
  await w.clock.advance(300)
  expect(w.forks.length).toBe(1)
  expect(w.forks[0].description).toBe('artifact of a card (p)')
  expect(w.forks[0].prompt).toContain('PROMPT artifact')
})

test("a view's own Button under the pointer: the whole row shows highlighted, its words inverse and its bar inverted on the highlight", async () => {
  const el = (type: string) => (p: Any) => ({ type, props: p })
  const surface: Any = { elements: { Box: el('Box'), Text: el('Text'), Button: el('Button') }, columns: 60, rows: 0, post: () => undefined, onPointer: () => undefined }
  // a row the view made a Button: its label and number, then its bar in a Text of its own color (a hex of the card
  // palette, and a color by name)
  const row = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Button', p: { plain: true, onPress: 3 }, c: [{ t: 'Text', p: { bold: true }, c: ['▸ bram  5 ', { t: 'Text', p: { color: '#0060c0' }, c: ['█████'] }, { t: 'Text', p: { color: 'success' }, c: ['██'] }] }] }] }
  const button = elements((Card as Any)({ tree: row, width: 60, theme: 'light' }, surface)).find(n => n.type === 'Button')!
  expect(button.props.hover).toMatchObject({ inverse: false })
  const texts = elements(button).filter(n => n.type === 'Text')
  const words = texts.find(n => n.props.children === '▸ bram  5 ')!
  expect(words.props.hover).toMatchObject({ scope: button.props.hover.scope, inverse: true })
  // the bar keeps its color at rest; under the pointer its cells take a light tint of it on the highlight's ground
  const bar = texts.find(n => n.props.color === '#0060c0')!
  expect(elements(bar).find(n => n.props?.children === '█████')!.props.hover).toEqual({ scope: button.props.hover.scope, color: '#8cb7e3', backgroundColor: 'text' })
  const named = texts.find(n => n.props.color === 'success')!
  expect(elements(named).find(n => n.props?.children === '██')!.props.hover).toEqual({ scope: button.props.hover.scope, color: 'success', backgroundColor: 'text' })
})

// the card check of a card that does not fit (cards/fit.ts): one model call, answered here with `views`, in order, each
// the view of its replacement ('' for none); a reply waits for `gate` while the test holds it
const settle = () => new Promise(r => setTimeout(r, 5))
function checker(on: Any, views: string[]) {
  const asked: Any[] = []
  const gate = { open: Promise.resolve() as Promise<unknown>, hold() { let go: (v?: unknown) => void = () => undefined; this.open = new Promise(r => { go = r }); return go } }
  on('model.complete', async (_$: unknown, e: Any) => {
    asked.push(e)
    await gate.open
    const view = views.shift() ?? ''
    return { value: { isAnswered: true, text: view ? `<view>\n${view}\n</view>` : '', usage: {} } }
  })
  return { asked, gate }
}

/** The card's Client props once no check holds it: its frame draws the card, not `drawing…`. */
async function drawnOnce($: Any, row: Any): Promise<Any> {
  for (let i = 0; i < 200; i++) {
    const props = elements(await $.ui.render(row)).find(n => n.type === 'Client')?.props.props
    if (props?.tree) return props
    await settle()
  }
  throw new Error('the card stayed held')
}

test('a card taller than its frame waits for the card check: its frame draws `drawing…` and takes no keys, then the check\'s replacement draws in its place; the call says nothing of it', async ($, on) => {
  world(on)
  const { asked, gate } = checker(on, [`${VIEW}\n// failed only`])
  const go = gate.hold()
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Every run', data: 'runs.json', view: `${VIEW}\n// TALL` }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_51', ...input } as never)) as Any
  // Claude reads what the card read and what it draws, as for any card, and no note on its size
  expect(String(r.result)).toContain('run 42  passed')
  expect(String(r.result)).not.toContain('rows tall')
  expect(String(r.result)).not.toContain('The analyst')
  const row = callRow('toolu_made_up_51', input)
  let els = elements(await $.ui.render(row))
  expect(els.find(n => n.type === 'Client')?.props.props).toMatchObject({ tree: null, need: '', cap: 0 })
  expect(els.some(n => n.props?.key === 'more' || n.props?.key === 'head-keys' || n.props?.key === 'title-ask')).toBe(false)
  // on screen, it takes no keys: the view's `o` is typed
  await shown($, row)
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  expect((await edit('o')).text).toBe('o')
  // one model call: the card check, which reads the card as drawn and its view
  await settle()
  expect(asked).toHaveLength(1)
  expect(String(asked[0].prompt)).toContain('run 42  passed')
  expect(String(asked[0].prompt)).toContain('// TALL')
  expect(JSON.stringify(asked[0].system)).toContain('PROMPT card-check')
  go()
  const props = await drawnOnce($, row)
  expect(props.tree).toEqual(TREE)
  els = elements(await $.ui.render(row))
  expect(els.some(n => n.props?.key === 'more')).toBe(false)
  expect(asked).toHaveLength(1)
  // a card that fits from the first draws at once, with no check, and its call says nothing of it
  const small = { title: 'Scores', data: 'runs.json', view: VIEW }
  const r3 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_52', ...small } as never)) as Any
  expect(String(r3.result)).not.toContain('rows tall')
  const fits = elements(await $.ui.render(callRow('toolu_made_up_52', small)))
  expect(fits.find(n => n.type === 'Client')?.props.props).toMatchObject({ tree: TREE, cap: 0 })
  await settle()
  expect(asked).toHaveLength(1)
})

test('a replacement that still does not fit draws its first 30 rows and `+N rows`, a click on which opens the rest, with no second check', async ($, on) => {
  world(on)
  const { asked } = checker(on, [`${VIEW}\n// ROWS 35`])
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Every run', data: 'runs.json', view: `${VIEW}\n// TALL` }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_55', ...input } as never)
  const row = callRow('toolu_made_up_55', input)
  const props = await drawnOnce($, row)
  expect(props.cap).toBe(30)
  let els = elements(await $.ui.render(row))
  const more = els.find(n => n.type === 'Button' && n.props?.key === 'more')
  expect(textOf(more)).toBe('+5 rows')
  const ui = await $.ui.mount({ plugin: 'thimble', ...(row as Any) })
  await ui.press({ key: 'more' })
  await ui.unmount()
  els = elements(await $.ui.render(row))
  expect(els.find(n => n.type === 'Client')?.props.props.cap).toBe(0)
  expect(asked).toHaveLength(1)
})

test('a version Claude draws while the check reads the one before waits for its own check, and the first check draws nothing', async ($, on) => {
  const w = world(on)
  const { asked, gate } = checker(on, [`${VIEW}\n// first check`, `${VIEW}\n// ROWS 20`])
  const go = gate.hold()
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Every run', data: 'runs.json', view: `${VIEW}\n// TALL` }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_56', ...input } as never)) as Any
  const id = /Its id is "(c[0-9a-f]+)"/.exec(String(r.result))![1]
  await $.ui.render(callRow('toolu_made_up_56', input))
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_56b', id, edits: [{ old: '// TALL', new: '// ROWS 40' }] } as never)
  go()
  const props = await drawnOnce($, callRow('toolu_made_up_56', input))
  // the second check's replacement: 20 rows
  expect(props.tree.c).toHaveLength(20)
  expect(asked).toHaveLength(2)
  expect(Object.values(w.files).some(v => String(v).includes('// first check'))).toBe(false)
})

test('a check whose call fails leaves the card as it stands, its rest under `+N rows`, and says so on the failure line', async ($, on) => {
  world(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 529, usage: {} } }))
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Every run', data: 'runs.json', view: `${VIEW}\n// TALL` }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_59', ...input } as never)
  expect((await drawnOnce($, callRow('toolu_made_up_59', input))).cap).toBe(30)
  expect(textOf(await $.ui.render(BAND))).toContain('The card check of the card “Every run” failed: the API is overloaded.')
})

test("the check's replacement reaches main once: in its next card call's answer while its turn runs, else beside its next prompt; the call that drew the card waits for nothing", async ($, on) => {
  world(on)
  on('prompt.submit', (_$: unknown, e: Any) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  checker(on, [`${VIEW}\n// ROWS 12`, `${VIEW}\n// ROWS 8`])
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Every run', data: 'runs.json', view: `${VIEW}\n// TALL` }
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_61', ...input } as never)) as Any
  const id = /Its id is "(c[0-9a-f]+)"/.exec(String(r.result))![1]
  expect(String(r.result)).not.toContain('card check')
  expect((await drawnOnce($, callRow('toolu_made_up_61', input))).tree.c).toHaveLength(12)
  // main's turn runs on: its next card call's answer says what the analyst sees in place of the card it drew
  const small = { title: 'Scores', data: 'runs.json', view: VIEW }
  const next = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_62', ...small } as never)) as Any).result)
  expect(next).toContain(`thimble's card check replaced the card “Every run” (id "${id}") in place, since it did not fit on the analyst's screen, so the analyst sees its version, not yours. It changed the view. What it draws, 92 columns wide:\nrun 1  passed`)
  expect(next).toContain('run 12  passed')
  expect(next).not.toContain('run 13  passed')
  // told once
  const after = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_64', ...small } as never)) as Any).result)
  expect(after).not.toContain('card check')
  // the check of the next card ends after main's turn: main's next prompt carries it, once
  const stages = { title: 'Every stage', data: 'runs.json', view: `${VIEW}\n// TALL` }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_63', ...stages } as never)
  await drawnOnce($, callRow('toolu_made_up_63', stages))
  const told = String((((await $.prompt.submit({ text: 'And now?', origin: { kind: 'composer' } } as never)) as Any).context ?? []).join('\n'))
  expect(told).toContain("thimble's report")
  expect(told).toContain('replaced the card “Every stage”')
  expect(told).toContain('run 8  passed')
  expect(String((((await $.prompt.submit({ text: 'And then?', origin: { kind: 'composer' } } as never)) as Any).context ?? []).join('\n'))).not.toContain('card check')
})

test('a card a resumed session finds waiting for its check draws as it stands', async ($, on) => {
  const w = world(on)
  // the card as tool.ts kept it, held, when the session ended
  const dir = '/made-up/.thimble/conversations/s-cards/cards/c0123456789ab'
  const meta = { id: 'c0123456789ab', version: 1, title: 'Every run', toolUseId: 'toolu_made_up_57', agentId: null, anchorRow: null, keys: [], read: '42 rows', columns: ['run'], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_57: { version: 1 } }, at: 1, held: { since: 1 } }
  w.files[`${dir}/meta.json`] = JSON.stringify(meta)
  w.files[`${dir}/v1/view.js`] = `${VIEW}\n// TALL`
  w.dirs['/made-up/.thimble/conversations/s-cards/cards'] = ['c0123456789ab']
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const client = elements(await $.ui.render(callRow('toolu_made_up_57', { title: 'Every run', data: 'runs.json', view: VIEW }))).find(n => n.type === 'Client')
  // its Client asks for its drawing, which a held card's never does
  expect(client?.props.props.need).toBe('1:92:0')
})

test("the Client cuts a drawing at the frame's `cap` rows, and draws it whole without one", async () => {
  const el = (type: string) => (p: Any) => ({ type, props: p })
  const surface: Any = { elements: { Box: el('Box'), Text: el('Text'), Button: el('Button') }, columns: 60, rows: 0, post: () => undefined, onPointer: () => undefined }
  expect((Card as Any)({ tree: TALL, width: 60, cap: 30 }, surface).props).toMatchObject({ height: 30, overflow: 'hidden' })
  expect((Card as Any)({ tree: TALL, width: 60 }, surface).props.height).toBeUndefined()
})

test("a border the view gives no color of its own draws dim, as the card's frame does; one with a color keeps it", async () => {
  const el = (type: string) => (p: Any) => ({ type, props: p })
  const surface: Any = { elements: { Box: el('Box'), Text: el('Text'), Button: el('Button') }, columns: 60, rows: 0, post: () => undefined, onPointer: () => undefined }
  const boxes = { t: 'Box', p: { flexDirection: 'column' }, c: [
    { t: 'Box', p: { borderStyle: 'round', paddingX: 1 }, c: [{ t: 'Text', p: {}, c: ['plain'] }] },
    { t: 'Box', p: { borderStyle: 'single', borderColor: '#80b2ea' }, c: [{ t: 'Text', p: {}, c: ['colored'] }] },
  ] }
  const drawn = elements((Card as Any)({ tree: boxes, width: 60 }, surface)).filter(n => n.type === 'Box' && n.props.borderStyle)
  expect(drawn.map(n => [n.props.borderStyle, n.props.borderDimColor, n.props.borderColor])).toEqual([['round', true, undefined], ['single', undefined, '#80b2ea']])
})

test('a card one row past 30 draws whole, since a `+1 row` line would take the place of that row; two rows past, it waits for the card check, and draws 30 rows and `+2 rows` when the check keeps it', async ($, on) => {
  world(on)
  const { asked } = checker(on, [''])
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const one = { title: 'Every run', data: 'runs.json', view: `${VIEW}\n// ROWS 31` }
  const r1 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_53', ...one } as never)) as Any
  expect(String(r1.result)).not.toContain('its frame shows')
  const whole = elements(await $.ui.render(callRow('toolu_made_up_53', one)))
  expect(whole.find(n => n.type === 'Client')?.props.props.cap).toBe(0)
  expect(whole.some(n => n.props?.key === 'more')).toBe(false)
  const two = { title: 'Every run', data: 'runs.json', view: `${VIEW}\n// ROWS 32` }
  const r2 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_54', ...two } as never)) as Any
  expect(String(r2.result)).not.toContain('its frame shows')
  // the check writes no replacement: the card draws as it stands
  expect((await drawnOnce($, callRow('toolu_made_up_54', two))).cap).toBe(30)
  const cut = elements(await $.ui.render(callRow('toolu_made_up_54', two)))
  const more = cut.find(n => n.type === 'Button' && n.props?.key === 'more')
  expect(textOf(more)).toBe('+2 rows')
  expect(more.props.label).toBe('show the other 2 rows of the card')
  expect(asked).toHaveLength(1)
})

test('the line under a cut card says "row" for one', () => {
  expect([rowsCut(30), rowsCut(31), rowsCut(32), rowsCut(42)]).toEqual([0, 0, 2, 12])
  expect([rowsWord(1), rowsWord(2), rowsWord(12)]).toEqual(['1 row', '2 rows', '12 rows'])
})

// ------------------------------------------------------------------------------------------------- ready kinds

/** The data and view of a card's version as the tool kept them. */
const versionOf = (w: Any, v: number) => {
  const at = (name: string) => Object.entries(w.files).find(([p]) => new RegExp(`/v${v}/${name}$`).test(p))?.[1] as string | undefined
  const rows = at('rows\\.json')
  return { view: at('view\\.js'), data: rows === undefined ? undefined : JSON.parse(rows) }
}
const metaIn = (w: Any) => JSON.parse(Object.entries(w.files).find(([p]) => p.endsWith('/meta.json'))![1] as string)

test("a ready kind draws from the data the call gives: its version keeps the kind, the answer and the rows, with thimble's view; the call says what the card is, and so does its line", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Which agents passed?', kind: 'table', answer: 'Both agents passed.', rows: [{ agent: 'ada', runs: 3 }, { agent: 'bram', runs: 5 }] }
  const r = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_k1', ...input } as never)) as Any).result)
  expect(r).toContain('“Which agents passed?” is drawn where this call stands')
  expect(r).toContain('It is a table of 2 rows, with the columns name, score.')
  expect(r).not.toContain('The first row:')
  expect(r).toContain('ada 3\nbram 5')
  expect(w.asked).toEqual(['ping', 'load'])
  expect(versionOf(w, 1)).toEqual({ view: STUB, data: { kind: 'table', answer: 'Both agents passed.', rows: input.rows } })
  expect(metaIn(w).kind).toBe('table')
  const line = textOf(await $.ui.render(callRow('toolu_made_up_k1', input)))
  expect(line.startsWith('● Drew card “Which agents passed?” · a table of 2 rows')).toBe(true)
})

test("a call with a ready card's id changes only what it gives: an answer keeps the rows, rows keep the answer, a kind keeps what the two kinds share; edits are a custom view's", async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const rows = [{ agent: 'ada', runs: 3 }, { agent: 'bram', runs: 5 }]
  const first = { title: 'Runs per agent', kind: 'table', answer: 'bram ran most.', rows }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_k2', ...first } as never)
  // the terminal's fullscreen layout, where the card's first place can be drawn again
  await $.ui.render(callRow('toolu_made_up_k2', first))
  const id = metaIn(w).id
  const r2 = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_k2b', id, answer: 'bram ran 5 times.' } as never)) as Any).result)
  expect(r2).toContain('Version 2 of “Runs per agent” is drawn in place of version 1')
  expect(versionOf(w, 2).data).toEqual({ kind: 'table', answer: 'bram ran 5 times.', rows })
  expect(textOf(await $.ui.render(callRow('toolu_made_up_k2b', { id, answer: 'bram ran 5 times.' })))).toBe('● Changed card “Runs per agent” to version 2 (new answer) · ↑ shown in its place above')
  const more = [...rows, { agent: 'cleo', runs: 1 }]
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_k2c', id, rows: more } as never)
  expect(versionOf(w, 3).data).toEqual({ kind: 'table', answer: 'bram ran 5 times.', rows: more })
  // a table's rows drawn as a chart, in its place
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_k2d', id, kind: 'chart', mark: 'bar', x: 'agent', y: 'runs' } as never)
  expect(versionOf(w, 4)).toEqual({ view: STUB, data: { kind: 'chart', answer: 'bram ran 5 times.', rows: more, mark: 'bar', x: 'agent', y: 'runs' } })
  expect(metaIn(w).kind).toBe('chart')
  const r5 = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_k2e', id, edits: [{ old: 'a', new: 'b' }] } as never)) as Any).result)
  expect(r5).toBe("The card did not draw: `edits` change a custom card's view; a chart card changes by its fields: give the ones that change (answer, rows, mark, x, y, x2, color).")
  // a custom view in its place, over the data the card has
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_k2f', id, view: VIEW } as never)
  expect(versionOf(w, 5)).toEqual({ view: VIEW, data: versionOf(w, 4).data })
  expect(metaIn(w).kind).toBe(undefined)
})

test('a ready kind whose data lacks what it needs, or names what the rows do not have, draws nothing and says what to fix', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  let k = 0
  const call = async (input: Record<string, unknown>) => String(((await $.tool.call({ tool: TOOL, tool_use_id: `toolu_made_up_kc${k++}`, title: 'A question', ...input } as never)) as Any).result)
  const rows = [{ agent: 'ada', runs: 3 }]
  expect(await call({ rows })).toBe("The card did not draw: give the card's `kind`: example, table, chart, timeline, diagram, note, which thimble draws from their data, or custom, with a `view`.")
  expect(await call({ kind: 'pie', rows })).toBe('The card did not draw: no kind pie: the kinds are example, table, chart, timeline, diagram, note, or custom, with a `view`.')
  expect(await call({ kind: 'table' })).toBe('The card did not draw: a table needs `rows`, a list of rows, each an object of its columns.')
  expect(await call({ kind: 'chart', rows, x: 'agnt', y: 'runs' })).toBe('The card did not draw: the chart\'s x, "agnt", names a column no row has; the rows\' columns are agent, runs.')
  expect(await call({ kind: 'chart', mark: 'line', rows, x: 'agent' })).toBe('The card did not draw: a line chart needs `y`: the column of its rows to draw there.')
  expect(await call({ kind: 'chart', mark: 'pie', rows, x: 'agent' })).toBe("The card did not draw: a chart's `mark` is one of bar, line, scatter, dots, range, heatmap, not pie.")
  expect(await call({ kind: 'timeline', events: [{ time: '09:14', label: 'starts' }, { label: 'ends' }] })).toBe('The card did not draw: event 2 of the timeline has no `time`: each event is {time, label}, or [time, label].')
  expect(await call({ kind: 'diagram', edges: [['a', 'b'], ['b']] })).toBe('The card did not draw: edge 2 of the diagram has no source or no target: each edge is [source, target, label] or {source, target, label}.')
  expect(await call({ kind: 'note', text: ' ' })).toBe('The card did not draw: a note needs `text`, a few sentences.')
  expect(await call({ kind: 'example', refs: [] })).toBe('The card did not draw: an example needs `refs`, the records it shows: "path#L12", "path#L3-L9", or {ref, quote}.')
  expect(w.asked).not.toContain('load')
})

test("an example's records are read from their files: a JSON record by the field that holds the quote, with its short fields; lines of a file; two passages of one record in that record; a quote not in its record is refused with the record's place", async ($, on) => {
  const chat = [
    JSON.stringify({ id: '0000447e-ad6e-40be-b20c-2b5354bcab08', speaker: 'o3', created_at: '2026-02-11 15:30:12', content: 'Good news everyone! I just bought signal-garden.com for $12.99 using the credits the organizers gave us.' }),
    JSON.stringify({ speaker: 'Claude', content: 'Please do not spend money.' }),
  ].join('\n')
  const code = 'def is_forgiven(day, history):\n    prev = previous_scheduled(day, history)\n    if prev is None or prev.status != "completed":\n        return False\n'
  const sizes: Record<string, number> = { [`${DATA}/chat.jsonl`]: chat.length, [`${DATA}/app/streaks.py`]: code.length }
  const w = world(on, { stat: p => (p in sizes ? { kind: 'file', size: sizes[p], mtimeMs: 0, isLink: false, realPath: p } : undefined) })
  w.files[`${DATA}/chat.jsonl`] = chat
  w.files[`${DATA}/app/streaks.py`] = code
  w.files[`${DATA}/secret.json`] = '{"a": 1}'
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const refs = [
    { ref: 'chat.jsonl#L1', quote: 'I just bought signal-garden.com for $12.99' },
    { ref: 'chat.jsonl#L1', quote: 'the credits the organizers gave us' },
    'app/streaks.py#L2-L3',
    { ref: 'chat.jsonl', quote: 'do not spend money' },
  ]
  const r = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_ke', title: 'Did an agent spend money?', kind: 'example', answer: 'o3 bought a domain.', refs } as never)) as Any).result)
  expect(r).toContain('It is an example of 3 records')
  const got = versionOf(w, 1).data.refs
  const record = JSON.parse(chat.split('\n')[0]!).content as string
  expect(got[0]).toEqual({
    ref: 'chat.jsonl#L1', path: 'chat.jsonl', line: 1, field: 'content', text: record, context: 'created_at 2026-02-11 15:30:12 · speaker o3',
    spans: [[record.indexOf('I just'), record.indexOf('I just') + 42], [record.indexOf('the credits'), record.indexOf('the credits') + 34]],
  })
  expect(got[1]).toEqual({ ref: 'app/streaks.py#L2-L3', path: 'app/streaks.py', line: 2, end: 3, text: '    prev = previous_scheduled(day, history)\n    if prev is None or prev.status != "completed":', spans: [] })
  expect(got[2]).toEqual({ ref: 'chat.jsonl', path: 'chat.jsonl', line: 2, field: 'content', text: 'Please do not spend money.', spans: [[7, 25]], context: 'speaker Claude' })
  let k = 0
  const call = async (refs: unknown[]) => String(((await $.tool.call({ tool: TOOL, tool_use_id: `toolu_made_up_kx${k++}`, title: 'A question', kind: 'example', refs } as never)) as Any).result)
  expect(await call([{ ref: 'chat.jsonl#L1', quote: 'I sold the domain' }])).toBe('The card did not draw: refs[1]: the quote "I sold the domain" is not in chat.jsonl at line 1. Quote the record\'s words exactly, or cite the record without a quote.')
  expect(await call(['chat.jsonl#L9'])).toBe('The card did not draw: refs[1]: chat.jsonl has 2 lines, not 9.')
  expect(await call(['app/streaks.py#L1', 'none.log#L2'])).toBe('The card did not draw: refs[2]: there is no file at none.log.')
  expect(await call(['escape.json#L1'])).toBe('The card did not draw: refs[1]: escape.json is outside this folder and the temp folder ($TMPDIR).')
  expect(await call(['secret.json#L1'])).toBe('The card did not draw: refs[1]: a made-up deny rule.')
})

test("a ready kind's data may come from a data file Claude's code wrote: a list is its rows, an object its fields; the call's own fields come first", async ($, on) => {
  const w = world(on)
  w.files[`${DATA}/runs.json`] = JSON.stringify([{ agent: 'ada', runs: 3 }, { agent: 'bram', runs: 5 }])
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const r = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_kd', title: 'Runs', kind: 'chart', mark: 'bar', x: 'agent', y: 'runs', answer: 'bram ran most.', data: 'runs.json' } as never)) as Any).result)
  expect(r).toContain('It is a bar chart of 2 rows from runs.json')
  expect(versionOf(w, 1).data).toEqual({ kind: 'chart', answer: 'bram ran most.', rows: [{ agent: 'ada', runs: 3 }, { agent: 'bram', runs: 5 }], mark: 'bar', x: 'agent', y: 'runs' })
  w.files[`${DATA}/runs.json`] = JSON.stringify({ events: [{ time: '09:14', label: 'starts' }], answer: 'It started at 09:14.' })
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_kd2', title: 'When', kind: 'timeline', answer: 'At 09:14.', data: 'runs.json' } as never)
  expect(versionOf(w, 1).data).toBeDefined()
  const t = Object.entries(w.files).filter(([p]) => /\/v1\/rows\.json$/.test(p)).map(([, v]) => JSON.parse(v as string)).find(d => d.kind === 'timeline')
  expect(t).toEqual({ kind: 'timeline', answer: 'At 09:14.', events: [{ time: '09:14', label: 'starts' }] })
})

test("a ready card that does not fit waits for the card check as any card does; a replacement that keeps thimble's view stays of the card's kind", async ($, on) => {
  const w = world(on)
  const { asked } = checker(on, [STUB])
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_kp', title: 'Every run', kind: 'table', answer: 'TALL: every run passed.', rows: [{ run: 1, passed: true }] } as never)
  const id = metaIn(w).id
  const metaOf = () => JSON.parse(Object.entries(w.files).find(([p]) => p.endsWith(`/${id}/meta.json`))![1] as string)
  for (let i = 0; i < 200 && metaOf().version < 2; i++) await settle()
  expect(asked).toHaveLength(1)
  expect(String(asked[0].prompt)).toContain(STUB.trim())
  expect([metaOf().version, metaOf().kind, metaOf().read]).toEqual([2, 'table', 'a table of 1 row'])
  expect(versionOf(w, 2).view!.trim()).toBe(STUB.trim())
  expect(versionOf(w, 2).data).toEqual({ kind: 'table', answer: 'TALL: every run passed.', rows: [{ run: 1, passed: true }] })
})

test("p on a ready card whose data came in its call gives the artifact's fork a copy of the card's data in the temp folder, which it reads without a dialog", async ($, on) => {
  const w = world(on, { prompts: { artifact: 'ARTIFACT {{TITLE}} | {{FILE}}' } })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Runs', kind: 'table', answer: 'Two agents.', rows: [{ agent: 'ada', runs: 3 }] }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_ka', ...input } as never)
  const id = metaIn(w).id
  await (await shown($, callRow('toolu_made_up_ka', input))).unmount()
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'p' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'p' } as never)
  await w.clock.advance(100)
  await w.clock.advance(300)
  expect(w.forks.length).toBe(1)
  const copy = w.runs.find(a => a[0] === 'cp' && String(a[3]).endsWith(`/card-${id}.json`))!
  expect(copy[2]).toMatch(new RegExp(`/${id}/v1/rows\\.json$`))
  expect(copy[3]).toMatch(/^\/made-up\/tmp\//)
  expect(w.forks[0].prompt).toBe(`ARTIFACT Runs | ${copy[3]}`)
})

test("an example's record in a file too large to read whole is read a line range at a time, and a quote without a line is found with grep and checked in its record", async ($, on) => {
  const big = [
    JSON.stringify({ speaker: 'o3', content: 'Nothing to report today.' }),
    JSON.stringify({ speaker: 'o3', content: 'I bought a domain for $12.99 with the credits.' }),
    JSON.stringify({ speaker: 'Claude', content: 'Please do not spend money.' }),
  ].join('\n')
  // larger than the 4 MB thimble reads whole
  const w = world(on, { stat: p => (p === `${DATA}/big.jsonl` ? { kind: 'file', size: 5_000_000, mtimeMs: 0, isLink: false, realPath: p } : undefined) })
  w.files[`${DATA}/big.jsonl`] = big
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const r = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_kb', title: 'Did an agent spend money?', kind: 'example', refs: ['big.jsonl#L3', { ref: 'big.jsonl', quote: 'bought a domain for $12.99' }] } as never)) as Any).result)
  expect(r).toContain('It is an example of 2 records')
  expect(versionOf(w, 1).data.refs.map((x: Any) => [x.line, x.field, x.text, x.spans])).toEqual([
    [3, 'content', 'Please do not spend money.', []],
    [2, 'content', 'I bought a domain for $12.99 with the credits.', [[2, 28]]],
  ])
  expect(w.runs.some(a => a[0] === 'sed' && a[2] === '3,3p;3q')).toBe(true)
  expect(w.runs.find(a => a[0] === 'grep')!.slice(5, 7)).toEqual(['--', 'bought a domain for $12.99'])
})

test("an example's record is found from the folder the session started in when the shell has moved on, and a range a quote names is read as the one line that holds it, by its field", async ($, on) => {
  const chat = [
    JSON.stringify({ speaker: 'o3', content: 'Nothing to report today.' }),
    JSON.stringify({ speaker: 'o3', request_id: 'req_011CeNhasyfVVd4eNcwv3Anm', content: 'I bought a domain for $12.99 with the credits.' }),
  ].join('\n')
  const w = world(on, { cwd: `${DATA}/build`, stat: p => (p === `${DATA}/chat.jsonl` ? { kind: 'file', size: chat.length, mtimeMs: 0, isLink: false, realPath: p } : undefined) })
  w.files[`${DATA}/chat.jsonl`] = chat
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const r = String(((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_kr', title: 'Did an agent spend money?', kind: 'example', refs: [{ ref: 'chat.jsonl#L1-L2', quote: 'bought a domain for $12.99' }] } as never)) as Any).result)
  expect(r).toContain('It is an example of 1 record')
  // its id is no context for the analyst
  expect(versionOf(w, 1).data.refs).toEqual([{ ref: 'chat.jsonl#L1-L2', path: 'chat.jsonl', line: 2, field: 'content', text: 'I bought a domain for $12.99 with the credits.', spans: [[2, 28]], context: 'speaker o3' }])
})
