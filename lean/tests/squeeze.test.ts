// Squeeze in the terminal (verbs/squeeze/term.ts through shell/shell.tsx): s opens the chips under the answer with
// the keys that work named under them; a chip's change rewrites the message in place with one model call, its marks
// placed again; the person's own chip is typed after a + and combines with the others; 0 restores the original; a
// level seen before comes back with no call; a long answer arrives squeezed. `claude plugin test lean`.
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/data'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AT = ROW.slice(0, 24)
const TEXT = 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18, from [this one](revisions.jsonl#L28) on. The `fixture scope` mattered, so I kept it.'
const LONG = Array.from({ length: 44 }, (_, i) => `Run ${i + 1} landed [${i + 3} changes](q2#run=${i + 1}@n) in the swarm.`).join('\n')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, replies: string[] = []) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [`${ROOT}/thimble/queries/q1.json`]: '{}' }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/queries` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/verbs/squeeze/prompt.md')) return { value: 'THE PROMPT' }
    if (e.path.endsWith('/verbs/squeeze/verb.json')) return { value: '{"model": "sonnet", "effort": "low"}' }
    return { value: files[e.path] ?? '' }
  })
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const out = e.argv.some(a => a.endsWith('verb.mjs')) ? { verbs: [{ key: 'v', name: 'visualize', row: true, order: 0 }, { key: 's', name: 'squeeze', row: true, order: 1 }] } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  const fills: string[] = []
  on('prompt.fill', (_$: unknown, e: { text: string }) => { fills.push(e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  // the model: each call answers with the next reply given, and is kept for the test to read
  const calls: Any[] = []
  on('model.complete', (_$: unknown, e: Any) => {
    calls.push(e)
    const text = replies[calls.length - 1] ?? '<text>(no reply left)</text>'
    return { value: { isAnswered: true, text, usage: { input_tokens: 2000, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 } } }
  })
  return { files, submitted, calls, fills }
}

// every string a drawn tree holds, in order
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
const view = (text: string) => ({ plugin: 'thimble-lean', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text, isFirstOfReply: true }, viewport: { columns: 100, rows: 48, isFullscreen: true } }) as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
const record = (w: { files: Record<string, string> }) => JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${AT}.json`]!)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function answered($: any, on: any, clock: { settle: () => Promise<void> }, text = TEXT) {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'prompt', uuid: 'pppppppp-0000-0000-0000-000000000000', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'when did the agents edit most?' }] } } as never)
  // the drawing measures the screen a long message is held to
  await $.ui.render(view(text))
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: text, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('s opens the chips under the answer, in place of its verb row, with the keys that work named under them', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await answered($, on, clock)
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('v visualize · s squeeze')
  expect(await ($ as Any).prompt.edit(edit('s'))).toEqual({ text: '', cursor: 0 })
  const drawn = textOf(await $.ui.render(view(TEXT)))
  expect(drawn).not.toContain('v visualize')
  expect(drawn).toContain('1 Length')
  expect(drawn).toContain('●●●● full')
  expect(drawn).toContain('2 Report ↔ Interpret')
  expect(drawn).toContain('3 Familiarity')
  expect(drawn).toContain('add')
  // the footer: every key that works, as the person reads it
  expect(drawn).toContain('1–3 chip · < > change · + add · 0 close')
  // a short answer: nothing was squeezed, no call made
  expect(w.calls.length).toBe(0)
  // s again closes them
  await ($ as Any).prompt.edit(edit('s'))
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('v visualize · s squeeze')
})

test('a chip change rewrites the message in place with one call; the citations are placed again on the new text; 0 restores the original', async ($, on) => {
  const SHORT = 'June 18: [6,543 saves](q1#day=2026-06-18@n).'
  const w = world(on, [`<text>\n${SHORT}\n</text>`])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await ($ as Any).prompt.edit(edit('s'))
  // < : Length one level down, to medium
  expect(await ($ as Any).prompt.edit(edit('<'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(w.calls.length).toBe(1)
  const call = w.calls[0]
  expect(call.model).toBe('sonnet')
  expect(call.system).toBe('THE PROMPT')
  expect(call.prompt).toContain('The person asked: when did the agents edit most?')
  expect(call.prompt).toContain(TEXT)
  expect(call.prompt).toContain('- Length: medium (levels one line · short · medium · full; the original is at full)')
  expect(call.prompt).toContain('- Report ↔ Interpret: as the original')
  const rec = record(w)
  expect(rec.text).toBe(TEXT)
  expect(rec.shown).toBe(SHORT)
  expect(rec.marks.map((m: Any) => SHORT.slice(m.start, m.end))).toEqual(['[6,543 saves](q1#day=2026-06-18@n)'])
  expect(rec.squeeze.at).toEqual({ length: 2 })
  // the message is drawn from the new text, its citation a press; the chip reads medium; the footer offers the original
  const ui = await $.ui.mount(view(TEXT))
  const drawn = textOf(await ui.drawn())
  expect(drawn).toContain('June 18: ')
  expect(drawn).not.toContain('from this one')
  expect(drawn).toContain('●●●○ medium')
  expect(drawn).toContain('0 original · s close')
  await ui.unmount()
  await ($ as Any).prompt.edit(edit('0'))
  await clock.settle()
  expect(w.calls.length).toBe(1)
  const back = record(w)
  expect(back.shown).toBe(null)
  expect(back.marks.filter((m: Any) => m.kind === 'cite').map((m: Any) => TEXT.slice(m.start, m.end))).toEqual(['[6,543 saves](q1#day=2026-06-18@n)', '[this one](revisions.jsonl#L28)'])
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('0 close')
  // a level seen before comes back from the record, with no call
  await ($ as Any).prompt.edit(edit('<'))
  await clock.settle()
  expect(w.calls.length).toBe(1)
  expect(record(w).shown).toBe(SHORT)
  await $.prompt.submit({ text: 'and then?', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('rewritten by the squeeze chips (Length: medium)')
})

test("the person's own chip: + then its words and ↵ make it, the prompt never reaches Claude, and one call sizes it and writes the message with every chip's level", async ($, on) => {
  const w = world(on, ['<text>\nJune 18: [6,543 saves](q1#day=2026-06-18@n).\n</text>', '<chip levels="off | plain | status" pick="status"/>\n<text>\n**Status:** most saves on June 18, [6,543](q1#day=2026-06-18@n).\n</text>'])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await ($ as Any).prompt.edit(edit('s'))
  await ($ as Any).prompt.edit(edit('<'))
  await clock.settle()
  // + is typed into the prompt, the chips stay open, and the footer says where the words go
  const plus = await ($ as Any).prompt.edit(edit('+'))
  expect(plus.text).toBe('+')
  expect(plus.decorations.some((d: Any) => /your chip/.test(d.virtualText || ''))).toBe(true)
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('type your chip after the +, then ↵')
  const typed = await ($ as Any).prompt.edit(edit('f', '+'))
  expect(typed.text).toBe('+f')
  const r = await $.prompt.submit({ text: '+ for my manager', origin: { kind: 'composer' } } as never)
  expect((r as Any).drop).toContain('For my manager')
  expect(w.submitted.length).toBe(0)
  await clock.settle()
  expect(w.calls.length).toBe(2)
  const call = w.calls[1]
  expect(call.prompt).toContain('- Length: medium')
  expect(call.prompt).toContain('The person added a chip in their own words: "for my manager"')
  const rec = record(w)
  expect(rec.squeeze.own).toEqual([{ id: 'my-for-my-manager', name: 'For my manager', words: 'for my manager', levels: ['off', 'plain', 'status'], level0: 0 }])
  expect(rec.squeeze.at).toEqual({ length: 2, 'my-for-my-manager': 2 })
  expect(rec.shown).toContain('**Status:**')
  expect(rec.marks[0].ref).toBe('q1#day=2026-06-18@n')
  const drawn = textOf(await $.ui.render(view(TEXT)))
  expect(drawn).toContain('4 For my manager')
  expect(drawn).toContain('●● status')
  expect(drawn).toContain('1–4 chip')
})

test('a long answer arrives squeezed: one call at Length short, the verb row says how much of it shows, and the original is one key away', async ($, on) => {
  const SHORT = 'Most runs landed changes: run 1 landed [4 changes](q2#run=1@n).'
  const w = world(on, [`<text>${SHORT}</text>`])
  const clock = mock.clock(on)
  await answered($, on, clock, LONG)
  await clock.settle()
  expect(w.calls.length).toBe(1)
  expect(w.calls[0].prompt).toContain('- Length: short')
  const rec = record(w)
  expect(rec.shown).toBe(SHORT)
  expect(rec.squeeze.auto).toBe(true)
  expect(rec.marks.map((m: Any) => m.ref)).toEqual(['q2#run=1@n'])
  const drawn = textOf(await $.ui.render(view(LONG)))
  expect(drawn).toContain('s ● 1 of 44 lines')
  expect(drawn).not.toContain('Run 30 landed')
  await ($ as Any).prompt.edit(edit('s'))
  expect(textOf(await $.ui.render(view(LONG)))).toContain('●●○○ short')
  await ($ as Any).prompt.edit(edit('0'))
  await clock.settle()
  expect(record(w).shown).toBe(null)
  expect(textOf(await $.ui.render(view(LONG)))).toContain('0 close')
})

test('a rewrite that cites a ref the original never cited shows it as plain words, and says so under the chips', async ($, on) => {
  const w = world(on, ['<text>June 18 had [6,543 saves](q1#day=2026-06-18@n), [12% more](q9#x@n).</text>'])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await ($ as Any).prompt.edit(edit('s'))
  await ($ as Any).prompt.edit(edit('3'))
  await ($ as Any).prompt.edit(edit('<'))
  await clock.settle()
  expect(w.calls[0].prompt).toContain('- Familiarity: new')
  const rec = record(w)
  expect(rec.shown).toBe('June 18 had [6,543 saves](q1#day=2026-06-18@n), 12% more.')
  expect(rec.marks.map((m: Any) => m.ref)).toEqual(['q1#day=2026-06-18@n'])
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('! a citation to q9#x@n is not in the original')
})
