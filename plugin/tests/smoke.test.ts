// The terminal's smoke test: the whole hooks module (hooks/register.ts) in one session that starts, answers a question,
// saves a card with `thimble save` and draws it under the answer, with the answer's citations drawn in place. The save
// is seen from the kernel's change feed, never from what the call printed. `claude plugin test plugin`. The Node
// children (the drawing, `thimble resolve`) are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ROOT = '/data'
const FILE = `${ROOT}/thimble/objects/01-saves.json`
const OBJECT = {
  id: '01-saves', version: 1, title: 'Saves per day', question: 'When did the agents edit the wiki most?',
  program: 'return k.bars(...)', data: { days: [{ day: '2026-06-18', n: 6543, _rows: ['revisions.jsonl#L28-31'] }] },
  lineage: { cites: [] },
}
// what prep.mjs gives for the card: one bar, a part named by its id with the ref behind it
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'region', id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' }, kid: { t: 'beside', kids: [{ t: 'text', runs: [{ s: 'Jun 18', tone: 'ink' }], wrap: false, w: 6 }, { t: 'bar', tone: 'accent', value: 6543, max: 6543 }, { t: 'text', runs: [{ s: '6,543', tone: 'ink' }], align: 'right', w: 5 }], gap: 1 } }] }, cites: {}, examples: {}, regions: [{ id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' } }], warnings: [], ms: 2 }
const RESOLVED = { ref: 'q1#day=2026-06-18@n', chain: [{ step: 'query', id: 'q1', about: 'saves per day' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'x' }], notes: [] }
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ANSWER = 'June 18 had the most saves: [6,543](q1#day=2026-06-18@n).'

function world(on: Any, o: { heal?: () => unknown; coverage?: () => unknown } = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble', HOME: '/home/t', PATH: '/usr/bin:/bin' })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('env.set', () => ({ value: {} }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [FILE]: JSON.stringify(OBJECT) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === `${ROOT}/thimble/objects` ? [{ name: '01-saves.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  on('process.run', async (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    // the feed's new bytes (`tail -c +N <file>`): the test's files are ASCII, so a byte is a character
    if (e.argv[0] === 'tail') return { value: { exitCode: 0, stdout: (files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const prep = e.argv.some(a => a.endsWith('prep.mjs')) ? JSON.parse(String(e.init?.stdin || '{}')) : null
    let out: unknown = {}
    if (prep) out = { drawing: DRAWING, ...(prep.check ? { check: { line: null, tried: 1, total: 1, failed: 0, cut: 0, ms: 1 } } : {}) }
    else if (e.argv.includes('resolve')) out = RESOLVED
    else if (e.argv.includes('coverage') && o.coverage) out = await o.coverage()
    else if (e.argv.includes('heal') && o.heal) {
      out = await o.heal()
      if (out instanceof Error) return { deny: out.message } as never
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  // Claude Code's own drawing of a reply's plain words
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  return { files, toasts }
}

// every string a drawn tree holds, in order
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
function labels(n: Any, out: string[] = []): string[] {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => labels(x, out)); return out }
  if (n.type === 'Button' && typeof n.props?.label === 'string') out.push(n.props.label)
  labels(n.props?.children, out)
  labels(n.children, out)
  return out
}
function find(n: Any, ok: (n: Any) => boolean): Any {
  if (n == null || typeof n !== 'object') return null
  if (Array.isArray(n)) { for (const x of n) { const f = find(x, ok); if (f) return f } return null }
  if (ok(n)) return n
  return find(n.props?.children, ok) ?? find(n.children, ok)
}
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const reply = ($: Any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: ANSWER, isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)

test('a session answers a question, saves a card and draws it under the answer, its citation in place', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  // the save: the kernel writes it to the change feed, and a pipe cuts the call's printed words; a later call only
  // prints the words of a save
  let calls = 0
  on('tool.call', () => {
    if (++calls > 1) return { result: 'saved 09-other v1: thimble/objects/09-other.json\n' }
    w.files[EVENTS] = (w.files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: '01-saves', version: 1 }) + '\n'
    return { result: '' }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit({ text: 'when did the agents edit most?', origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'when did the agents edit most?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: 'thimble save saves --from card.json | tail -1' } as never)
  // Claude reads that the card is drawn for the person
  expect(String((saved as { context?: string[] }).context)).toContain('01-saves@1 is drawn')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  const tree = await reply($)
  const drawn = textOf(tree)
  // the card under the answer, drawn from its program's drawing
  expect(drawn).toContain('Jun 18')
  expect(drawn).toContain('6,543')
  // the citation is drawn as its words, a press that opens what it cites, and its ref never shows
  expect(labels(tree)).toContain('cite 6,543')
  expect(drawn).not.toContain('q1#day')
  // in a column too narrow for the card's frame (the chat beside a pane), the card is one row that fits it
  const atCols = (columns: number) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: ANSWER, isFirstOfReply: true }, viewport: { columns, rows: 40, isFullscreen: true } } as never)
  await atCols(24)
  await clock.settle()
  const narrow = await atCols(24)
  const card = find(narrow, n => String(n.props?.key ?? '').startsWith('card-'))
  expect(card).toBeTruthy()
  const line = textOf(card)
  expect(line).not.toContain('\n')
  expect(line).toContain('Saves per')
  expect(line).toContain('open')
  expect(2 + [...line].length).toBeLessThanOrEqual(24)
  expect(labels(card)).toContain('open the card Saves per day')
  // a call that saved nothing draws nothing, however its output reads
  const echo = await $.tool.call({ tool: 'Bash', command: 'echo "saved 09-other v1"' } as never)
  expect((echo as { context?: string[] }).context ?? []).toEqual([])
})

test('a healing pass Claude Code cut short starts again once at the next drawing, and the person hears nothing of it', async ($, on) => {
  let heals = 0
  // Claude Code stops the first pass's child: the drawing that started it was abandoned as the turn ended
  const w = world(on, { heal: () => { if (++heals === 1) return new Error('thimble: $.process.run(/p/bin/thimble) aborted'); return { of: 'v1', version: 'v1', changes: [{ label: '6,543', ref: 'q1#day=2026-06-18@n', state: 'linked', how: 'kept', to: 'q1#day=2026-06-18@n' }] } } })
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: '' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  for (let i = 0; i < 3; i++) { await reply($); await clock.advance(10); await clock.settle() }
  expect(heals).toBe(2)
  expect(w.toasts).toEqual([])
  const kept = Object.entries(w.files).find(([f]) => f.includes('/thimble/messages/') && f.endsWith('.json'))
  // kept by the text it read (message.js withHeal)
  const results = Object.values(JSON.parse(kept![1]).heals) as { changes: { state: string }[] }[]
  expect(results.map(h => h.changes[0].state)).toEqual(['linked'])
})

test('the bar shows thimble\'s own work: nothing for 300 ms, then a spinner and its word, the seconds from 3 s, gone when it ends', async ($, on) => {
  // the citation check runs until the test lets it end
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => { release = r })
  world(on, { heal: () => gate.then(() => ({ of: 'v1', version: 'v1', changes: [] })) })
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: '' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  // the reply's drawing starts the check
  await reply($)
  await clock.advance(200)
  const bar = async () => textOf(await $.ui.render(BAND))
  expect(await bar()).not.toContain('checking citations')
  await clock.advance(200)
  expect(await bar()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] checking citations ·/)
  await clock.advance(3000)
  expect(await bar()).toContain('checking citations 3s')
  release()
  await clock.advance(200)
  await clock.settle()
  expect(await bar()).not.toContain('checking citations')
})

test('after an answer the bar names each step as it runs, the newest first with +1 for another, until the last ends', async ($, on) => {
  // the coverage count and the citation check run until the test lets each end
  let endCov: () => void = () => undefined
  let endHeal: () => void = () => undefined
  const cov = new Promise<void>(r => { endCov = r })
  const heal = new Promise<void>(r => { endHeal = r })
  world(on, { coverage: () => cov.then(() => ({ files: [], groups: [], types: [] })), heal: () => heal.then(() => ({ of: 'v1', version: 'v1', changes: [] })) })
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: '' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  await reply($)
  const bar = async () => textOf(await $.ui.render(BAND))
  const step = async () => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ([a-z][a-z ]*[a-z](?: \+\d)?)/.exec(await bar())?.[1] ?? null
  await clock.advance(200)
  await clock.settle()
  await clock.advance(200)
  await clock.settle()
  // the reply's drawing started the check, the turn's end the count a moment later: the count shows, +1 for the check
  expect(await step()).toBe('counting coverage +1')
  endCov()
  await clock.advance(200)
  await clock.settle()
  expect(await step()).toBe('checking citations')
  endHeal()
  await clock.advance(200)
  await clock.settle()
  expect(await step()).toBeNull()
})
