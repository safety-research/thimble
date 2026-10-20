// Squeeze and the cards of an answer (squeeze/term.ts, shell/shell.tsx): the chips belong to the whole answer, so they
// are drawn after its last card. With the squeeze switch for cards on, the request shows the answer's cards and the
// query outputs they draw on; a reply may edit a card (a new version, same id, "edited by squeeze" under it), add one
// after the last card, or leave one out. 0 brings the original cards back, and a version seen before comes back with
// its cards and no call. A change that does not draw is left out, and the hint line says why.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { press, promptStub } from './stubs'

const ROOT = '/data'
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
const SHOWN = '/home/t/.thimble/lean/shown/s-1.json'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const QUESTION = 'When did the agents edit most?'
const ANSWER = 'Most edits came on [day 1, 20 edits](q4#day=1@n), and fewer each day after. The second card splits them by hour.'
const LONGER = 'Most edits came on [day 1, 20 edits](q4#day=1@n). After day 1 the agents edited less each day. The second card splits the edits by the hour they were made.'
const SHORT = 'Most edits came on [day 1, 20 edits](q4#day=1@n).'
const uuid = (p: string) => `${p.repeat(8).slice(0, 8)}-0000-0000-0000-000000000000`
const P1 = uuid('p1'), A1 = uuid('a1')
const row = (u: string) => u.slice(0, 24)

const object = (id: string, v: number, title: string, program = 'return k.text("x")') => ({ id, version: v, title, text: `${title}.`, program, data: { days: 'q4' }, source: { title, text: `${title}.`, data: { days: 'q4' }, program }, lineage: { cites: [], bindings: [{ at: '/days', ref: 'q4', query: 'q4' }] }, history: [{ v: 1 }] })
// a card draws its title as one line, so a test reads where each card stands; a program that says THROW fails
const drawingOf = (o: Any) => (String(o.program).includes('THROW')
  ? { kit: 1, w: 40, h: 1, mode: 'inline', root: { t: 'text', runs: [{ s: 'x', tone: 'ink' }] }, error: { name: 'TypeError', message: 'data.hours is undefined' }, cites: {}, examples: {}, regions: [], warnings: [], ms: 1 }
  : { kit: 1, w: 40, h: 1, mode: 'inline', root: { t: 'text', runs: [{ s: `CARD ${o.title}`, tone: 'ink' }], wrap: false }, cites: {}, examples: {}, regions: [], warnings: [], ms: 1 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, replies: string[] = []) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = {
    [`${ROOT}/thimble/queries/q4.json`]: JSON.stringify({ id: 'q4', about: 'edits per day', stdout: '   day   n\n0    1  20\n1    2  12' }),
    [`${ROOT}/thimble/objects/01-days.json`]: JSON.stringify(object('01-days', 1, 'Edits per day')),
    [`${ROOT}/thimble/objects/02-hours.json`]: JSON.stringify(object('02-hours', 1, 'Edits by hour')),
  }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/queries` }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: Object.keys(files).filter(f => f.startsWith(`${e.path.replace(/\/+$/, '')}/`) && !f.slice(e.path.length + 1).includes('/')).map(f => ({ name: f.slice(e.path.replace(/\/+$/, '').length + 1), kind: 'file' })) }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/squeeze/settings.json')) return { value: '{"model": "sonnet", "effort": "low", "settleMs": 300}' }
    return { value: files[e.path] ?? promptStub(e.path) ?? '' }
  })
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  // the kernel's save, as it keeps versions: the card's file at its new version, the old one under .versions
  const saves: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    let out: unknown = {}
    if (e.argv.some(a => a.endsWith('prep.mjs'))) out = { drawing: drawingOf(JSON.parse(String(e.init?.stdin ?? '{}')).object) }
    if (e.argv[1] === 'save') {
      saves.push(e.argv)
      const name = e.argv[2]!
      const spec = JSON.parse(files[e.argv[e.argv.indexOf('--from') + 1]!]!)
      const have = Object.keys(files).map(f => /\/thimble\/objects\/([^/]+)\.json$/.exec(f)?.[1]).filter(Boolean) as string[]
      const id = have.find(i => i === name || i.replace(/^\d+-/, '') === name) ?? `0${have.length + 1}-${name}`
      const old = files[`${ROOT}/thimble/objects/${id}.json`] ? JSON.parse(files[`${ROOT}/thimble/objects/${id}.json`]!) : null
      if (old) files[`${ROOT}/thimble/objects/.versions/${id}/v${old.version}.json`] = JSON.stringify(old)
      const v = old ? old.version + 1 : 1
      files[`${ROOT}/thimble/objects/${id}.json`] = JSON.stringify({ ...object(id, v, spec.title, spec.program), text: spec.text, source: spec })
      return { value: { exitCode: 0, stdout: `saved ${id} v${v}: thimble/objects/${id}.json\n  1 of 1 citations hold\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  // the model: each squeeze call answers with the next reply given
  const calls: Any[] = []
  on('model.complete', async (_$: unknown, e: Any) => {
    if (/\bFRAME\b|thimble's observer/.test(JSON.stringify(e.system ?? ''))) return { value: { isAnswered: true, text: '{}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
    calls.push(e)
    return { value: { isAnswered: true, text: replies[calls.length - 1] ?? '<text>(no reply left)</text>', usage: { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 } } }
  })
  on('tool.call', () => {
    for (const id of ['01-days', '02-hours']) files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: id, version: 1 }) + '\n'
    return { result: 'saved 01-days v1\nsaved 02-hours v1\n' }
  })
  return { files, calls, saves }
}

// every string a drawn tree holds, in order
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  if (n.type === 'Client') { const p = n.props?.props ?? {}; return (p.rows ?? []).map((r: { s: string }[]) => r.map(x => x.s).join('')).join('\n') + (p.hint ? `\n${p.hint}` : '') }
  return (n.type === 'Markdown' ? String(n.props?.text ?? '') : '') + textOf(n.props?.children) + textOf(n.children)
}
const view = (u: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: u, props: { text, isFirstOfReply: true }, viewport: { columns: 100, rows: 48, isFullscreen: true } }) as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const hintOf = async ($: Any) => textOf(await $.ui.render(HINT))
const under = (w: { files: Record<string, string> }) => (JSON.parse(w.files[SHOWN]!).under[row(A1)] as Any[]).map(x => `${x.id}@${x.v}`)
const written = async (clock: Any) => { await clock.advance(400); await clock.settle(); for (let i = 0; i < 120; i++) await clock.advance(50) }
// a drawing of the answer once its cards have drawn (a card draws in a child, so the first drawing waits for it)
const drawn = async ($: Any, clock: Any, text = ANSWER) => { await $.ui.render(view(A1, text)); await clock.settle(); return textOf(await $.ui.render(view(A1, text))) }

/** The person's question, answered with words and two cards saved in the turn. */
async function answered($: Any, clock: Any) {
  await $.turn.start({ turnId: 't1', text: QUESTION } as never)
  await $.session.append({ door: 'prompt', uuid: P1, origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: QUESTION }] } } as never)
  await $.tool.call({ tool: 'Bash', command: 'thimble save days && thimble save hours', tool_use_id: 'tu1' } as never)
  await $.ui.render(view(A1, ANSWER))
  await $.session.append({ door: 'response', uuid: A1, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('the chips belong to the whole answer: drawn after its last card, never between its text and a card', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await answered($, clock)
  expect(under(w)).toEqual(['01-days@1', '02-hours@1'])
  await press($, clock, edit('s'))
  const text = await drawn($, clock)
  const at = (s: string) => text.indexOf(s)
  expect(at('CARD Edits per day')).toBeGreaterThan(at('Most edits came'))
  expect(at('CARD Edits by hour')).toBeGreaterThan(at('CARD Edits per day'))
  expect(at(' Length ○○●○○ as written ')).toBeGreaterThan(at('CARD Edits by hour'))
})

test('a squeeze may change the cards: an edit is a new version under the same id, an add goes after the last card; 0 brings the original cards back, and the version comes back with its cards and no call', async ($, on) => {
  const reply = [
    `<text>\n${LONGER}\n</text>`,
    '<card edit="01-days">\n<title>How many edits each day?</title>\n<takeaway>Day 1 had the most edits.</takeaway>\n</card>',
    '<card add="edits-day-one">\n<title>Edits on day 1</title>\n<takeaway>20 edits.</takeaway>\n<data>{"days": "q4"}</data>\n<program>return k.text("day 1")</program>\n</card>',
  ].join('\n')
  const w = world(on, [reply])
  const session = mock.session(on)
  const clock = mock.clock(on)
  await answered($, clock)
  await press($, clock, edit('s'))
  // ] : Length longer, one call that shows the cards and the output they draw on, with the card guide's toolkit
  await press($, clock, edit(']'))
  await written(clock)
  expect(w.calls.length).toBe(1)
  const call = w.calls[0]
  expect(JSON.stringify(call.system)).toContain('THE PROMPT')
  expect(JSON.stringify(call.system)).toContain('The card guide')
  expect(call.prompt).toContain('The cards drawn under the original, in order:\n<card id="01-days">\n<title>Edits per day</title>')
  expect(call.prompt).toContain('<card id="02-hours">')
  expect(call.prompt).toContain('<output id="q4" about="edits per day">\n   day   n\n0    1  20')
  // the edit is a new version of the same card, the original's spec with the new parts over it; the add a new card
  expect(w.saves.map(a => a[2])).toEqual(['01-days', 'edits-day-one'])
  const v2 = JSON.parse(w.files[`${ROOT}/thimble/objects/01-days.json`]!)
  expect(v2.version).toBe(2)
  expect(v2.source).toEqual({ title: 'How many edits each day?', text: 'Day 1 had the most edits.', data: { days: 'q4' }, program: 'return k.text("x")' })
  expect(under(w)).toEqual(['01-days@2', '02-hours@1', '03-edits-day-one@1'])
  // the detail says the card was edited: the change is the analyst's
  expect(JSON.parse(w.files[`${ROOT}/thimble/objects/.edits/01-days.json`]!).edits).toEqual([2])
  let text = await drawn($, clock, ANSWER)
  expect(text).toContain('CARD How many edits each day?')
  expect(text).toContain('edited by squeeze')
  expect(text).toContain('CARD Edits on day 1')
  expect(text).toContain('added by squeeze')
  expect(text.indexOf(' Length ○○○●○ longer ')).toBeGreaterThan(text.indexOf('CARD Edits on day 1'))
  // 0: the original text and the original cards, at the versions they had
  await press($, clock, edit('0'))
  await written(clock)
  expect(under(w)).toEqual(['01-days@1', '02-hours@1'])
  text = await drawn($, clock, ANSWER)
  expect(text).toContain('CARD Edits per day')
  expect(text).not.toContain('by squeeze')
  // ] again: the longer version and its cards, with no call
  await press($, clock, edit(']'))
  await written(clock)
  expect(w.calls.length).toBe(1)
  expect(under(w)).toEqual(['01-days@2', '02-hours@1', '03-edits-day-one@1'])
  // done: Claude reads the version, with what it did to the cards
  await press($, clock, edit('s'))
  await clock.settle()
  const told = (session.appended() as unknown as { message: { content: { text?: string }[] } }[]).map(r => String(r.message.content[0]?.text ?? '')).filter(t => t.includes('now reads, for the analyst'))
  expect(told.at(-1)).toContain('Its cards changed with it: "Edits per day" (01-days) edited, now version 2; "Edits on day 1" (03-edits-day-one) added.')
})

test('a squeeze that leaves a card out says so where it stood; a card change that does not draw is left out, and the hint line says why', async ($, on) => {
  const reply = [
    `<text>\n${SHORT}\n</text>`,
    '<card drop="02-hours"/>',
    '<card edit="01-days">\n<program>return THROW</program>\n</card>',
  ].join('\n')
  const w = world(on, [reply])
  const clock = mock.clock(on)
  await answered($, clock)
  await press($, clock, edit('s'))
  await press($, clock, edit('['))
  await written(clock)
  expect(under(w)).toEqual(['01-days@1'])
  const text = await drawn($, clock, ANSWER)
  expect(text).toContain('left out by squeeze: "Edits by hour"')
  expect(text).toContain('CARD Edits per day')
  expect(await hintOf($)).toContain('the change to "Edits per day" did not draw (TypeError: data.hours is undefined), so the card stays as it was')
  // 0: the card left out comes back
  await press($, clock, edit('0'))
  await written(clock)
  expect(under(w)).toEqual(['01-days@1', '02-hours@1'])
})
