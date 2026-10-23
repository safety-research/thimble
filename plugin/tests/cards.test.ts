// Cards' hooks (cards/): a card call keeps the card and answers what it read and its text copy; the call's row draws
// the one Client with the runner's tree; a new version draws in the card's place; a key at an empty prompt, and a burst
// of keys, reach the card on screen that takes them; a card a designer fork drew draws under its answer. The runner is answered here, at http.fetch (cards/test/runner.test.mjs tests the real one).
// All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

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

function world(on: Any, o: { crash?: string; ask?: boolean; sandbox?: Record<string, unknown>; firstSetupHangs?: boolean; refused?: boolean; wide?: boolean; env?: Record<string, string> } = {}) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', ...o.env })
  const clock = mock.clock(on, { now: 0 })
  const files: Record<string, string> = {}
  const asked: string[] = []
  // with `wide`, the runner's drawings say the width they are laid out at and whether a key sorted them
  let runnerWidth = 0
  let sorted = false
  let seq = 0
  // Claude Code's theme setting (/config), and the theme the runner was last asked to draw in (a light one says so)
  const look = { theme: 'dark', runner: 'dark' }
  on('config.list', () => ({ value: [{ key: 'theme', value: look.theme, isLocked: false }] }) as never)
  const laidOut = () => ({ t: 'Text', p: {}, c: [`${sorted ? 'sorted' : 'rows'} at ${runnerWidth}${look.runner === 'light' ? ' light' : ''}`] })
  on('session.id', () => ({ value: 's-cards' }))
  on('session.cwd', () => ({ value: DATA }))
  on('session.root', () => ({ value: DATA }))
  on('session.usage', () => ({ value: {} }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('session.end', () => ({ sessionId: 's-cards' }) as never)
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__thimble__${e.name}` } }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  const dirs: Record<string, string[]> = {}
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: (dirs[e.path ?? ''] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  // a path's real path, `.` and `..` folded
  const real = (p: string) => `/${p.split('/').reduce((a: string[], x) => (x === '..' ? a.slice(0, -1) : x && x !== '.' ? [...a, x] : a), []).join('/')}`
  on('fs.stat', (_$: unknown, e: { path: string }) => ({
    // escape.json looks local but its real target is outside every allowed root (a symlink out of the folder); so does
    // link.json in the temp folder
    value: e.path === `${DATA}/escape.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: true, realPath: '/etc/shadow' }
      : e.path.endsWith('/link.json') ? { kind: 'file', size: 64, mtimeMs: 0, isLink: true, realPath: '/made-up/home/.ssh/id' }
        : e.path === `${DATA}/runs.json` || e.path === `${DATA}/secret.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: false, realPath: e.path }
          : e.path === DATA || e.path.startsWith('/made-up/tmp') ? { kind: e.path.endsWith('.json') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: real(e.path) }
            : { kind: 'missing', size: 0, mtimeMs: 0, isLink: false },
  }))
  const spawned: string[][] = []
  const runs: string[][] = []
  let setups = 0
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    // the session start's setup.mjs installs srt on a slow network, and has not answered yet
    if (String(e.argv[1] ?? '').endsWith('/sandbox/setup.mjs') && setups++ === 0 && o.firstSetupHangs) return new Promise(() => undefined) as never
    return { value: { ...(tempRun(e.argv, o.sandbox) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$: unknown, e: { argv: string[] }) { spawned.push(e.argv); return { code: 0, signal: null } })
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('http.fetch', (_$: unknown, e: { url: string; init?: { body?: string } }) => {
    const op = e.url.replace('http://runner/', '')
    asked.push(op)
    // no runner listens when the sandbox cannot start
    if (o.sandbox?.ok === false) throw new Error('made-up: no such socket')
    // Claude Code refuses the plugin's requests, its Unix socket's too
    if (o.refused) return { deny: '$.http.fetch: refused: nonessential network traffic is disabled for this session' }
    // a view that takes all the runner's memory: the socket closes while it answers
    if (op === o.crash) throw new Error('made-up: socket hang up')
    const body = JSON.parse(e.init?.body || '{}')
    // a view that does not parse, and one that throws at a narrow width
    if (op === 'load' && String(body.view).includes('BROKEN')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: false, phase: 'view', error: 'the view does not parse (line 1): Unexpected token' }) } }
    if (op === 'draw' && body.width < 30) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: false, phase: 'draw', error: 'line 4: Invalid count value: -1' }) } }
    if (o.wide && (op === 'load' || op === 'draw') && body.width) runnerWidth = body.width
    if (body.theme === 'dark' || body.theme === 'light') look.runner = body.theme
    if (o.wide && op === 'key' && body.key === 'o') sorted = true
    if (o.wide && op !== 'load' && op !== 'copy' && op !== 'ping') return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, handled: body.key === 'o', tree: laidOut(), state: 'null', seq: ++seq }) } }
    // a view whose tree the terminal refuses: a Text whose bold is not a boolean
    const tree = String(body.view ?? '').includes('BOLD') ? { t: 'Text', p: { bold: 'yes' }, c: ['ada 3'] } : String(body.view ?? '').includes('SELECTED') ? PICKED : TREE
    const answers: Record<string, unknown> = {
      ping: { ok: true },
      load: {
        ok: true, tree, state: 'null', keys: /const keys = "([^"]*)"/.exec(String(body.view ?? ''))?.[1] ?? '', lines: ['ada 3', 'bram 5'], cut: [], summary: { rows: 2, read: '2 rows', columns: ['name', 'score'], first: '{"name":"ada","score":3}' },
        // a view with a row laid out for the card's width: it wraps at the narrower width a side pane leaves it
        ...(String(body.view ?? '').includes('WIDE_ROW') && body.beside > 0 && body.beside < body.width ? { beside: { width: body.beside, lines: ['ada 3 of 9', 'merged', 'bram 5'], cut: [], wrapped: [1] } } : {}),
      },
      key: { ok: true, handled: body.key === 'o', tree: SORTED, state: '{"sorted":true}' },
      draw: { ok: true, tree: TREE, state: 'null' },
      copy: { ok: true, lines: ['ada 3', 'bram 5'], cut: [] },
      undo: { ok: true, tree: TREE, state: 'null' },
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ...(answers[op] ?? { ok: false, error: 'no such request' }) as object, ...(o.wide ? { seq: ++seq } : {}) }) } }
  })
  // the person's permission rules: a deny rule for reading `secret.json`; with `ask`, the mode asks about every file
  // outside the folder, and a rule of the person's asks about made-up/tmp/mine
  on('tool.check', (_$: unknown, e: Any) => (e.tool === 'Read' && String(e.input?.file_path).endsWith('secret.json') ? { decision: 'deny', reason: 'a made-up deny rule', rule: 'Read(./secret.json)' }
    : o.ask && String(e.input?.file_path).startsWith('/made-up/tmp/mine') ? { decision: 'ask', rule: 'Read(/made-up/tmp/mine/**)' }
      : o.ask && !String(e.input?.file_path).startsWith(DATA) ? { decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' } : { decision: 'allow' }) as never)
  on('ui.render', (_$: unknown, e: Any) => ({ type: 'Text', props: {}, children: [e.props?.output ?? 'the engine'] }) as never)
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  return { files, asked, dirs, clock, spawned, runs, look }
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
  expect(textOf(await resultOf('toolu_made_up_1b'))).toBe('↑ version 2 · “Scores” is drawn in its place above')
  expect(textOf(await resultOf('toolu_made_up_1'))).toBe('2 rows from runs.json')

  // a small change: edits to the view, its rows and title kept (no `view`, no `data`, no `title`)
  const r3 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1c', id, edits: [{ old: 'children: "x"', new: 'children: "y"' }] } as never)) as Any
  expect(String(r3.result)).toContain('Version 3 of “Scores” is drawn')
  expect(String(r3.result)).toContain('It read 2 rows from runs.json')
  expect(Object.entries(w.files).find(([p]) => /\/v3\/view\.js$/.test(p))?.[1]).toBe(VIEW.replace('children: "x"', 'children: "y"'))
  expect(textOf(await resultOf('toolu_made_up_1b'))).toBe('↑ version 2 · “Scores” is drawn in its place above, now version 3')
  // an edit whose text is not in the view draws nothing, and says why
  const r4 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1d', id, edits: [{ old: 'no such text', new: 'z' }] } as never)) as Any
  expect(String(r4.result)).toContain('edit 1: its `old` text is not in the view of your last call')
  // a new card needs a title
  const r5 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1e', data: 'runs.json', view: VIEW } as never)) as Any
  expect(String(r5.result)).toContain('`title` is empty')
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

test('a card at each width: in a side pane the card and its copy each draw at their own width, a post sent before the frame narrowed is answered at its width now, a drawing that fails at a narrow width holds only there, and a row that wraps beside a pane is named', async ($, on) => {
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
    expect(narrowed.props.need).toBe('1:62')
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
  // a row that fits the card but wraps at the width a side pane leaves it: the call answers that copy too
  {
    const plain = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_17', title: 'Scores', data: 'runs.json', view: VIEW } as never)) as Any
    expect(String(plain.result)).not.toContain('side pane')
    const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_18', title: 'Scores', data: 'runs.json', view: `${VIEW}\n// WIDE_ROW` } as never)) as Any
    expect(String(r.result)).toMatch(/When a side pane opens beside the conversation, the card is \d+ columns wide, and rows that fit at \d+ columns wrap there, out of their columns \(line 1\):\nada 3 of 9\nmerged\nbram 5/)
  }
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
  expect(elements(first).find(n => n.type === 'Client')?.props.props.need).toBe('1:92')
  await $.ui.mount({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: 'row-made-up', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text: 'An answer.', isFirstOfReply: true } } as never)
  expect(w.asked).toContain('draw')
  expect(elements(await answer('row-made-up')).find(n => n.type === 'Client')?.props.props.tree).toEqual(TREE)
  expect(textOf(await answer('another-row'))).not.toContain('Scores')
  // its call's row in the fork draws no second card
  const row = await $.ui.render(callRow('toolu_made_up_3', { title: 'Scores', data: 'runs.json', view: VIEW }))
  expect(elements(row).some(n => n.type === 'Client')).toBe(false)
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

test('keys at an empty prompt: letters only, never a slash command; a word that starts with a card key and v goes back whole', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  // the view asks for "a" and "/"; the card gets the letter only
  const view = 'const keys = "a/"\nfunction onKey(k, s) {}\nfunction view(p, s) { return s.elements.Text({ children: "x" }) }'
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_6', title: 'Scores', data: 'runs.json', view } as never)) as Any
  expect(String(r.result)).toContain('a card takes letters only, so it does not get /')
  await shown($, callRow('toolu_made_up_6', { title: 'Scores', data: 'runs.json', view }))
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  const meta = JSON.parse(Object.entries(w.files).find(([p]) => p.endsWith('/meta.json'))![1])
  expect(meta.keys).toEqual(['a'])
  expect((await edit('/')).text).toBe('/')
  await w.clock.advance(1000)
  // "a" then "v" straight after (the person types "available"): a word, and v starts nothing
  expect(await edit('a')).toEqual({ text: '', cursor: 0 })
  expect((await edit('v')).text).toBe('av')
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
  // the call's result row says the whole reason and the fix
  const result = textOf(await $.ui.render({ ...(callRow('toolu_made_up_8', {}) as Any), component: 'ToolResult', props: { tool_use_id: 'toolu_made_up_8', tool: TOOL, output: 'the copy', isExpanded: false } } as never))
  expect(result).toContain('bubblewrap (bwrap) not installed. Install it: sudo apt-get install bubblewrap · Claude got the error')
})

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
