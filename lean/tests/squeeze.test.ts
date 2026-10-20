// Squeeze in the terminal (verbs/squeeze/term.ts through shell/shell.tsx): s opens the chips under the answer, each
// as its label, its dots and its level, with their keys in the hint line under the prompt; a chip's change rewrites
// the message in place with one model call, its marks placed again, and the new text writes itself in from the top; a
// stretch is typed after a + as two ends and combines with the others; 0 restores the original; a state seen before
// comes back with no call; a long answer arrives as Claude wrote it. `claude plugin test lean`.
import { expect, mock, test } from 'claude-code/testing'

import { press } from './stubs'

const ROOT = '/data'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AT = ROW.slice(0, 24)
const TEXT = 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18, from [this one](revisions.jsonl#L28) on. The `fixture scope` mattered, so I kept it.'
const LONG = Array.from({ length: 44 }, (_, i) => `Run ${i + 1} landed [${i + 3} changes](q2#run=${i + 1}@n) in the swarm.`).join('\n')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, replies: (string | Record<string, unknown>)[] = [], hold: Promise<void> | null = null) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [`${ROOT}/thimble/queries/q1.json`]: '{}' }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/queries` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (/\/prompts\/squeeze\/v\d+\.md$/.test(e.path)) return { value: 'THE PROMPT' }
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
  on('model.complete', async (_$: unknown, e: Any) => {
    calls.push(e)
    // a reply on its way until the test lets it come
    if (hold) await hold
    const text = replies[calls.length - 1] ?? '<text>(no reply left)</text>'
    // a reply given as a result is the call's result as it came (a failure)
    if (typeof text === 'object') return { value: text }
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
const view = (text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text, isFirstOfReply: true }, viewport: { columns: 100, rows: 48, isFullscreen: true } }) as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
const record = (w: { files: Record<string, string> }) => JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${AT}.json`]!)
// the new text writing itself in, tick by tick, until it is whole
const writtenIn = async (clock: Any) => { for (let i = 0; i < 120; i++) await clock.advance(50) }
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
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
  expect(await press($, clock, edit('s'))).toEqual({ text: '', cursor: 0 })
  const drawn = textOf(await $.ui.render(view(TEXT)))
  expect(drawn).not.toContain('visualize')
  expect(drawn).toContain(' Length ○○○● full ')
  expect(drawn).toContain(' Report ↔ Interpret ○●○ balanced ')
  expect(drawn).toContain(' Familiarity ○○●○○ working ')
  expect(drawn).toContain('+')
  // nothing under the chips: their keys are in the thimble line, once
  expect(drawn).not.toContain('change')
  expect(await hintOf($)).toContain('[ ] change · 1–3 chip · + new stretch · 0 close')
  // only the picked chip has a fill: its words, dots and level, and no other chip's
  const filled = (t: Any): string => (Array.isArray(t) ? t.map(filled).join('') : t && typeof t === 'object' ? (t.props?.backgroundColor ? textOf(t) : filled(t.children ?? t.props?.children)) : '')
  const fill = filled(await $.ui.render(view(TEXT)))
  expect(fill).toContain('Length')
  expect(fill).toContain('full')
  expect(fill).not.toContain('Report')
  // a short answer: nothing was squeezed, no call made
  expect(w.calls.length).toBe(0)
  // s again closes them, and the thimble line has the verbs back
  await press($, clock, edit('s'))
  expect(textOf(await $.ui.render(view(TEXT)))).not.toContain('Length')
  expect(await hintOf($)).toContain('v visualize · s squeeze')
})

test('a chip change rewrites the message in place with one call; the citations are placed again on the new text; 0 restores the original', async ($, on) => {
  const SHORT = 'June 18: [6,543 saves](q1#day=2026-06-18@n).'
  const w = world(on, [`<text>\n${SHORT}\n</text>`])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await press($, clock, edit('s'))
  // [ : Length one level down, to medium
  expect(await press($, clock, edit('['))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(w.calls.length).toBe(1)
  const call = w.calls[0]
  expect(call.model).toBe('sonnet')
  expect(call.system).toBe('THE PROMPT')
  expect(call.prompt).toContain('The analyst asked: when did the agents edit most?')
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
  expect(await hintOf($)).toContain('[ ] change · 1–3 chip · + new stretch · 0 original · s done')
  await ui.unmount()
  await press($, clock, edit('0'))
  await clock.settle()
  expect(w.calls.length).toBe(1)
  const back = record(w)
  expect(back.shown).toBe(null)
  expect(back.marks.filter((m: Any) => m.kind === 'cite').map((m: Any) => TEXT.slice(m.start, m.end))).toEqual(['[6,543 saves](q1#day=2026-06-18@n)', '[this one](revisions.jsonl#L28)'])
  expect(await hintOf($)).toContain('0 close')
  // a state seen before comes back from the record, with no call
  await press($, clock, edit('['))
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
  await press($, clock, edit('s'))
  await press($, clock, edit('3'))
  await press($, clock, edit(']'))
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
  await press($, clock, edit('['))
  await clock.settle()
  await press($, clock, edit(']'))
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
  await press($, clock, edit('s'))
  await press($, clock, edit('['))
  await clock.settle()
  // + is typed into the prompt, and what is left to type shows after it, as the chip row and the hint line say
  const plus = await press($, clock, edit('+'))
  expect(plus.text).toBe('+')
  expect(plus.decorations.some((d: Any) => d.virtualText === ' between … and …')).toBe(true)
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('stretch between … and …')
  expect(await hintOf($)).toContain('type two ends, such as engineer and manager · ↵ makes the stretch · ⌫ cancels')
  const typed = await press($, clock, edit('e', '+'))
  expect(typed.text).toBe('+e')
  expect(typed.decorations.some((d: Any) => d.virtualText === ' and …')).toBe(true)
  const both = await press($, clock, { origin: { kind: 'composer' }, key: { key: 'r' }, text: '+engineer and manage', cursor: 20, start: 20, end: 20, inputText: 'r' } as never)
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
  // the stretch is a fourth chip, on 4
  expect(await hintOf($)).toContain('[ ] change · 1–4 chip · + new stretch · 0 original · s done')
  // ] steps it toward manager: one call, with Length still at medium
  await press($, clock, edit(']'))
  await clock.settle()
  expect(w.calls.length).toBe(2)
  const call = w.calls[1].prompt
  expect(call).toContain('- Length: medium')
  expect(call).toContain('- A stretch the analyst made, from "engineer" to "manager": 1 of 3 steps toward "manager" (the original stands at "engineer", step 0)')
  rec = record(w)
  expect(rec.squeeze.at).toEqual({ length: 2, 'x-engineer-manager': 1 })
  expect(rec.shown).toBe(MGR)
  expect(rec.marks[0].ref).toBe('q1#day=2026-06-18@n')
  await writtenIn(clock)
  drawn = textOf(await $.ui.render(view(TEXT)))
  expect(drawn).toContain(' engineer ○●○○ manager ')
  expect(drawn).toContain('Status:')
  // 0: the original, every chip back, the stretch kept
  await press($, clock, edit('0'))
  await clock.settle()
  expect(record(w).shown).toBe(null)
  expect(textOf(await $.ui.render(view(TEXT)))).toContain(' engineer ●○○○ manager ')
})

test('a long answer arrives as Claude wrote it: no call, the bar at rest reads s squeeze, and s rewrites it on demand', async ($, on) => {
  const SHORT = 'Most runs landed changes: run 1 landed [4 changes](q2#run=1@n).'
  const w = world(on, [`<text>${SHORT}</text>`])
  const clock = mock.clock(on)
  await answered($, on, clock, LONG)
  await clock.settle()
  await clock.advance(1000)
  expect(w.calls.length).toBe(0)
  const rec = record(w)
  expect(rec.shown).toBe(null)
  expect(rec.squeeze).toBe(undefined)
  expect(textOf(await $.ui.render(view(LONG)))).toContain('Run 30 landed')
  expect(await hintOf($)).toContain('v visualize · s squeeze')
  expect(await hintOf($)).not.toContain('lines')
  // s, then [ : one call, and the bar says how much of it shows
  await press($, clock, edit('s'))
  expect(textOf(await $.ui.render(view(LONG)))).toContain('Length ○○○● full')
  await press($, clock, edit('['))
  await clock.settle()
  expect(w.calls.length).toBe(1)
  expect(w.calls[0].prompt).toContain('- Length: medium')
  expect(record(w).shown).toBe(SHORT)
  await press($, clock, edit('s'))
  expect(await hintOf($)).toContain('s ● 1 of 44 lines')
})

test('a key the thimble line named a moment ago is taken, never typed, when what it named has gone meanwhile: a rewrite landing closes the tray the person is closing', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const SHORT = 'Most runs landed changes: run 1 landed [4 changes](q2#run=1@n).'
  const w = world(on, [`<text>${SHORT}</text>`], held)
  const clock = mock.clock(on)
  await answered($, on, clock, LONG)
  // a rewrite to short is on its way (the chips closed meanwhile); ] opens the tray on the answer's first mark, and
  // the line says 0 closes it
  await press($, clock, edit('s'))
  await press($, clock, edit('['))
  await press($, clock, edit('s'))
  await press($, clock, edit(']'))
  expect(await hintOf($)).toContain('0 close')
  // the squeezed text arrives: its marks moved, so the tray closes, and the line no longer names 0
  release()
  await clock.settle()
  expect(record(w).shown).toBe(SHORT)
  expect(await hintOf($)).not.toContain('0 close')
  // it closes as esc closes it: the browser's tray, which reads the tray's shared state, closes too
  expect(JSON.parse(w.files[`${ROOT}/thimble/panes/s-1/tray.json`]!).state.stack).toEqual([])
  // the 0 the person pressed as the line said: it does nothing, and never lands in the prompt
  expect(await press($, clock, edit('0'))).toEqual({ text: '', cursor: 0 })
  // a 0 pressed when the line has said otherwise for a while is typed
  await clock.advance(1500)
  await hintOf($)
  expect(await press($, clock, edit('0'))).toEqual({ text: '0', cursor: 1 })
})

test('a rewrite that cites a ref the original never cited shows it as plain words, and the hint line says so', async ($, on) => {
  const w = world(on, ['<text>June 18 had [6,543 saves](q1#day=2026-06-18@n), [12% more](q9#x@n).</text>'])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await press($, clock, edit('s'))
  await press($, clock, edit('3'))
  await press($, clock, edit('['))
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
  await press($, clock, edit('s'))
  // three presses before the first call comes back: medium, short, one line (no settling between them)
  for (let i = 0; i < 3; i++) await ($ as Any).prompt.edit(edit('['))
  await clock.settle()
  expect(textOf(await $.ui.render(view(TEXT)))).toContain('Length ●○○○ one line')
  await clock.settle()
  await clock.settle()
  // the first call (medium) was on its way; short was passed over; one line came last
  expect(w.calls.length).toBe(2)
  expect(w.calls[1].prompt).toContain('- Length: one line')
  expect(record(w).squeeze.at).toEqual({ length: 0 })
  expect(record(w).shown).toBe('June 18: [6,543 saves](q1#day=2026-06-18@n).')
})

test('a correction of its own earlier answer stays at every length: the request names it, and a rewrite that leaves it out gets it back', async ($, on) => {
  const FIXED = 'June 18 had the most saves.\n\nTwo corrections to my last answer:\n- **AgentRelent:** it made 316 edits, not 317.\n- **The split:** 5,242 link edits, not 5,181.'
  // the rewrite at one line keeps the first correction and leaves out the second
  const w = world(on, Array(3).fill('<text>\nJune 18 had the most saves (AgentRelent: 316, not 317).\n</text>'))
  const clock = mock.clock(on)
  await answered($, on, clock, FIXED)
  await press($, clock, edit('s'))
  // three steps of Length down: one line
  for (const k of ['<', '<', '<']) await press($, clock, edit(k))
  await clock.settle()
  const call = w.calls.at(-1)
  expect(call.prompt).toContain('then each correction listed below in a few words')
  expect(call.prompt).toContain('Corrections in the original. Each stays at every level')
  expect(call.prompt).toContain('- **The split:** 5,242 link edits, not 5,181.')
  const rec = record(w)
  expect(rec.shown).toContain('316, not 317')
  // the correction the rewrite dropped is put back after it, as the original says it
  expect(rec.shown).toContain('**The split:** 5,242 link edits, not 5,181.')
})

test('a correction that heads a list keeps it: the request nests the list under its heading, and a rewrite ending on the bare heading shows the left-out item under it', async ($, on) => {
  const NESTED = 'Two corrections to my last answer:\n- **The share:** 5,242 link edits, not 5,181.\n- **The numbers I did not cite before:**\n  - [6,543 saves](q1#day=2026-06-18@n) on June 18.\n  - 93 of the 94 idle editors were bots.\n\nThe edits peaked at 22:10.'
  // the rewrite keeps the share and June 18, leaves out the idle editors, and ends on the bare heading
  const w = world(on, Array(3).fill('<text>\n5,242 link edits, not 5,181; [6,543 saves](q1#day=2026-06-18@n) on June 18.\n\n**The numbers I did not cite before:**\n</text>'))
  const clock = mock.clock(on)
  await answered($, on, clock, NESTED)
  await press($, clock, edit('s'))
  for (const k of ['<', '<', '<']) await press($, clock, edit(k))
  await clock.settle()
  expect(w.calls.at(-1).prompt).toContain('- **The numbers I did not cite before:**\n  - [6,543 saves](q1#day=2026-06-18@n) on June 18.\n  - 93 of the 94 idle editors were bots.')
  // the bare heading is gone, and the item the rewrite left out is back under it
  expect(record(w).shown).toBe('5,242 link edits, not 5,181; [6,543 saves](q1#day=2026-06-18@n) on June 18.\n\n**The numbers I did not cite before:**\n- 93 of the 94 idle editors were bots.')
})

test('an explain mark stays on a squeezed text: the request names its term, a term said in another form keeps its mark, and a term left out shows after the text', async ($, on) => {
  const FORM = 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18; the fixture scoped them.'
  const GONE = 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18.'
  const w = world(on, [`<text>\n${FORM}\n</text>`, `<text>\n${GONE}\n</text>`])
  const clock = mock.clock(on)
  // the answer's record as the observer left it: a citation, and an explain mark on `fixture scope`
  const dir = `${ROOT}/thimble/messages/s-1`
  const marks = [{ kind: 'cite', start: 7, end: 41, ref: 'q1#day=2026-06-18@n', label: '6,543 saves' }, { kind: 'gloss', start: 99, end: 114, gloss: 'g1' }]
  expect(TEXT.slice(99, 114)).toBe('`fixture scope`')
  w.files[`${dir}/index.jsonl`] = `${JSON.stringify({ row: 'pppppppp-0000-0000-0000-', kind: 'user', text: 'when did the agents edit most?' })}\n${JSON.stringify({ row: AT, kind: 'assistant' })}\n`
  w.files[`${dir}/${AT}.json`] = JSON.stringify({ v: 1, row: AT, session: 's-1', text: TEXT, shown: null, marks, glosses: { g1: { term: 'fixture scope', title: 'fixture scope', body: 'How widely one fixture is shared.' } }, verbs: {}, objects: [], final: true })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  await press($, clock, edit('s'))
  await press($, clock, edit('['))
  await clock.settle()
  expect(w.calls[0].prompt).toContain('Terms the analyst can open an explainer of. Where your text keeps what a term names, use the term in these words:\n- fixture scope')
  let rec = record(w)
  const g = rec.marks.find((m: Any) => m.kind === 'gloss')
  expect(FORM.slice(g.start, g.end)).toBe('fixture scoped')
  // the rewrite one level shorter leaves the term out: its explain stays, drawn after the text
  await press($, clock, edit('['))
  await clock.settle()
  await writtenIn(clock)
  rec = record(w)
  expect(rec.shown).toBe(GONE)
  expect(rec.marks.filter((m: Any) => m.kind === 'gloss').map((m: Any) => [m.loose, m.start, m.gloss])).toEqual([[true, GONE.length, 'g1']])
  const ui = await $.ui.mount(view(TEXT))
  expect(textOf(await ui.drawn())).toContain('explain: fixture scope (in the full answer)')
  await ui.unmount()
  // with the chips closed, ] reaches it after the citation and opens its explain card
  await press($, clock, edit('s'))
  await press($, clock, edit(']'))
  await press($, clock, edit(']'))
  await clock.settle()
  const band = await hintOf($)
  expect(band).toContain('─ fixture scope ─')
  expect(band).toContain('─ explain ─')
})

test('a rewrite that fails says what failed in plain words and which key tries again', async ($, on) => {
  // the call finds no sign-in: Claude Code says no HTTP status and an error of no named kind
  const w = world(on, [{ isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await press($, clock, edit('s'))
  await press($, clock, edit('['))
  await clock.settle()
  const bar = await hintOf($)
  expect(bar).toContain('The rewrite failed: no reply came from the API. Check the connection, or sign in again with /login. Press [ to try again')
  expect(bar).not.toContain('unknown')
  // the browser's chips read the same words from the record
  expect(record(w).squeeze.error).toContain('Press [ to try again')
})

test('a rewrite refused for an expired sign-in says so in plain words, with the fix: sign in again with /login', async ($, on) => {
  const w = world(on, [{ isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }])
  const clock = mock.clock(on)
  await answered($, on, clock)
  await press($, clock, edit('s'))
  await press($, clock, edit('['))
  await clock.settle()
  const bar = await hintOf($)
  expect(bar).toContain('The rewrite failed: the sign-in failed or expired. Sign in again with /login. Press [ to try again')
  expect(bar).not.toContain('401')
  expect(bar).not.toContain('authentication_failed')
  expect(record(w).squeeze.error).toContain('Sign in again with /login')
})
