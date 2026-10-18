// Browser mode (shell/shell.tsx): off by default, so nothing of it shows and no server starts; on, `o browser` shows
// under replies and cards, /browser opens the session's page, and what the person does on a page comes back as one
// line: an ask becomes a prompt that carries its scope, a verb press runs that verb on the message's card.
// `claude plugin test lean`. The page server is answered here, at process.spawn, the drawing and verbs at process.run.
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/data'
const SESSION = 's-1'
const OBJECT = {
  id: '01-saves', version: 2, title: 'Saves per day', program: 'return k.bars(...)',
  data: { days: [{ day: '2026-06-18', n: 6543, _rows: ['revisions.jsonl#L28-31'] }] }, lineage: { cites: [] },
}
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'region', id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' }, kid: { t: 'text', runs: [{ s: 'Jun 18 6,543', tone: 'ink' }], wrap: false, w: 12 } }] }, cites: {}, examples: {}, regions: [{ id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' } }], warnings: [], ms: 2 }
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AT = ROW.slice(0, 24)
const RECORD = { v: 1, row: AT, session: SESSION, text: 'June 18 had [6,543](q1#day=2026-06-18@n).', shown: null, marks: [], verbs: {}, objects: ['01-saves'] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, serverLines: unknown[] = []) {
  on('tool.call', () => ({ result: 'saved 01-saves v2: thimble/objects/01-saves.json\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('config.set', (_$: unknown, e: { value: unknown }) => ({ value: e.value }))
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble', BROWSER: '/usr/bin/open-page' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  const files: Record<string, string> = {
    [`${ROOT}/thimble/objects/01-saves.json`]: JSON.stringify(OBJECT),
    [`${ROOT}/thimble/messages/${SESSION}/${AT}.json`]: JSON.stringify(RECORD),
  }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  const runs: string[][] = []
  const inputs: unknown[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    let out: unknown = {}
    if (e.argv.some(a => a.endsWith('prep.mjs'))) out = { drawing: DRAWING, verbs: [{ key: 't', name: 'trace', line: 'where it came from', phrase: null, picked: true }], problems: [] }
    else if (e.argv.some(a => a.endsWith('verb.mjs')) && e.argv.includes('list')) out = { verbs: [{ key: 't', name: 'trace' }, { key: 's', name: 'squeeze' }], problems: [] }
    else if (e.argv.some(a => a.endsWith('verb.mjs'))) { inputs.push(JSON.parse(String(e.init?.stdin || '{}'))); out = { verb: 'squeeze', text: 'squeezed' } }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const spawned: string[][] = []
  on('process.spawn', async function* (_$: unknown, e: { argv: string[] }) {
    spawned.push([...e.argv])
    yield { stream: 'stdout', text: JSON.stringify({ ready: { port: 41234, token: 'tok' } }) + '\n' }
    for (const l of serverLines) yield { stream: 'stdout', text: JSON.stringify(l) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  const submitted: { text: string; context: readonly string[]; origin?: unknown }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[]; origin?: unknown }) => {
    submitted.push({ text: e.text, context: e.context ?? [], origin: e.origin })
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  const commands: string[] = []
  on('command.register', (_$: unknown, e: { name: string }) => { commands.push(e.name); return { value: { command: e.name } } })
  on('config.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  return { runs, inputs, files, submitted, toasts, spawned, commands }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = ($: any, text = 'June 18 had the most saves.') => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text, isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)

/** The rows appended for Claude alone (a question's scope), as one text. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hidden = (session: any) => (session.appended() as { message: { type: string; content: { text?: string }[] } }[]).filter(r => r.message.type === 'user').flatMap(r => r.message.content.map(b => String(b.text ?? ''))).join('\n')

/** A turn that saves 01-saves and ends with words: the object is drawn under them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function savedTurn($: any, on: any, clock: { settle: () => Promise<void> }) {
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'June 18 had the most saves.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('browser mode is off at install: no /browser, no o, no hint, and no server starts', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  expect(w.commands).toContain('obj')
  expect(w.commands).not.toContain('browser')
  await savedTurn($, on, clock)
  textOf(await reply($))
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('Jun 18')
  expect(drawn).not.toContain('browser')
  // a plain reply carries nothing either
  expect(textOf(await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: 'bbbbbbbb-0000', props: { text: 'Done.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never))).toBe('the reply')
  // the detail view has no o key
  await $.command.run({ command: 'obj', args: '01-saves' } as never)
  await clock.settle()
  const pane = textOf(await $.ui.render({ component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 40 } } } as never))
  await clock.settle()
  const pane2 = textOf(await $.ui.render({ component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 40 } } } as never))
  expect(pane2).toContain('Saves per day')
  expect(pane + pane2).not.toContain('browser')
  // asked anyway (/obj browser), it says how to turn it on and starts nothing
  const r = await $.command.run({ command: 'obj', args: 'browser 01-saves' } as never)
  expect(String(r.text)).toContain('Browser mode is off')
  expect(String(r.text)).toContain('/config')
  expect(w.spawned.length).toBe(0)
})

test('browser mode on: o browser under replies and cards, and /browser starts the page server for this session', { options: { browser: true } }, async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  expect(w.commands).toContain('browser')
  await savedTurn($, on, clock)
  textOf(await reply($))
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('o browser')
  expect(drawn.match(/o browser/g)!.length).toBe(2)
  // a plain reply carries it too: the mirror opened at that reply
  expect(textOf(await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: 'bbbbbbbb-0000', props: { text: 'Done.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never))).toContain('o browser')
  const r = await $.command.run({ command: 'browser', args: '' } as never)
  expect(String(r.text)).toContain('Opened this session in the browser')
  // one server, on this session's folder and id, and the page opened at the mirror
  expect(w.spawned.length).toBe(1)
  const argv = w.spawned[0]!
  expect(argv.some(a => a.endsWith('shell/node/serve.mjs'))).toBe(true)
  expect(argv[argv.indexOf('--session') + 1]).toBe(SESSION)
  expect(argv[argv.indexOf('--root') + 1]).toBe(ROOT)
  const opened = w.runs.find(a => a[0] === '/usr/bin/open-page')!
  expect(opened[1]).toBe('http://127.0.0.1:41234/tok/mirror/')
  // a card's page: /browser <object> [region]
  const c = await $.command.run({ command: 'browser', args: '01-saves day-2026-06-18' } as never)
  expect(String(c.text)).toContain('Opened 01-saves ▸ day-2026-06-18')
  expect(w.runs.filter(a => a[0] === '/usr/bin/open-page').at(-1)![1]).toBe('http://127.0.0.1:41234/tok/card/?o=01-saves&v=2#r=day-2026-06-18')
})

test('an ask from the browser goes to Claude as a prompt, its scope beside it for Claude alone', { options: { browser: true } }, async ($, on) => {
  const w = world(on, [{ ask: 'why is this day so high?', scope: { object: '01-saves', v: 2, region: 'day-2026-06-18', label: 'Jun 18 6,543', row: AT } }])
  const session = mock.session(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'browser', args: '' } as never)
  await clock.settle()
  // the row is the person's words; what it was about goes in a row before it that the person does not see
  const asked = w.submitted.filter(s => s.text === 'why is this day so high?')
  expect(asked.length).toBe(1)
  const context = hidden(session)
  expect(context).toContain('in the browser page of this session')
  expect(context).toContain('01-saves@2')
  expect(context).toContain('day-2026-06-18')
  expect(context).toContain('q1#day=2026-06-18@n')
})

test('an ask about a citation or a gloss names it; a verb pressed in the browser runs on the message\'s card', { options: { browser: true } }, async ($, on) => {
  const w = world(on, [
    { ask: 'where is this from?', scope: { row: AT, mark: { kind: 'cite', ref: 'q1#day=2026-06-18@n', label: '6,543' } } },
    { verb: 's', row: AT },
    { verb: 'z', row: AT },
  ])
  const session = mock.session(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'browser', args: '' } as never)
  await clock.settle()
  expect(w.submitted.map(s => s.text)).toContain('where is this from?')
  const context = hidden(session)
  expect(context).toContain('your citation "6,543" (q1#day=2026-06-18@n)')
  expect(context).toContain('June 18 had 6,543')
  // s is squeeze's key: it ran on the card under that message, with the message's record
  const input = w.inputs[0] as { object: { id: string }; record: { row: string }; row: string }
  expect(input.object.id).toBe('01-saves')
  expect(input.row).toBe(AT)
  expect(input.record.row).toBe(AT)
  // a key no verb has: one line that says so
  expect(w.toasts.some(t => t.includes('no verb is on that key'))).toBe(true)
})

test('browser mode turned off in /config ends the server and hides o again', { options: { browser: true } }, async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await savedTurn($, on, clock)
  textOf(await reply($))
  await clock.settle()
  expect(textOf(await reply($))).toContain('o browser')
  await $.config.set({ key: 'thimble-lean.browser', value: false } as never)
  await clock.settle()
  expect(textOf(await reply($))).not.toContain('browser')
  const r = await $.command.run({ command: 'browser', args: '' } as never)
  expect(String(r.text)).toContain('Browser mode is off')
  expect(w.spawned.length).toBe(0)
})
