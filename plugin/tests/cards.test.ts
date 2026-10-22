// Cards' hooks (cards/): a card call keeps the card and answers what it read and its text copy; the call's row draws
// the one Client with the runner's tree; a new version draws at the newer call; a key at an empty prompt, and a burst
// of keys, reach the card on screen that takes them; a card a designer fork drew draws under its answer. The runner is answered here, at http.fetch (cards/test/runner.test.mjs tests the real one).
// All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const DATA = '/made-up/data'
const TOOL = 'mcp__thimble__card'
const TREE = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['ada 3'] }, { t: 'Text', p: {}, c: ['bram 5'] }] }
const SORTED = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['bram 5'] }, { t: 'Text', p: {}, c: ['ada 3'] }] }
const VIEW = 'const keys = "s"\nfunction onKey(k, s) { s.setState({ sorted: true }) }\nfunction view(p, s) { return s.elements.Text({ children: "x" }) }'

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

function world(on: Any, o: { crash?: string } = {}) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  const files: Record<string, string> = {}
  const asked: string[] = []
  on('session.id', () => ({ value: 's-cards' }))
  on('session.cwd', () => ({ value: DATA }))
  on('session.root', () => ({ value: DATA }))
  on('session.usage', () => ({ value: {} }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__thimble__${e.name}` } }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  const dirs: Record<string, string[]> = {}
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: (dirs[e.path ?? ''] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.stat', (_$: unknown, e: { path: string }) => ({
    // escape.json looks local but its real target is outside every allowed root (a symlink out of the folder)
    value: e.path === `${DATA}/escape.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: true, realPath: '/etc/shadow' }
      : e.path === `${DATA}/runs.json` || e.path === `${DATA}/secret.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: false, realPath: e.path }
        : e.path === DATA || e.path === '/made-up/tmp' ? { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path }
          : { kind: 'missing', size: 0, mtimeMs: 0, isLink: false },
  }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('http.fetch', (_$: unknown, e: { url: string; init?: { body?: string } }) => {
    const op = e.url.replace('http://runner/', '')
    asked.push(op)
    // a view that takes all the runner's memory: the socket closes while it answers
    if (op === o.crash) throw new Error('made-up: socket hang up')
    const body = JSON.parse(e.init?.body || '{}')
    const answers: Record<string, unknown> = {
      ping: { ok: true },
      load: { ok: true, tree: TREE, state: 'null', keys: /const keys = "([^"]*)"/.exec(String(body.view ?? ''))?.[1] ?? '', lines: ['ada 3', 'bram 5'], cut: [], summary: { rows: 2, read: '2 rows', columns: ['name', 'score'], first: '{"name":"ada","score":3}' } },
      key: { ok: true, handled: body.key === 's', tree: SORTED, state: '{"sorted":true}' },
      draw: { ok: true, tree: TREE, state: 'null' },
      copy: { ok: true, lines: ['ada 3', 'bram 5'], cut: [] },
      undo: { ok: true, tree: TREE, state: 'null' },
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers[op] ?? { ok: false, error: 'no such request' }) } }
  })
  // the person's permission rules: a deny rule for reading `secret.json`
  on('tool.check', (_$: unknown, e: Any) => (e.tool === 'Read' && String(e.input?.file_path).endsWith('secret.json') ? { decision: 'deny', reason: 'a made-up deny rule', rule: 'Read(./secret.json)' } : { decision: 'allow' }) as never)
  on('ui.render', (_$: unknown, e: Any) => ({ type: 'Text', props: {}, children: [e.props?.output ?? 'the engine'] }) as never)
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  return { files, asked, dirs, clock }
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
  expect(JSON.parse(meta![1]).keys).toEqual(['s'])
  expect(Object.keys(w.files).filter(p => /\/v1\/view\.js$/.test(p))).toEqual([expect.any(String)])

  const row = await $.ui.render(callRow('toolu_made_up_1', input))
  const client = elements(row).find(n => n.type === 'Client')
  expect(client?.props.module).toContain('client.tsx')
  expect(client?.props.props.tree).toEqual(TREE)
  // once its Client says it is drawn, the card is on screen and lists the keys that reach it
  const id = JSON.parse(meta![1]).id
  await shown($, callRow('toolu_made_up_1', input))
  expect(textOf(await $.ui.render(callRow('toolu_made_up_1', input)))).toContain('keys s at an empty prompt')

  // a new version stands at the newer call; the first call points to it
  const r2 = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_1b', ...input, id } as never)) as Any
  expect(String(r2.result)).toContain('Version 2 of “Scores” is drawn where this call stands')
  const second = await $.ui.render(callRow('toolu_made_up_1b', input))
  expect(elements(second).some(n => n.type === 'Client')).toBe(true)
  const first = await $.ui.render(callRow('toolu_made_up_1', input))
  expect(elements(first).some(n => n.type === 'Client')).toBe(false)
  // the earlier call's result line says where the card is now, in place of what it read
  const result = await $.ui.render({ ...(callRow('toolu_made_up_1', input) as Any), component: 'ToolResult', props: { tool_use_id: 'toolu_made_up_1', tool: TOOL, output: 'the copy', isExpanded: false } } as never)
  expect(textOf(result)).toBe('↓ version 1 · “Scores” is drawn further down, as version 2')
})

test('a key at an empty prompt reaches the focused card when it lists the key, and other keys type', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_2', title: 'Scores', data: 'runs.json', view: VIEW } as never)
  const edit = (key: string, text = '') => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key } as never) as Any
  // a card not yet on screen takes no keys
  expect((await edit('s')).text).toBe('s')
  await shown($, callRow('toolu_made_up_2', { title: 'Scores', data: 'runs.json', view: VIEW }))
  expect(await edit('s')).toEqual({ text: '', cursor: 0 })
  expect(w.asked).toContain('key')
  const row = await $.ui.render(callRow('toolu_made_up_2', { title: 'Scores', data: 'runs.json', view: VIEW }))
  expect(elements(row).find(n => n.type === 'Client')?.props.props.tree).toEqual(SORTED)
  // a letter typed straight after a key the card took: a word that starts with that key, which goes back whole
  expect((await edit('q')).text).toBe('sq')
  expect(w.asked).toContain('undo')
  await w.clock.advance(1000)
  expect((await edit('q')).text).toBe('q')
  expect((await edit('s', 'a')).text).toBe('as')
  // keys that come quickly arrive as one edit: each reaches the card; a burst with a letter no card takes is typed
  const burst = (inputText: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText } as never) as Any
  const keysBefore = w.asked.filter(x => x === 'key').length
  expect(await burst('sss')).toEqual({ text: '', cursor: 0 })
  expect(w.asked.filter(x => x === 'key').length).toBe(keysBefore + 3)
  await w.clock.advance(1000)
  expect((await burst('sq')).text).toBe('sq')
})

test('a card scrolled out of view takes no keys, and the one in view does', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  const input = { title: 'Scores', data: 'runs.json', view: VIEW }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_4', ...input } as never)
  const at = (onScreen: Any) => ({ ...(callRow('toolu_made_up_4', input) as Any), props: { ...(callRow('toolu_made_up_4', input) as Any).props, onScreen } })
  await shown($, at({ first: 0, last: 9, of: 10 }))
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  expect(await edit('s')).toEqual({ text: '', cursor: 0 })
  await w.clock.advance(1000)
  await $.ui.render(at(null))
  expect((await edit('s')).text).toBe('s')
})

test('a card the designer fork drew draws under the answer v was pressed on, also in a resumed session', async ($, on) => {
  const w = world(on)
  // the card as tool.ts keeps a designer fork's call: its anchor is the answer's row
  const dir = '/made-up/.thimble/conversations/s-cards/cards/c0123456789ab'
  const meta = { id: 'c0123456789ab', version: 1, title: 'Scores', toolUseId: 'toolu_made_up_3', agentId: 'a-made-up', anchorRow: 'row-made-up', keys: ['s'], read: '2 rows', columns: ['name', 'score'], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_3: { version: 1 } }, at: 1 }
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
