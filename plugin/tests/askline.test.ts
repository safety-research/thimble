// The detail's ask line under a busy terminal (shell/detail.tsx): a question typed faster than the prompt takes the
// answers to its keys stays one question (a key on letters the question took joins it, and ↵ there asks it whole); a
// field with the ring is never drawn afresh, so what is typed into it is kept; a question sent or let go gives the keys
// back to the card even when the drawing the terminal has still puts the ring on the ask line. `claude plugin test lean`.
import { expect, mock, test } from 'claude-code/testing'
import { press, promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const ROOT = '/data'
const OBJECT = {
  id: '01-orchard', version: 1, title: 'Trees per row', program: 'drawn here', text: 'Row 2 has [3](#row-2) trees.',
  history: [{ v: 1, at: 'a' }], data: {}, lineage: { cites: [] },
}
const region = (id: string, label: string) => ({ t: 'region', id, meta: { label }, kid: { t: 'text', runs: [{ s: `${label} ${'▆'.repeat(8)}`, tone: 'ink' }], wrap: false, w: 30 } })
const DRAWING = {
  kit: 1, w: 98, h: 24, mode: 'detail', root: { t: 'stack', kids: [region('row-1', 'Row 1'), region('row-2', 'Row 2')] },
  cites: {}, examples: {}, regions: [{ id: 'row-1', meta: { label: 'Row 1' } }, { id: 'row-2', meta: { label: 'Row 2' } }], warnings: [], ms: 1,
}
const PANE = { component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 40, offset: 0 }, isFocused: true, placement: 'dock', title: 'Trees per row', view: {} } } as never
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
/** A key in the prompt; `shown` is what the prompt still shows (letters whose answers it has not applied yet). */
const edit = (key: string, shown = '') => ({ origin: { kind: 'composer' }, key: { key }, text: shown, cursor: shown.length, start: shown.length, end: shown.length, inputText: key.length === 1 ? key : '' }) as never
const plugin = { kind: 'plugin', name: 'thimble' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [`${ROOT}/thimble/objects/01-orchard.json`]: JSON.stringify(OBJECT) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const out = e.argv.some(a => a.endsWith('prep.mjs')) ? { drawing: DRAWING, verbs: [], problems: [] } : e.argv.includes('resolve') ? { ref: e.argv[2], chain: [], rows: [], count: 0, records: [], notes: [] } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  // where the ring lands, as the hooks leave it
  const focused: string[] = []
  on('ui.focus', (_$: unknown, e: Any) => { focused.push(String(e.element ?? e.key)); return { value: {} } })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'Trees per row', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('prompt.fill', () => ({ isFilled: true }))
  const submitted: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  const spawns: Any[] = []
  on('agent.register', () => ({ value: { agent: 'thimble:thread' } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-test' } as never })
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `agent-${i + 1}`, type: 'thimble:thread', description: 'thread', status: 'running' })) }))
  on('session.send', () => ({ isDelivered: true }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }) as never)
  return { files, focused, submitted, spawns }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function open($: any, clock: { settle: () => Promise<void> }): Promise<void> {
  await $.command.run({ command: 'card', args: '01-orchard row-2' } as never)
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await clock.settle() }
}
// the ask line's key and what it holds, as the pane draws it now
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const askLine = async ($: any) => { const s = JSON.stringify(await $.ui.render(PANE)); return { key: /"key":"(ask-\d+)"/.exec(s)?.[1] ?? '', value: /"key":"ask-\d+"[^}]*?"value":"([^"]*)"/.exec(s)?.[1] ?? /"value":"([^"]*)"[^}]*?"key":"ask-\d+"/.exec(s)?.[1] ?? '' } }

test('a question typed faster than the prompt takes its answers stays one question: a key on letters it took joins it, and ↵ there asks it whole', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await open($, clock)
  expect(await press($, clock, edit('w'))).toEqual({ text: '', cursor: 0 })
  expect(await press($, clock, edit('h'))).toEqual({ text: '', cursor: 0 })
  // the prompt still shows "wh" (the answers to both keys not applied yet) when y comes: y joins the question, and the
  // answer empties the prompt; nothing is typed for main
  expect(await press($, clock, edit('y', 'wh'))).toEqual({ text: '', cursor: 0 })
  expect((await askLine($)).value).toBe('why')
  // ⌫ on such a prompt takes the question's last letter back; the next letter joins it again
  expect(await press($, clock, edit('backspace', 'y'))).toEqual({ text: '', cursor: 0 })
  expect((await askLine($)).value).toBe('wh')
  expect(await press($, clock, edit('y'))).toEqual({ text: '', cursor: 0 })
  // ↵ meets the prompt still showing "y": the question asked is "why", whole, and main gets nothing
  const r = await $.prompt.submit({ text: 'y', origin: { kind: 'composer' } } as never)
  await clock.settle()
  expect(String((r as Any).drop)).toContain("asked the card's thread about Row 2")
  expect(w.spawns.length).toBe(1)
  expect(String(w.spawns[0].prompt)).toMatch(/\n\nwhy\n\nAbout: the part "Row 2"/)
  expect(w.submitted).not.toContain('y')
  expect((await askLine($)).value).toBe('')
})

test('a field with the ring is never drawn afresh: a letter that came through the prompt as the ring landed joins the question, and the field keeps what is typed into it', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await open($, clock)
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  expect(await press($, clock, edit('w'))).toEqual({ text: '', cursor: 0 })
  for (let i = 0; i < 2; i++) { await ui.redraw(); await clock.settle() }
  const first = (await askLine($)).key
  // a terminal busy drawing hands the ring to a field it drew before: it goes on to the field drawn last
  await $.ui.focus({ requestId: 'object', element: 'ask-0', origin: plugin } as never)
  expect(w.focused.at(-1)).toBe(first)
  // a letter typed before the ring landed comes through the prompt after: it joins the question, and the field keeps
  // its key (a new one would lose what is typed into it meanwhile)
  expect(await press($, clock, edit('h'))).toEqual({ text: '', cursor: 0 })
  expect((await askLine($)).key).toBe(first)
  // the field holds "w" and the person typed "y" into it: the question is "why"
  await ui.input({ key: first, text: 'wy', kind: 'change' })
  await ui.input({ key: first, text: 'wy' })
  await clock.settle()
  expect(String(w.spawns[0]?.prompt)).toMatch(/\n\nwhy\n\nAbout/)
})

test('a question sent empties the ask line, which keeps the keys for the next question; no letter is a key of the panel', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await open($, clock)
  expect(await press($, clock, edit('w'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  const field = (await askLine($)).key
  expect(textOf(await $.ui.render(HINT))).toContain('esc clears the question')
  // the question is asked: the line empties, a field drawn afresh that takes the ring for the next question
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await ui.input({ key: field, text: 'why' })
  await clock.settle()
  expect(w.spawns.length).toBe(1)
  for (let i = 0; i < 2; i++) { await $.ui.render(PANE); await clock.settle() }
  expect((await askLine($)).value).toBe('')
  expect((await askLine($)).key).not.toBe(field)
  // (the field the ring starts on when the pane takes the keyboard)
  expect(JSON.stringify(await $.ui.render(PANE))).toMatch(/"key":"ask-\d+"[^}]*"autoFocus":true/)
  expect(textOf(await $.ui.render(HINT))).toContain('esc close')
  // e is no key of the panel's: it begins the next question
  expect(await press($, clock, edit('e'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect((await askLine($)).value).toBe('e')
})
