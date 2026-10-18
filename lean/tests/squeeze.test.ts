// Squeeze in the terminal (verbs/squeeze/term.ts through shell/shell.tsx): s opens the chips under the answer, each
// as its label, its dots and its level, with their keys in the hint line under the prompt; a chip's change rewrites
// the message in place with one model call, its marks placed again, and the new text writes itself in from the top; a
// stretch is typed after a + as two ends and combines with the others; 0 restores the original; a state seen before
// comes back with no call; a long answer arrives squeezed. `claude plugin test lean`.
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
    if (e.path.endsWith('/prompts/squeeze/v2.md')) return { value: 'THE PROMPT' }
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
  on('prompt.fill', (_$: unknown, e: { text: string }) => { fills.push(e.text); return { isFilled: true } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  // Claude Code's hint line under the prompt, as a hook leaves it
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
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
  return (n.type === 'Markdown' ? String(n.props?.text ?? '') : '') + textOf(n.props?.children) + textOf(n.children)
}
const view = (text: string) => ({ plugin: 'thimble-lean', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text, isFirstOfReply: true }, viewport: { columns: 100, rows: 48, isFullscreen: true } }) as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
const record = (w: { files: Record<string, string> }) => JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${AT}.json`]!)
// the new text writing itself in, tick by tick, until it is whole
const writtenIn = async (clock: Any) => { for (let i = 0; i < 120; i++) await clock.advance(50) }
const HINT = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hintOf = async ($: any, _draft = false) => textOf(await $.ui.render(HINT))

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

test('s opens the chips under the answer, in place of its verb row: each its label, dots and level, the keys in the hint line', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await answered($, on, clock)
  // the verbs are in the thimble line above the prompt, in words; nothing under the answer
  expect(await hintOf($)).toContain('thimble  v visualize · s squeeze')
  expect(textOf(await $.ui.render(view(TEXT)))).not.toContain('visualize')
  expect(await ($ as Any).prompt.edit(edit('s'))).toEqual({ text: '', cursor: 0 })
  const drawn = textOf(await $.ui.render(view(TEXT)))
  expect(drawn).not.toContain('visualize')
  expect(drawn).toContain(' Length ○○○● full ')
  expect(drawn).toContain(' Report ↔ Interpret ○●○ balanced ')
  expect(drawn).toContain(' Familiarity ○○●○○ working ')
  expect(drawn).toContain('+')
  // nothing under the chips: their keys are in the thimble line, once
  expect(drawn).not.toContain('change')
  expect(await hintOf($)).toContain('< > change · ] next chip · + new stretch · 0 close')
  // only the picked chip has a fill
  const tree = JSON.stringify(await $.ui.render(view(TEXT)))
  expect((tree.match(/"backgroundColor":"#4a3b1d"/g) || []).length).toBe(7)
  // a short answer: nothing was squeezed, no call made
  expect(w.calls.length).toBe(0)
  // s again closes them, and the thimble line has the verbs back
  await ($ as Any).prompt.edit(edit('s'))
  expect(textOf(await $.ui.render(view(TEXT)))).not.toContain('Length')
  expect(await hintOf($)).toContain('v visualize · s squeeze')
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
  expect(call.prompt).toContain('- Length: medium, at most 14 words (levels one line · short · medium · full; the original is at full, 18 words)')
  expect(call.prompt).toContain('- Report ↔ Interpret: as the original')
  expect(call.prompt).toContain('- Familiarity: as the original (levels new to the field · beginner · working · fluent · expert)')
  const rec = record(w)
  expect(rec.text).toBe(TEXT)
  expect(rec.shown).toBe(SHORT)
  expect(rec.marks.map((m: Any) => SHORT.slice(m.start, m.end))).toEqual(['[6,543 saves](q1#day=2026-06-18@n)'])
  expect(rec.squeeze.at).toEqual({ length: 2 })
  await writtenIn(clock)
  // the message is drawn from the new text, its citation a press; the chip reads medium; the hint offers the original
  const ui = await $.ui.mount(view(TEXT))
  const drawn = textOf(await ui.drawn())
  expect(drawn).toContain('June 18: 6,543 saves.')
  expect(drawn).not.toContain('from this one')
  expect(drawn).toContain('Length ○○●○ medium')
  expect(drawn).not.toContain('rewriting')
  expect(await hintOf($)).toContain('< > change · ] next chip · + new stretch · 0 original · s done')
  await ui.unmount()
  await ($ as Any).prompt.edit(edit('0'))
  await clock.settle()
  expect(w.calls.length).toBe(1)
  const back = record(w)
  expect(back.shown).toBe(null)
  expect(back.marks.filter((m: Any) => m.kind === 'cite').map((m: Any) => TEXT.slice(m.start, m.end))).toEqual(['[6,543 saves](q1#day=2026-06-18@n)', '[this one](revisions.jsonl#L28)'])
  expect(await hintOf($)).toContain('0 close')
  // a state seen before comes back from the record, with no call
  await ($ as Any).prompt.edit(edit('<'))
  await clock.settle()
  expect(w.calls.length).toBe(1)
  expect(record(w).shown).toBe(SHORT)
  await $.prompt.submit({ text: 'and then?', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('rewritten by the squeeze chips (Length: medium)')
})

test('the new text writes itself in from the top: the old text dims while the call runs, then the new one grows from its first words until it is whole', async ($, on) => {
  const NEW = 'June 18 had the most saves: [6,543](q1#day=2026-06-18@n). ' + 'The agents saved again and again that day, page after page, until the evening run ended. '.repeat(4)
  const w = world(on, [`<text>${NEW}</text>`])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await ($ as Any).prompt.edit(edit('s'))
  await ($ as Any).prompt.edit(edit('3'))
  await ($ as Any).prompt.edit(edit('>'))
  await clock.settle()
  expect(w.calls[0].prompt).toContain('- Familiarity: fluent (levels new to the field · beginner · working · fluent · expert; the original is at a level not yet known)')
  // the first piece only: whole words, the citation whole
  const first = textOf(await $.ui.render(view(TEXT)))
  expect(first).toContain('June 18 had the most')
  expect(first).not.toContain('evening run ended')
  expect(first).not.toContain('from this one')
  await clock.advance(200)
  const more = textOf(await $.ui.render(view(TEXT)))
  expect(more.length).toBeGreaterThan(first.length)
  await writtenIn(clock)
  // (the words wrap into lines, so they are read without their spaces)
  const whole = textOf(await $.ui.render(view(TEXT))).replace(/\s+/g, '')
  expect(whole).toContain('untiltheeveningrunended.Theagents')
  expect(whole.match(/eveningrunended/g)!.length).toBe(4)
  // a state seen before writes itself in too, with no call
  await ($ as Any).prompt.edit(edit('<'))
  await clock.settle()
  await ($ as Any).prompt.edit(edit('>'))
  await clock.settle()
  expect(w.calls.length).toBe(1)
  expect((textOf(await $.ui.render(view(TEXT))).replace(/\s+/g, '').match(/eveningrunended/g) || []).length).toBeLessThan(4)
  await writtenIn(clock)
  expect(textOf(await $.ui.render(view(TEXT))).replace(/\s+/g, '').match(/eveningrunended/g)!.length).toBe(4)
})

test('a stretch: + then two ends and ↵ make a chip that stands at the original; a step toward an end is one call that names the stretch beside the other chips', async ($, on) => {
  const MGR = '**Status:** most saves on June 18, [6,543](q1#day=2026-06-18@n).'
  const w = world(on, ['<text>\nJune 18: [6,543 saves](q1#day=2026-06-18@n).\n</text>', `<text>\n${MGR}\n</text>`])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await ($ as Any).prompt.edit(edit('s'))
  await ($ as Any).prompt.edit(edit('<'))
  await clock.settle()
  // + is typed into the prompt, and what is left to type shows after it, as the chip row and the hint line say
  const plus = await ($ as Any).prompt.edit(edit('+'))
  expect(plus.text).toBe('+')
  expect(plus.decorations.some((d: Any) => d.virtualText === ' between … and …')).toBe(true)
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('stretch between … and …')
  expect(await hintOf($)).toContain('type two ends, such as engineer and manager · ↵ makes the stretch · ⌫ cancels')
  const typed = await ($ as Any).prompt.edit(edit('e', '+'))
  expect(typed.text).toBe('+e')
  expect(typed.decorations.some((d: Any) => d.virtualText === ' and …')).toBe(true)
  const both = await ($ as Any).prompt.edit({ origin: { kind: 'composer' }, key: { key: 'r' }, text: '+engineer and manage', cursor: 20, start: 20, end: 20, inputText: 'r' } as never)
  expect(both.text).toBe('+engineer and manager')
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('stretch between engineer and manager')
  expect(await hintOf($, true)).toContain('↵ makes engineer ↔ manager · ⌫ the + cancels')
  const r = await $.prompt.submit({ text: '+engineer and manager', origin: { kind: 'composer' } } as never)
  expect((r as Any).drop).toBe('stretch engineer ↔ manager')
  expect(w.submitted.length).toBe(0)
  await clock.settle()
  // the prompt box, which keeps a dropped prompt, is emptied; the new chip stands at the original: no call
  await (clock as Any).advance(100)
  expect(w.fills.at(-1)).toBe('')
  expect(w.calls.length).toBe(1)
  let rec = record(w)
  expect(rec.squeeze.own).toEqual([{ id: 'x-engineer-manager', kind: 'stretch', from: 'engineer', to: 'manager' }])
  let drawn = textOf(await $.ui.render(view(TEXT)))
  expect(drawn).toContain(' engineer ●○○○ manager ')
  expect(drawn).toContain('Length ○○●○ medium')
  expect(await hintOf($)).toContain('< > change · ] next chip · + new stretch · 0 original · s done')
  // > steps it toward manager: one call, with Length still at medium
  await ($ as Any).prompt.edit(edit('>'))
  await clock.settle()
  expect(w.calls.length).toBe(2)
  const call = w.calls[1].prompt
  expect(call).toContain('- Length: medium')
  expect(call).toContain('- A stretch the person made, from "engineer" to "manager": 1 of 3 steps toward "manager" (the original stands at "engineer", step 0)')
  rec = record(w)
  expect(rec.squeeze.at).toEqual({ length: 2, 'x-engineer-manager': 1 })
  expect(rec.shown).toBe(MGR)
  expect(rec.marks[0].ref).toBe('q1#day=2026-06-18@n')
  await writtenIn(clock)
  drawn = textOf(await $.ui.render(view(TEXT)))
  expect(drawn).toContain(' engineer ○●○○ manager ')
  expect(drawn).toContain('Status:')
  // 0: the original, every chip back, the stretch kept
  await ($ as Any).prompt.edit(edit('0'))
  await clock.settle()
  expect(record(w).shown).toBe(null)
  expect(textOf(await $.ui.render(view(TEXT)))).toContain(' engineer ●○○○ manager ')
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
  await writtenIn(clock)
  const drawn = textOf(await $.ui.render(view(LONG)))
  expect(await hintOf($)).toContain('s ● 1 of 44 lines')
  expect(drawn).not.toContain('Run 30 landed')
  await ($ as Any).prompt.edit(edit('s'))
  expect(textOf(await $.ui.render(view(LONG)))).toContain('Length ○●○○ short')
  await ($ as Any).prompt.edit(edit('0'))
  await clock.settle()
  expect(record(w).shown).toBe(null)
  expect(await hintOf($)).toContain('0 close')
})

test('a rewrite that cites a ref the original never cited shows it as plain words, and the hint line says so', async ($, on) => {
  const w = world(on, ['<text>June 18 had [6,543 saves](q1#day=2026-06-18@n), [12% more](q9#x@n).</text>'])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await ($ as Any).prompt.edit(edit('s'))
  await ($ as Any).prompt.edit(edit('3'))
  await ($ as Any).prompt.edit(edit('<'))
  await clock.settle()
  expect(w.calls[0].prompt).toContain('- Familiarity: beginner')
  const rec = record(w)
  expect(rec.shown).toBe('June 18 had [6,543 saves](q1#day=2026-06-18@n), 12% more.')
  expect(rec.marks.map((m: Any) => m.ref)).toEqual(['q1#day=2026-06-18@n'])
  expect(await hintOf($)).toContain('! a citation to q9#x@n is not in the original')
  // nothing but the chips under the message
  await writtenIn(clock)
  expect(textOf(await $.ui.render(view(TEXT)))).not.toContain('not in the original')
})

test('keys pressed while a rewrite is on its way add up: the chip shows where it goes at once, and only the last level waiting is written', async ($, on) => {
  const w = world(on, ['<text>\nMedium: [6,543 saves](q1#day=2026-06-18@n) on June 18.\n</text>', '<text>\nJune 18: [6,543 saves](q1#day=2026-06-18@n).\n</text>'])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await ($ as Any).prompt.edit(edit('s'))
  // three presses before the first call comes back: medium, short, one line
  await ($ as Any).prompt.edit(edit('<'))
  await ($ as Any).prompt.edit(edit('<'))
  await ($ as Any).prompt.edit(edit('<'))
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('Length ●○○○ one line')
  await clock.settle()
  await clock.settle()
  // the first call (medium) was on its way; short was passed over; one line came last
  expect(w.calls.length).toBe(2)
  expect(w.calls[1].prompt).toContain('- Length: one line')
  expect(record(w).squeeze.at).toEqual({ length: 0 })
  expect(record(w).shown).toBe('June 18: [6,543 saves](q1#day=2026-06-18@n).')
})
