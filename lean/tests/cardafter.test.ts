// The card after the answer (registry feature `card`, shell/shell.tsx): after a turn that ran lean and saved nothing, a
// fork of the session decides whether a card helps and writes it; thimble runs the queries it asks for, saves it, draws
// it under the answer, and Claude reads which card it is with the next prompt. A save that does not hold asks the fork
// once more. Off by default: then no fork runs. `claude plugin test lean`. The Node children and `lean` are answered
// here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

import { promptStub } from './stubs'

const ROOT = '/data'
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'text', runs: [{ s: 'Jun 18 6,543', tone: 'ink' }], wrap: false, w: 12 }] }, cites: {}, examples: {}, regions: [], warnings: [], ms: 2 }
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
const CARD = {
  card: 'edits-per-day',
  queries: [{ name: 'byday', label: 'edits per day', code: 'tally(df, "day")' }],
  object: { title: 'Edits peaked on June 18', program: 'return k.text("x")', data: { days: '$byday' }, text: 'June 18: [6,543]($byday#day=2026-06-18@n)' },
}

type Json = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any, o: { env?: Record<string, string>; replies?: Json[]; save?: (n: number) => string } = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble', ...(o.env ?? {}) })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [`${ROOT}/thimble/queries/q1.json`]: '{}' }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/queries` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? (e.path.endsWith('/draw/TOOLKIT.md') ? 'THE TOOLKIT' : promptStub(e.path) ?? '') }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const lean: { args: string[]; stdin: string; env: Json }[] = []
  let saves = 0
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string; env?: Json } }) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'tail') return ok((files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1))
    if (e.argv.some(a => a.endsWith('telemetry/append.mjs'))) {
      files[e.argv.at(-1)!] = (files[e.argv.at(-1)!] ?? '') + String(e.init?.stdin ?? '')
      return ok('')
    }
    if (e.argv.some(a => a.endsWith('prep.mjs'))) return ok(JSON.stringify({ drawing: DRAWING, verbs: [], problems: [], ...(JSON.parse(String(e.init?.stdin || '{}')).check ? { check: { line: null, tried: 0, total: 0, failed: 0, cut: 0, ms: 1 } } : {}) }))
    if (e.argv.some(a => a.endsWith('/bin/lean'))) {
      const args = e.argv.slice(1)
      lean.push({ args, stdin: String(e.init?.stdin ?? ''), env: e.init?.env ?? {} })
      if (args[0] === 'q') return ok(`q7 · ${args[1]}\n   day     n\n0  06-18  6543\nq7 done in 0.1s`)
      if (args[0] === 'save') {
        saves += 1
        const object = JSON.parse(files[args[3]!] ?? '{}')
        files[`${ROOT}/thimble/objects/02-${args[1]}.json`] = JSON.stringify({ id: `02-${args[1]}`, version: saves, ...object })
        files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: `02-${args[1]}`, version: saves }) + '\n'
        return ok(o.save ? o.save(saves) : `saved 02-${args[1]} v${saves}: thimble/objects/02-${args[1]}.json\n  /days ← q7 (exact)\n  1 of 1 citations hold`)
      }
      return ok('')
    }
    return ok('{}')
  })
  const forks: string[] = []
  on('model.fork', (_$: unknown, e: { prompt: string }) => {
    forks.push(String(e.prompt))
    const reply = o.replies?.[forks.length - 1] ?? { card: null, why: 'no reply set' }
    return { value: { isAnswered: true, text: JSON.stringify(reply), usage: USAGE } }
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  // Claude's own commands: a query prints its id; a save of Claude's goes to the change feed as the kernel writes it
  on('tool.call', (_$: unknown, e: { command?: string }) => {
    if (/lean save/.test(String(e.command))) {
      files[`${ROOT}/thimble/objects/01-mine.json`] = JSON.stringify({ id: '01-mine', version: 1, title: 'Mine', program: 'return k.text("x")', data: {} })
      files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: '01-mine', version: 1 }) + '\n'
      return { result: 'saved 01-mine v1: thimble/objects/01-mine.json' }
    }
    return { result: /lean q/.test(String(e.command)) ? 'q1 · saves per day\n...' : 'ok' }
  })
  const clock = mock.clock(on)
  return { files, lean, forks, submitted, toasts, clock }
}

/** A turn of the person's: the question, a `lean q` (or another command), the answer, its end. */
async function turn($: Any, o: { command?: string; answer?: string } = {}) {
  await $.prompt.submit({ text: 'when did they edit most?', origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'when did they edit most?' } as never)
  await $.tool.call({ tool: 'Bash', command: o.command ?? "lean q \"saves per day\" <<'PY'\ntally(df, 'day')\nPY" } as never)
  const answer = o.answer ?? 'June 18 had the most saves: 6,543.'
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] } } as never)
  await $.turn.complete({ turnId: 't1', answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
}

const reply = ($: Any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves: 6,543.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

test('after a turn that queried, a fork writes the card: its query runs first, its name becomes the id, the card is drawn under the answer, and Claude reads which card it is', async ($, on) => {
  const w = world(on, { env: { LEAN_PROMPTS: 'card:v1' }, replies: [CARD] })
  await turn($)
  await w.clock.settle()
  // one fork, with the question, the answer, the card guidance and the toolkit
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toContain('REQUEST when did they edit most? | June 18 had the most saves: 6,543. | none |')
  expect(w.forks[0]).toContain('THE TOOLKIT')
  // the query ran before the save, under the session, and the card names it by its id
  // (the thimble line's own `lean coverage` aside)
  const mine = w.lean.filter(x => x.args[0] !== 'coverage')
  expect(mine.map(x => x.args[0])).toEqual(['q', 'save'])
  expect(mine[0]!.args[1]).toBe('edits per day')
  expect(mine[0]!.stdin).toBe('tally(df, "day")')
  expect(mine[0]!.env.LEAN_SESSION).toBe('s-1')
  const saved = JSON.parse(w.files['/home/t/.thimble/lean/cards/s-1/edits-per-day.json']!)
  expect(saved.data.days).toBe('q7')
  expect(saved.text).toBe('June 18: [6,543](q7#day=2026-06-18@n)')
  // drawn under the answer
  expect(textOf(await reply($))).toContain('Jun 18 6,543')
  // the next prompt tells Claude which card it is
  await $.prompt.submit({ text: 'and the week after?', origin: { kind: 'composer' } } as never)
  const ctx = w.submitted.at(-1)!.context.join('\n')
  expect(ctx).toContain('After your last answer, thimble drew the card 02-edits-per-day@1 under it ("Edits peaked on June 18")')
  expect(ctx).toContain('from q7')
  // the next turn's first command does not take the card for its own
  await $.turn.start({ turnId: 't2', text: 'and the week after?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'lean q "week" <<\'PY\'\nx\nPY' } as never)
  await $.session.append({ door: 'response', uuid: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The week after was quiet.' }] } } as never)
  const second = await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', props: { text: 'The week after was quiet.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)
  expect(textOf(second)).not.toContain('Jun 18 6,543')
  // the call and its outcome are in the session's events
  await w.clock.advance(100)
  const events = (w.files[EVENTS] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(events.some(e => e.kind === 'call' && e.feature === 'card' && e.prompt === 'card:v1' && e.round === 1)).toBe(true)
  expect(events.find(e => e.kind === 'card')).toMatchObject({ drawn: true, object: '02-edits-per-day@1', rounds: 1, queries: 1 })
})

test('a card that does not hold asks the fork once more with what the save said, and the corrected card takes its place', async ($, on) => {
  const fixed = { ...CARD, queries: [], object: { ...CARD.object, data: { days: 'q1' }, text: 'June 18: 6,543' } }
  const w = world(on, { env: { LEAN_PROMPTS: 'card:v1' }, replies: [CARD, fixed], save: n => (n === 1 ? 'saved 02-edits-per-day v1: thimble/objects/02-edits-per-day.json\n  0 of 1 citations hold\n  problem: q7 has no row day=2026-06-18' : 'saved 02-edits-per-day v2: thimble/objects/02-edits-per-day.json\n  /days ← q1 (exact)') })
  await turn($)
  await w.clock.settle()
  expect(w.forks.length).toBe(2)
  expect(w.forks[1]).toContain('FIX - 0 of 1 citations hold\n- problem: q7 has no row day=2026-06-18 |')
  expect(w.forks[1]).toContain('"card":"edits-per-day"')
  expect(w.lean.filter(x => x.args[0] !== 'coverage').map(x => x.args[0])).toEqual(['q', 'save', 'save'])
  await $.prompt.submit({ text: 'ok', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('the card 02-edits-per-day@2')
})

test('no fork while the card after the answer is off, the default', async ($, on) => {
  const off = world(on)
  await turn($)
  await off.clock.settle()
  expect(off.forks.length).toBe(0)
})

test('a turn that ran no lean, or saved its own card, asks no fork; a fork that sees no use for a card draws none and says nothing', async ($, on) => {
  const w = world(on, { env: { LEAN_PROMPTS: 'card:v1' }, replies: [{ card: null, why: 'one number' }] })
  await turn($, { command: 'ls -la' })
  await w.clock.settle()
  expect(w.forks.length).toBe(0)
  await turn($)
  await w.clock.settle()
  expect(w.forks.length).toBe(1)
  expect(textOf(await reply($))).not.toContain('Jun 18 6,543')
  expect(w.toasts).toEqual([])
  await turn($, { command: "lean save mine <<'JSON'\n{}\nJSON" })
  await w.clock.settle()
  expect(w.forks.length).toBe(1)
  await w.clock.advance(100)
  const events = (w.files[EVENTS] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(events.filter(e => e.kind === 'card')).toEqual([expect.objectContaining({ drawn: false, why: 'one number' })])
})
