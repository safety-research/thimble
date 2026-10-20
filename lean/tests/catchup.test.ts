// Catch-up (shell/shell.tsx, verbs/squeeze/term.ts): a message arrives as Claude wrote it, and the bar at rest reads
// `s squeeze`. When two or more of Claude's replies came since the person's last prompt (the answer to it, and each
// answer to a hand-back or a notification), s is lit in squeeze's amber, bold, as `s catch up on N replies`; s then
// writes one catch-up of every message since that prompt, drawn under the newest reply beside a rule, while the
// replies stay as written. The catch-up is a message for the grammar: the chips change it, its citations open, v makes
// a card for it, and the next prompt carries it for Claude. `claude plugin test lean`.
import { expect, mock, test } from 'claude-code/testing'

import { press, promptStub } from './stubs'

const ROOT = '/data'
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
const SHOWN = '/home/t/.thimble/lean/shown/s-1.json'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// a made-up session: the person's question, a note of progress and the answer, then a subagent's hand-back and
// Claude's reply to it, which corrects the answer
const QUESTION = 'What does labels.jsonl say about the empty label?'
const NOTE = 'I will start the line counter in the background, then read labels.jsonl.'
const ANSWER = Array.from({ length: 30 }, (_, i) => `Day ${i + 1}: the empty label had [${i + 20} edits](q4#day=${i + 1}@n) from many writers.`).join('\n')
const FOLLOW = 'The counter is back: labels.jsonl has 3,104 lines.\n\nI also need to correct something I told you: I wrote that its 39 days start at the first write; they do not.'
const HANDBACK = 'Another Claude session sent a message:\n<agent-message from="a1">The file has 3,104 lines.</agent-message>'
const NOTIFY = '<task-notification>\n<status>completed</status>\n</task-notification>'
const DIGEST = 'The empty label had [20 edits](q4#day=1@n) on day 1 and more each day; labels.jsonl has 3,104 lines. Correction: its 39 days do not start at the first write.'
const LONGER = 'The empty label had [20 edits](q4#day=1@n) on day 1, rising each day to [49 edits](q4#day=30@n) on day 30, from many writers. The counter found 3,104 lines in labels.jsonl. Correction: its 39 days do not start at the first write.'

const uuid = (p: string) => `${p.repeat(8).slice(0, 8)}-0000-0000-0000-000000000000`
const P1 = uuid('p1'), A0 = uuid('a0'), A1 = uuid('a1'), H2 = uuid('h2'), A2 = uuid('a2'), N3 = uuid('n3'), A3 = uuid('a3'), H4 = uuid('h4'), A4 = uuid('a4'), E5 = uuid('e5'), P6 = uuid('p6'), A6 = uuid('a6')
const row = (u: string) => u.slice(0, 24)

const OBJECT = { id: '01-saves', version: 1, title: 'Edits per day', program: 'return k.bars(...)', data: {}, lineage: { cites: [] } }
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'region', id: 'day-1', meta: { ref: 'q4#day=1@n', label: 'Day 1 20' }, kid: { t: 'beside', kids: [{ t: 'text', runs: [{ s: 'Day 1', tone: 'ink' }], wrap: false, w: 5 }, { t: 'bar', tone: 'accent', value: 20, max: 49 }, { t: 'text', runs: [{ s: '20', tone: 'ink' }], align: 'right', w: 3 }], gap: 1 } }] }, cites: {}, examples: {}, regions: [{ id: 'day-1', meta: { ref: 'q4#day=1@n', label: 'Day 1 20' } }], warnings: [], ms: 2 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, replies: string[] = [], verb: (input: Any) => unknown = () => ({})) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [`${ROOT}/thimble/queries/q4.json`]: '{}', [`${ROOT}/thimble/objects/01-saves.json`]: JSON.stringify(OBJECT) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/queries` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/verbs/squeeze/verb.json')) return { value: '{"model": "sonnet", "effort": "low", "settleMs": 300}' }
    return { value: files[e.path] ?? promptStub(e.path) ?? '' }
  })
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const inputs: Any[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    let out: unknown = {}
    if (e.argv.some(a => a.endsWith('verb.mjs')) && e.argv.includes('list')) out = { verbs: [{ key: 'v', name: 'visualize', row: true, order: 0 }, { key: 's', name: 'squeeze', row: true, order: 1 }, { key: 'c', name: 'claims', row: true, order: 2 }] }
    else if (e.argv.some(a => a.endsWith('verb.mjs'))) { const input = JSON.parse(String(e.init?.stdin || '{}')); inputs.push(input); out = verb(input) }
    else if (e.argv.some(a => a.endsWith('prep.mjs'))) out = { drawing: DRAWING, verbs: [], problems: [] }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('prompt.fill', () => ({ isFilled: true }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  // the model: each squeeze call answers with the next reply given
  const calls: Any[] = []
  on('model.complete', async (_$: unknown, e: Any) => {
    calls.push(e)
    return { value: { isAnswered: true, text: replies[calls.length - 1] ?? '<text>(no reply left)</text>', usage: { input_tokens: 2000, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 } } }
  })
  return { files, calls, submitted, inputs }
}

// every string a drawn tree holds, in order
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return (n.type === 'Markdown' ? String(n.props?.text ?? '') : '') + textOf(n.props?.children) + textOf(n.children)
}
// each Text of a drawn tree whose children are words, with its style
function texts(n: Any, out: { text: string; bold: boolean; color: string | null }[] = []): typeof out {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => texts(x, out)); return out }
  const kids = [n.props?.children, n.children].flat().filter(x => x != null)
  if (n.type === 'Text' && kids.length && kids.every(x => typeof x === 'string')) out.push({ text: kids.join(''), bold: !!n.props?.bold, color: n.props?.color ?? null })
  else texts(kids, out)
  return out
}
// the first node of a drawn tree that `f` holds for
function find(n: Any, f: (x: Any) => boolean): Any {
  if (n == null || typeof n !== 'object') return null
  if (Array.isArray(n)) { for (const x of n) { const got = find(x, f); if (got) return got } return null }
  if (f(n)) return n
  return find(n.props?.children, f) ?? find(n.children, f)
}
const view = (u: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: u, props: { text, isFirstOfReply: true }, viewport: { columns: 100, rows: 48, isFullscreen: true } }) as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const hintOf = async ($: Any) => textOf(await $.ui.render(HINT))
const recordOf = (w: { files: Record<string, string> }, r: string) => JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${r}.json`]!)
// the call waits verb.json's settleMs, then the new text writes itself in
const written = async (clock: Any) => { await clock.advance(400); await clock.settle(); for (let i = 0; i < 120; i++) await clock.advance(50) }

/** One turn of main's: its prompt (the person's, or a hand-back or a notification by its origin), Claude's messages
 *  in order, and its end. */
async function turnOf($: Any, clock: Any, o: { turn: string; prompt?: { uuid: string; text: string; kind?: string }; says: { uuid: string; text: string }[]; reason?: string }) {
  await $.turn.start({ turnId: o.turn, text: o.prompt?.text ?? '' } as never)
  if (o.prompt) await $.session.append({ door: 'prompt', uuid: o.prompt.uuid, origin: { kind: o.prompt.kind ?? 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: o.prompt.text }] } } as never)
  for (const m of o.says) {
    await $.ui.render(view(m.uuid, m.text))
    await $.session.append({ door: 'response', uuid: m.uuid, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: m.text }] } } as never)
  }
  await $.turn.complete({ turnId: o.turn, answer: o.says.at(-1)?.text ?? '', durationMs: 5, reason: o.reason ?? 'answer', isAborted: false } as never)
  await clock.settle()
}

/** The person's question answered at length, then a hand-back answered: two replies since the prompt. */
async function piledUp($: Any, clock: Any) {
  await turnOf($, clock, { turn: 't1', prompt: { uuid: P1, text: QUESTION }, says: [{ uuid: A0, text: NOTE }, { uuid: A1, text: ANSWER }] })
  await turnOf($, clock, { turn: 't2', prompt: { uuid: H2, text: HANDBACK, kind: 'peer' }, says: [{ uuid: A2, text: FOLLOW }] })
}

test("the bar at rest reads s squeeze; two or more replies since the person's last prompt light s in squeeze's amber, bold, as s catch up on N replies", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  // a long answer arrives as written: no call, and the bar at rest
  await turnOf($, clock, { turn: 't1', prompt: { uuid: P1, text: QUESTION }, says: [{ uuid: A0, text: NOTE }, { uuid: A1, text: ANSWER }] })
  await clock.advance(1000)
  expect(w.calls.length).toBe(0)
  expect(await hintOf($)).toContain('thimble  v visualize · s squeeze · ] cite & explain')
  // a hand-back answered: two replies since the prompt (the note of progress ended no turn)
  await turnOf($, clock, { turn: 't2', prompt: { uuid: H2, text: HANDBACK, kind: 'peer' }, says: [{ uuid: A2, text: FOLLOW }] })
  let bar = await hintOf($)
  expect(bar).toContain('thimble  v visualize · s catch up on 2 replies · { } reply 2 of 2')
  expect(bar).not.toContain('lines')
  const lit = texts(await $.ui.render(HINT)).filter(t => t.text === 's' || t.text.includes('catch up on'))
  expect(lit.length).toBe(2)
  expect(lit.every(t => t.bold && t.color === '#e0a43a')).toBe(true)
  // a task's notification answered makes three; a turn that ended in an error answered nothing
  await turnOf($, clock, { turn: 't3', prompt: { uuid: N3, text: NOTIFY, kind: 'task-notification' }, says: [{ uuid: A3, text: 'Both readers are done.' }] })
  await turnOf($, clock, { turn: 't5', says: [{ uuid: E5, text: 'API Error: 500' }], reason: 'error' })
  expect(await hintOf($)).toContain('s catch up on 3 replies')
  // { picks an earlier reply: s squeezes that one; } gives the keys back to the newest, and s is lit again
  await press($, clock, edit('{'))
  bar = await hintOf($)
  expect(bar).toContain('s squeeze')
  expect(bar).toContain('{ } reply 2 of 3')
  await press($, clock, edit('}'))
  expect(await hintOf($)).toContain('s catch up on 3 replies')
  // the person's next prompt starts over: its answer alone is no pile-up
  await turnOf($, clock, { turn: 't6', prompt: { uuid: P6, text: 'And the bots?' }, says: [{ uuid: A6, text: 'No bots among them.' }] })
  expect(await hintOf($)).toContain('v visualize · s squeeze')
})

test("s writes one catch-up of everything since the person's last prompt: one call, drawn under the newest reply beside a rule, the replies as written, its citations open; the next prompt carries it for Claude", async ($, on) => {
  const w = world(on, [`<text>\n${DIGEST}\n</text>`])
  const clock = mock.clock(on)
  await piledUp($, clock)
  expect(await press($, clock, edit('s'))).toEqual({ text: '', cursor: 0 })
  // on its way: the catch-up's line under the newest reply, and the chips open on it
  let drawn = textOf(await $.ui.render(view(A2, FOLLOW)))
  expect(drawn).toContain('thimble  catch-up of 2 replies since your last message')
  expect(drawn).toContain('writing it from the messages above')
  expect(await hintOf($)).toContain('s ● writing the catch-up of 2 replies…')
  await written(clock)
  expect(w.calls.length).toBe(1)
  const call = w.calls[0]
  // the person's prompt is the question, never the hand-back; the original is every message since it, in order
  expect(call.system).toBe('THE PROMPT')
  expect(call.prompt).toContain(`The person asked: ${QUESTION}\n\nClaude's messages since the person's last prompt, in the order it wrote them, as written (the original). Write them as one message:\n<original>\n${NOTE}\n\n---\n\n${ANSWER}\n\n---\n\n${FOLLOW}\n</original>`)
  expect(call.prompt).not.toContain('Another Claude session')
  expect(call.prompt).toContain('- Length: short')
  expect(call.prompt).toContain('Corrections in the original. Each stays at every level')
  expect(call.prompt).toContain('- I also need to correct something I told you')
  // its own record, named by the reply it is under; the replies stay as Claude wrote them
  const host = recordOf(w, row(A2))
  expect(host.caughtUp).toMatch(/^cu-a2a2a2a2-/)
  const cu = recordOf(w, host.caughtUp)
  expect(cu.catchup).toEqual({ host: row(A2), rows: [row(A0), row(A1), row(A2)], replies: 2, question: QUESTION, prompt: row(P1) })
  expect(cu.shown).toBe(DIGEST)
  expect(cu.marks.filter((m: Any) => m.kind === 'cite').map((m: Any) => m.ref)).toEqual(['q4#day=1@n'])
  for (const r of [A0, A1, A2]) expect(recordOf(w, row(r)).shown).toBe(null)
  const tree = await $.ui.render(view(A2, FOLLOW))
  drawn = textOf(tree)
  expect(drawn).toContain('thimble  catch-up of 2 replies since your last message')
  // the rule runs down every row of it (the head, each line of its text, the blank rows between), and no further
  const box = find(tree, x => x.props?.key === `cu-${cu.row}`)
  const rows = [box.props?.children, box.children].flat().filter(Boolean)
  expect(rows.length).toBeGreaterThan(2)
  expect(rows.every((r: Any) => textOf(r).startsWith('▎ '))).toBe(true)
  expect(drawn.split('▎').length - 1).toBe(rows.length)
  expect(drawn.replace(/\s+/g, ' ')).toContain('The empty label had 20 edits on day 1')
  expect(drawn).toContain('Length ○●○○ short')
  expect(textOf(await $.ui.render(view(A1, ANSWER)))).not.toContain('catch-up')
  let bar = await hintOf($)
  expect(bar).toContain('s ● catch-up of 2 replies')
  expect(bar).toContain('[ ] change · 1–3 chip · + new stretch · 0 dismiss · s done')
  expect(bar).not.toContain('lines')
  // s: done; the keys act on the catch-up, and the bar says so
  await press($, clock, edit('s'))
  bar = await hintOf($)
  expect(bar).toContain('v visualize · s squeeze · ] cite & explain')
  expect(bar).toContain('{ } catch-up of 2 replies')
  expect(bar).not.toContain('catch up on')
  // its citation opens in the tray, as any reply's
  await press($, clock, edit(']'))
  expect(await hintOf($)).toContain('20 edits')
  expect(JSON.parse(w.files[`${ROOT}/thimble/panes/s-1/tray.json`]!).state.stack[0].row).toBe(cu.row)
  await press($, clock, edit('0'))
  // { goes to the newest reply, } back to the catch-up
  await press($, clock, edit('{'))
  expect(await hintOf($)).toContain('{ } reply 2 of 2')
  await press($, clock, edit('}'))
  expect(await hintOf($)).toContain('{ } catch-up of 2 replies')
  // the next prompt carries what the person read, as a squeeze's note does
  await $.prompt.submit({ text: 'And the bots?', origin: { kind: 'composer' } } as never)
  const context = w.submitted.at(-1)!.context.join('\n')
  expect(context).toContain('The person caught up on your 2 replies since their last prompt by reading them rewritten as one message by the squeeze chips (Length: short); what you wrote is unchanged, and they can read it. "This" may mean the catch-up they read:\n' + DIGEST)
})

test('the chips work on a catch-up: ] makes it longer with one call, no step lands on its original, [ comes back with none; 0 dismisses it, and two more replies offer a new one', async ($, on) => {
  const NEW = 'All four replies: [20 edits](q4#day=1@n) on day 1; 3,104 lines, and its 39 days do not start at the first write; both readers done.'
  const w = world(on, [`<text>${DIGEST}</text>`, `<text>${LONGER}</text>`, `<text>${NEW}</text>`])
  const clock = mock.clock(on)
  await piledUp($, clock)
  await press($, clock, edit('s'))
  await written(clock)
  const cuRow = recordOf(w, row(A2)).caughtUp
  // ] : Length medium, one call
  await press($, clock, edit(']'))
  await written(clock)
  expect(w.calls.length).toBe(2)
  expect(w.calls[1].prompt).toContain('- Length: medium')
  expect(recordOf(w, cuRow).shown).toBe(LONGER)
  let drawn = textOf(await $.ui.render(view(A2, FOLLOW)))
  expect(drawn).toContain('Length ○○●○ medium')
  expect(drawn.replace(/\s+/g, ' ')).toContain('rising each day to 49 edits on day 30')
  // ] again would be its original, the replies above: nothing happens
  await press($, clock, edit(']'))
  await written(clock)
  expect(w.calls.length).toBe(2)
  // [ : short again, kept, no call
  await press($, clock, edit('['))
  await written(clock)
  expect(w.calls.length).toBe(2)
  expect(recordOf(w, cuRow).shown).toBe(DIGEST)
  // 0 dismisses it: drawn no more, the keys back on the newest reply, and the replies count as read
  await press($, clock, edit('0'))
  expect(recordOf(w, cuRow).catchup.dismissed).toBe(true)
  drawn = textOf(await $.ui.render(view(A2, FOLLOW)))
  expect(drawn).not.toContain('catch-up')
  expect(await hintOf($)).toContain('v visualize · s squeeze')
  // one more reply is no pile-up; two are
  await turnOf($, clock, { turn: 't3', prompt: { uuid: N3, text: NOTIFY, kind: 'task-notification' }, says: [{ uuid: A3, text: 'Both readers are done.' }] })
  expect(await hintOf($)).toContain('s squeeze')
  await turnOf($, clock, { turn: 't4', prompt: { uuid: H4, text: HANDBACK, kind: 'peer' }, says: [{ uuid: A4, text: 'The last reader agrees.' }] })
  expect(await hintOf($)).toContain('s catch up on 4 replies')
  // the new catch-up covers every message since the prompt, under the newest reply
  await press($, clock, edit('s'))
  await written(clock)
  expect(w.calls.length).toBe(3)
  expect(w.calls[2].prompt).toContain(`${FOLLOW}\n\n---\n\nBoth readers are done.\n\n---\n\nThe last reader agrees.\n</original>`)
  const again = recordOf(w, recordOf(w, row(A4)).caughtUp)
  expect(again.catchup.replies).toBe(4)
  expect(again.shown).toBe(NEW)
  expect(textOf(await $.ui.render(view(A4, 'The last reader agrees.')))).toContain('catch-up of 4 replies')
})

test('v on a catch-up: its line opens under it, Claude reads the catch-up with the request, and the card it makes is drawn under the catch-up', async ($, on) => {
  const ask = 'The person pressed v (visualize) on the catch-up of your 2 replies since their last prompt. Make a card of it.'
  const w = world(on, [`<text>${DIGEST}</text>`], () => ({ verb: 'visualize', text: 'Claude is making another view of this answer.', ask }))
  const session = mock.session(on)
  const clock = mock.clock(on)
  on('tool.call', () => {
    w.files[EVENTS] = (w.files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: '01-saves', version: 1 }) + '\n'
    return { result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }
  })
  await piledUp($, clock)
  await press($, clock, edit('s'))
  await written(clock)
  await press($, clock, edit('s'))
  const cuRow = recordOf(w, row(A2)).caughtUp
  // v: its line opens under the catch-up
  await press($, clock, edit('v'))
  expect(textOf(await $.ui.render(view(A2, FOLLOW)))).toContain('▸ 1 another view of this answer')
  await press($, clock, edit('1'))
  await clock.settle()
  // the verb ran on the catch-up's record; the row reads as the press, and the request goes before it for Claude
  expect(w.inputs[0].message.row).toBe(cuRow)
  expect(w.inputs[0].message.catchup.replies).toBe(2)
  expect(w.submitted.map(x => x.text)).toEqual(['visualize another view of this answer'])
  const notes = (session.appended() as unknown as { door: string; message: { content: { text?: string }[] } }[]).filter(r => r.door === 'note' && r.message.content.some(b => String(b.text).includes(ask)))
  expect(notes.length).toBe(1)
  // with what the person read: the catch-up, as their own prompt would carry it
  expect(String(notes[0]!.message.content[0]!.text)).toContain('The person caught up on your 2 replies since their last prompt by reading them rewritten as one message by the squeeze chips (Length: short)')
  // Claude's turn for it saves a card: drawn under the catch-up, not under the turn's own words
  await $.turn.start({ turnId: 't3', text: 'visualize another view of this answer' } as never)
  await $.tool.call({ tool: 'Bash', command: 'thimble save empty-label-days --from card.json', tool_use_id: 'tu1' } as never)
  await $.session.append({ door: 'response', uuid: A3, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'It shows the empty label by day.' }] } } as never)
  await $.turn.complete({ turnId: 't3', answer: 'It shows the empty label by day.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  const under = JSON.parse(w.files[SHOWN]!).under
  expect(under[cuRow].map((x: Any) => x.id)).toEqual(['01-saves'])
  expect(under[row(A3)]).toBe(undefined)
  await $.ui.render(view(A2, FOLLOW))
  await clock.settle()
  const drawn = textOf(await $.ui.render(view(A2, FOLLOW)))
  expect(drawn.indexOf('Day 1')).toBeGreaterThan(drawn.indexOf('catch-up of 2 replies'))
})

test('s then a letter at once is a word: the catch-up it began is undone with no call, and s offers it again', async ($, on) => {
  const w = world(on, [`<text>${DIGEST}</text>`])
  const clock = mock.clock(on)
  await piledUp($, clock)
  await press($, clock, edit('s'))
  const cuRow = recordOf(w, row(A2)).caughtUp
  expect(cuRow).toMatch(/^cu-/)
  expect((await press($, clock, edit('o'))).text).toBe('so')
  await written(clock)
  expect(w.calls.length).toBe(0)
  expect(recordOf(w, cuRow).catchup.dismissed).toBe(true)
  expect(recordOf(w, row(A2)).caughtUp).toBe(undefined)
  expect(textOf(await $.ui.render(view(A2, FOLLOW)))).not.toContain('catch-up')
  expect(await hintOf($)).toContain('s catch up on 2 replies')
})
