// Cards' hooks (cards/): a card call keeps the card and answers what it read and its text copy; the call's row draws
// the one Client with the runner's tree; a new version draws in the card's place, and a view that does not parse is
// fixed with edits; a card's link alone on a line of a reply draws the card there; a key at an empty prompt reaches the
// card on screen that takes it; a card taller than its frame waits for the card check. The person's permission rules, a
// data file whose real path leaves the folder, and a sandbox that cannot start each keep the card from running. The
// runner is answered here, at http.fetch (cards/test/runner.test.mjs tests the real one). All data is made up. `claude
// plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { cardWidth } from '../cards/draw'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const DATA = '/made-up/data'
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 200, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 200, rows: 40, isFullscreen: true } } as never
const TOOL = 'mcp__thimble__card'
const TREE = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['ada 3'] }, { t: 'Text', p: {}, c: ['bram 5'] }] }
const SORTED = { t: 'Box', p: { flexDirection: 'column' }, c: [{ t: 'Text', p: {}, c: ['bram 5'] }, { t: 'Text', p: {}, c: ['ada 3'] }] }
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

/** A session over DATA whose card runner the test answers at http.fetch; `sandbox`: what setup.mjs says of the sandbox
 *  (one that works unless given). */
function world(on: Any, o: { sandbox?: Record<string, unknown> } = {}) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  const files: Record<string, string> = {}
  const asked: string[] = []
  // the width the runner holds the card at, which each of its answers says, as the runner does
  let runnerWidth = 0
  on('config.list', () => ({ value: [{ key: 'theme', value: 'dark', isLocked: false }] }) as never)
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
  on('fs.list', () => ({ value: [] }))
  // a path's real path, `.` and `..` folded
  const real = (p: string) => `/${p.split('/').reduce((a: string[], x) => (x === '..' ? a.slice(0, -1) : x && x !== '.' ? [...a, x] : a), []).join('/')}`
  on('fs.stat', (_$: unknown, e: { path: string }) => ({
    // escape.json looks local but its real target is outside every allowed root (a symlink out of the folder)
    value: e.path.endsWith('/cards/argv.mjs') ? { kind: 'file', size: 64, mtimeMs: 1, isLink: false, realPath: e.path }
      : e.path === `${DATA}/escape.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: true, realPath: '/etc/shadow' }
        : e.path === `${DATA}/runs.json` || e.path === `${DATA}/secret.json` ? { kind: 'file', size: 64, mtimeMs: 0, isLink: false, realPath: e.path }
          : e.path === DATA || e.path.startsWith('/made-up/tmp') ? { kind: e.path.endsWith('.json') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: real(e.path) }
            : { kind: 'missing', size: 0, mtimeMs: 0, isLink: false },
  }))
  const spawned: string[][] = []
  const runs: string[][] = []
  on('agent.spawn', () => ({ model: 'claude-made-up' }) as never)
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    // a copy of a made-up file (a card's rows into its version's folder) holds what the file holds
    if (e.argv[0] === 'cp' && e.argv[2]! in files) files[e.argv[3]!] = files[e.argv[2]!]!
    return { value: { ...(tempRun(e.argv, o.sandbox) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$: unknown, e: { argv: string[] }) {
    spawned.push(e.argv)
    return { value: { code: 0, signal: null } }
  })
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('http.fetch', (_$: unknown, e: { url: string; init?: { body?: string } }) => {
    const op = e.url.replace('http://runner/', '')
    asked.push(op)
    // no runner listens when the sandbox cannot start
    if (o.sandbox?.ok === false) throw new Error('made-up: no such socket')
    const body = JSON.parse(e.init?.body || '{}')
    const reply = (answer: object) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } })
    // a view that does not parse
    if (op === 'load' && String(body.view).includes('BROKEN')) return reply({ ok: false, phase: 'view', error: 'the view does not parse (line 1): Unexpected token' })
    if ((op === 'load' || op === 'draw') && body.width) runnerWidth = body.width
    // a view that says TALL draws taller than the frame
    const tall = String(body.view ?? '').includes('TALL')
    const answers: Record<string, unknown> = {
      ping: { ok: true },
      load: {
        ok: true, tree: tall ? TALL : TREE, width: runnerWidth, state: 'null', keys: /const keys = "([^"]*)"/.exec(String(body.view ?? ''))?.[1] ?? '', lines: tall ? TALL_LINES : ['ada 3', 'bram 5'], cut: [], summary: { rows: 2, read: '2 rows', columns: ['name', 'score'], first: '{"name":"ada","score":3}' },
      },
      key: { ok: true, handled: body.key === 'o', tree: SORTED, width: runnerWidth, state: '{"sorted":true}' },
      draw: { ok: true, tree: TREE, width: runnerWidth, state: 'null' },
      copy: { ok: true, lines: ['ada 3', 'bram 5'], cut: [] },
      undo: { ok: true, tree: TREE, width: runnerWidth, state: 'null' },
    }
    return reply((answers[op] ?? { ok: false, error: 'no such request' }) as object)
  })
  // the person's permission rules: a deny rule for reading `secret.json`
  on('tool.check', (_$: unknown, e: Any) => (e.tool === 'Read' && String(e.input?.file_path).endsWith('secret.json') ? { decision: 'deny', reason: 'a made-up deny rule', rule: 'Read(./secret.json)' } : { decision: 'allow' }) as never)
  on('ui.render', (_$: unknown, e: Any) => ({ type: 'Text', props: {}, children: [e.props?.output ?? 'the engine'] }) as never)
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  return { files, asked, clock, spawned, runs }
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

test('a card on screen with keys of its own takes none of thimble\'s: the bar names its keys, then v visualize · s simplify, also while ] stands on the card and while the simpler version is on its way', { options: { cards: 'on demand', squeezeAnswers: true, citations: 'off', explain: 'off' } }, async ($, on) => {
  const w = world(on)
  on('prompt.submit', (_$: unknown, e: Any) => ({ text: e.text }))
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  const simplified: Any[] = []
  let give: () => void = () => {}
  on('model.complete', async (_$: unknown, e: Any) => {
    simplified.push(e)
    await new Promise<void>(r => { give = r })
    return { value: { isAnswered: true, text: '<text>\nTwo runs failed.\n</text>', usage: {} } }
  })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'which runs failed?', turnId: 't1' } as never)
  // a card whose view asks for o and for s: s is thimble's, so the card keeps o alone
  const input = { title: 'Scores', data: 'runs.json', view: VIEW.replace('const keys = "o"', 'const keys = "os"') }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_made_up_61', ...input } as never)
  await shown($, callRow('toolu_made_up_61', input))
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Two runs failed, ada and bram.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-t1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed, ada and bram.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  expect(textOf(await $.ui.render(BAND))).toContain('o card keys · v visualize · s simplify')
  const edit = (key: string) => ($.prompt as Any).edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never) as Any
  // ] stands on the card, which holds the keys: the bar names its keys after v and s, which still act at the prompt
  expect(await edit(']')).toEqual({ text: '', cursor: 0 })
  await w.clock.advance(1000)
  expect(textOf(await $.ui.render(BAND))).toMatch(/v visualize · s simplify · a ask/)
  // s at the empty prompt simplifies the answer, as the bar says; while its first version is on its way, s stays
  expect(await edit('s')).toEqual({ text: '', cursor: 0 })
  await w.clock.advance(1000)
  expect(simplified.length).toBe(1)
  expect(String(simplified[0].prompt)).toContain('Two runs failed, ada and bram.')
  expect(textOf(await $.ui.render(BAND))).toContain('v visualize · s simplify')
  give()
  await w.clock.advance(5000)
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

