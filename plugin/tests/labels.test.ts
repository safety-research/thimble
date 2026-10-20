// Labels in the terminal (shell/labels.ts, shell/labelreads.mjs, panes/detail.js): a --prompt label writes a `label`
// line in the change feed, and the shell has the model read its records beside the session, a wave of calls side by
// side, with the progress under the card and the new card in the old one's place; the detail shows each example's
// labels, the number keys check the record shown, and Claude hears of the checks when the detail closes (or at its next
// prompt). `claude plugin test`. The Node children and `thimble` are answered at process.run.
import { expect, mock, test } from 'claude-code/testing'
import { press, promptStub } from './stubs'

const ROOT = '/data'
const SESSION = 's-1'
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
const CARD = `${ROOT}/thimble/objects/02-label-apology.json`
const REFS = ['chat/room.jsonl#L1', 'chat/room.jsonl#L3', 'chat/room.jsonl#L5']
const SAMPLES = REFS.map((ref, i) => ({ ref, words: ['I am sorry, I broke the build.', 'Apologies for the noise.', 'My mistake: I misread the spec.'][i], meta: 'model 0.90' }))
const OBJECT = (v: number) => ({
  id: '02-label-apology', version: v, title: v === 1 ? 'apology: 6 records wait for the model' : 'apology: 3 of 6 records are yes', label: 'apology',
  program: 'return k.text("card")', data: {}, lineage: { cites: [] }, history: [{ v: 1, at: 'a' }, ...(v > 1 ? [{ v, at: 'b' }] : [])],
})
const region = (id: string, label: string, ex: string) => ({ t: 'region', id, meta: { label, examples: ex }, kid: { t: 'text', runs: [{ s: `${label} ▆▆▆▆`, tone: 'ink' }], wrap: false, w: 20 } })
const DRAWING = {
  kit: 1, w: 98, h: 24, mode: 'detail',
  root: { t: 'stack', kids: [region('value-0', 'yes', 'ex-0'), region('value-1', 'no', 'ex-1')] },
  cites: {}, examples: { 'ex-0': { label: 'apology = yes', total: 3, records: SAMPLES }, 'ex-1': { label: 'apology = no', total: 3, records: [] } },
  regions: [{ id: 'value-0', meta: { label: 'yes', examples: 'ex-0' } }, { id: 'value-1', meta: { label: 'no', examples: 'ex-1' } }], warnings: [], ms: 1,
}
// another card, whose parts are agents: each part's rows split by the label
const PER_AGENT = {
  kit: 1, w: 98, h: 24, mode: 'detail', cites: {}, examples: {}, warnings: [], ms: 1,
  root: { t: 'stack', kids: [{ t: 'region', id: 'agent-29', meta: { label: 'agent-29', ref: 'q5#author=agent-29@n' }, kid: { t: 'text', runs: [{ s: 'agent-29 ▆▆▆▆ 16', tone: 'ink' }], wrap: false, w: 20 } }] },
  regions: [{ id: 'agent-29', meta: { label: 'agent-29', ref: 'q5#author=agent-29@n' } }],
}
const PANE = { component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 40, offset: 0 }, isFocused: true, placement: 'dock', title: 'apology', view: {} } } as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const reply = ($: Any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'I labeled the messages.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)
const ok = (stdout: unknown) => ({ value: { exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
// the test runner's timer: a real wait lets the work the hooks left running go on
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

/** The label the kernel holds in these tests: its records, which wait for the model until answers come for them. */
type Kept = { waiting: { ref: string; text: string }[]; batch: number; values: Record<string, string>; failed: Record<string, string>; answers: number }
const RECORDS = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `chat/room.jsonl#L${i + 1}`, text: `message ${i + 1}` }))

function world(on: Any, kept: Kept = { waiting: [], batch: 50, values: {}, failed: {}, answers: 0 }) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  const files: Record<string, string> = {
    [CARD]: JSON.stringify(OBJECT(1)), [`${ROOT}/thimble/objects/.versions/02-label-apology/v1.json`]: JSON.stringify(OBJECT(1)),
    [`${ROOT}/thimble/objects/03-per-agent.json`]: JSON.stringify({ id: '03-per-agent', version: 1, title: 'Messages per agent', program: 'return k.text("card")', data: {}, lineage: { cites: [] } }),
  }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('fs.stat', (_$: unknown, e: { path: string }) => (e.path in files ? { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: 0 } } : { value: { kind: 'missing', size: 0, mtimeMs: 0 } }))
  const runs: string[][] = []
  const labelOf: Record<string, Any> = { 'chat/room.jsonl#L1': { apology: { value: 'yes', values: ['yes', 'no'], by: 'model', confidence: 0.9, reason: 'says sorry' } }, 'chat/room.jsonl#L3': { apology: { value: 'yes', values: ['yes', 'no'], by: 'model', confidence: 0.8 } }, 'chat/room.jsonl#L5': { apology: { value: 'yes', values: ['yes', 'no'], by: 'model', confidence: 0.6 } } }
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'tail') return ok((files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1))
    if (e.argv.some(a => a.endsWith('prep.mjs'))) return ok({ drawing: JSON.parse(String(e.init?.stdin || '{}')).object?.id === '03-per-agent' ? PER_AGENT : DRAWING })
    const at = e.argv.indexOf('label')
    // the model's reads: the records that wait, and the answers written back (the card saved again when none wait)
    if (at >= 0 && e.argv.includes('--waiting')) {
      const refs = kept.waiting.map(u => u.ref)
      const batches = Array.from({ length: Math.ceil(refs.length / kept.batch) }, (_, i) => refs.slice(i * kept.batch, (i + 1) * kept.batch))
      return ok({ name: 'apology', definition: 'The message apologizes.', values: ['yes', 'no'], reason: false, units: kept.waiting, batches })
    }
    if (at >= 0 && e.argv.includes('--answers')) {
      const got = JSON.parse(String(e.init?.stdin || '{}'))
      if (!e.argv.includes('--json')) return ok('')
      kept.answers++
      Object.assign(kept.values, Object.fromEntries(Object.entries(got.values || {}).map(([r, v]) => [r, (v as Any).value])))
      Object.assign(kept.failed, got.failed || {})
      kept.waiting = kept.waiting.filter(u => !(u.ref in (got.values || {})) && !(u.ref in (got.failed || {})))
      const done = !kept.waiting.length
      if (done) files[CARD] = JSON.stringify(OBJECT(2))
      const yes = Object.values(kept.values).filter(v => v === 'yes').length
      const valued = Object.keys(kept.values).length
      return ok({ took: Object.keys(got.values || {}).length, records: valued + Object.keys(kept.failed).length + kept.waiting.length, valued, waiting: kept.waiting.length, failed: Object.keys(kept.failed).length, counts: { ...(yes ? { yes } : {}), ...(valued - yes ? { no: valued - yes } : {}) }, query: done ? 'q9' : null, card: done ? { id: '02-label-apology', version: 2 } : null })
    }
    if (at >= 0 && e.argv[at + 1] === '--of') return ok(Object.fromEntries(e.argv.slice(at + 2).filter(r => labelOf[r]).map(r => [r, labelOf[r]])))
    if (at >= 0 && e.argv.includes('--check')) {
      const i = e.argv.indexOf('--check')
      const ref = e.argv[i + 1]!
      const was = labelOf[ref]?.apology?.value ?? null
      labelOf[ref] = { apology: { ...labelOf[ref]?.apology, value: e.argv[i + 2], by: 'analyst', checked: true, was } }
      return ok({ ref, was, now: e.argv[i + 2] })
    }
    if (at >= 0) {
      files[CARD] = JSON.stringify(OBJECT(3))
      return ok({ name: 'apology', query: 'q9', card: '02-label-apology', card_version: 3 })
    }
    if (e.argv.includes('resolve')) {
      // the rows behind a part of another card: how they split by the label
      if (String(e.argv[2]).startsWith('q5#')) return ok({ ref: e.argv[2], chain: [{ step: 'query', id: 'q5', about: 'messages per agent' }], rows: ['chat/room.jsonl#L1-16'], count: 16, records: [{ ref: 'chat/room.jsonl#L1', text: 'x', words: 'I am sorry, I broke the build.' }], notes: [], labels: { apology: { values: { yes: 3, no: 13 }, of: 16, rows: 16, none: 0 } } })
      return ok({ ref: e.argv[2], chain: [], rows: [], count: 0, records: [], notes: [] })
    }
    if (e.argv.includes('coverage')) return ok({ files: [] })
    return ok({})
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => { submitted.push({ text: e.text, context: e.context ?? [] }); return { text: e.text } })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.focus', () => ({ value: {} }))
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'apology', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('config.list', () => ({ value: [] }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  return { files, runs, submitted, toasts, opened, labelOf, kept }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

async function pane($: Any, clock: { settle: () => Promise<void> }): Promise<string> {
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await clock.settle() }
  return textOf(await $.ui.render(PANE))
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
/** The model's answer to one batch: yes for each record its prompt holds. */
const yes = (e: Any) => ({ isAnswered: true, text: JSON.stringify(String(e.prompt).split('### record ').slice(1).map((_, i) => ({ i: i + 1, value: 'yes', confidence: 0.9 }))), usage: USAGE })
/** The feed lines of `thimble label apology --prompt …`: its card saved, and the label for the model to read. */
const asked = (t: number, save = true) => (save ? JSON.stringify({ t, kind: 'save', session: SESSION, root: ROOT, object: '02-label-apology', version: 1 }) + '\n' : '')
  + JSON.stringify({ t, kind: 'label', name: 'apology', session: SESSION, root: ROOT, object: '02-label-apology', version: 1 }) + '\n'

test('the calls of a wave are made side by side, at most eight at once; a busy one is tried again; the answers go back to the label once the wave is in', async ($, on) => {
  const w = world(on, { waiting: RECORDS(10), batch: 1, values: {}, failed: {}, answers: 0 })
  const clock = mock.clock(on)
  let running = 0
  let most = 0
  const calls: Any[] = []
  let busy = 1
  on('model.complete', async (_$: unknown, e: Any) => {
    calls.push(e)
    running++
    most = Math.max(most, running)
    await new Promise(r => setTimeout(r, 5))
    running--
    if (String(e.prompt).includes('message 2\n') || String(e.prompt).endsWith('message 2')) { if (busy-- > 0) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' } } as never }
    return { value: yes(e) } as never
  })
  w.files[EVENTS] = asked(Date.now() / 1000 + 5, false)
  on('tool.call', () => ({ result: '' }))
  await $.tool.call({ tool: 'Bash', command: 'thimble label apology --again' } as never)
  for (let i = 0; i < 20 && w.kept.answers < 1; i++) { await clock.advance(1000); await new Promise(res => setTimeout(res, 10)) }
  // ten calls and one try again; never more than eight at once; the notes for the shell never sent
  expect(calls.length).toBe(11)
  expect(most).toBe(8)
  expect(calls.every(x => x.units === undefined && x.telemetry === undefined)).toBe(true)
  expect(w.kept.answers).toBe(1)
  expect(Object.keys(w.kept.values).length).toBe(10)
})

test("a --prompt label: the model reads its records beside the session, its progress under the card, then the new card in the old one's place; Claude hears what the reads gave with the next prompt", async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => { release = r })
  const w = world(on, { waiting: RECORDS(6), batch: 50, values: {}, failed: {}, answers: 0 })
  const clock = mock.clock(on)
  on('model.complete', async (_$: unknown, e: Any) => { await gate; return { value: yes(e) } as never })
  // Claude's `thimble label apology --prompt …`: the kernel saved the card and wrote the label in the feed
  on('tool.call', () => {
    w.files[EVENTS] = (w.files[EVENTS] || '') + asked(Date.now() / 1000)
    return { result: 'label apology v1 · prompt\n' }
  })
  await $.turn.start({ turnId: 't1', text: 'which are apologies?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'thimble label apology --in "chat/*.jsonl" --prompt "The message apologizes."' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'I labeled the messages.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'I labeled the messages.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  // the reads wait on their call: the row under the card says how far they are
  await reply($)
  await clock.settle()
  expect(textOf(await reply($))).toContain('label… 0 of 6 records')
  release()
  for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); await clock.settle() }
  // done: the new version is drawn in the old one's place, and Claude reads what the reads gave with the next prompt
  const shown = JSON.parse(w.files['/home/t/.thimble/lean/shown/s-1.json']!).under[ROW.slice(0, 24)]
  expect(shown.map((x: Any) => `${x.id}@${x.v}`)).toEqual(['02-label-apology@2'])
  expect(textOf(await reply($))).not.toContain('label…')
  await $.prompt.submit({ text: 'and?' } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('The model finished reading the records of the label apology (1 call). apology: 6 of 6 records have a value (6 yes).')
  expect(w.toasts).toEqual([])
})

test('a label written while the command still runs is read then: a chained `--wait` waits on calls already being made, and the card is drawn at the version the reads saved', async ($, on) => {
  const w = world(on, { waiting: RECORDS(6), batch: 50, values: {}, failed: {}, answers: 0 })
  const clock = mock.clock(on)
  on('model.complete', (_$: unknown, e: Any) => ({ value: yes(e) }) as never)
  let during = false
  on('tool.call', async () => {
    w.files[EVENTS] = asked(Date.now() / 1000 + 5)
    for (let i = 0; i < 100 && w.kept.answers < 1; i++) await new Promise(r => setTimeout(r, 10))
    during = w.kept.answers === 1
    return { result: 'apology: 6 of 6 records have a value' }
  })
  await $.turn.start({ turnId: 't1', text: 'which are apologies?' } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'thimble label apology --in chat.jsonl --prompt "x" && thimble label apology --wait' } as never)
  for (let i = 0; i < 20 && !during; i++) { await clock.advance(1000); await new Promise(r => setTimeout(r, 20)) }
  await call
  await clock.settle()
  // the reads ran, and wrote their answers, before the command ended; reading the feed after it starts them no second time
  expect(during).toBe(true)
  expect(w.kept.answers).toBe(1)
  // the save the command made (v1) is read after it; the card is drawn at v2, which the reads saved meanwhile
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'I labeled the messages.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'I labeled the messages.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  expect(JSON.parse(w.files['/home/t/.thimble/lean/shown/s-1.json']!).under[ROW.slice(0, 24)].map((x: Any) => `${x.id}@${x.v}`)).toEqual(['02-label-apology@2'])
})

test('a call that fails says so plainly: a toast with what failed, and the label keeps what the other calls gave', async ($, on) => {
  const w = world(on, { waiting: RECORDS(6), batch: 3, values: {}, failed: {}, answers: 0 })
  const clock = mock.clock(on)
  on('model.complete', (_$: unknown, e: Any) => ({ value: String(e.prompt).includes('message 4') ? { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request_error' } : yes(e) }) as never)
  w.files[EVENTS] = asked(Date.now() / 1000 + 5, false)
  on('tool.call', () => ({ result: '' }))
  await $.tool.call({ tool: 'Bash', command: 'thimble label apology --again' } as never)
  for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); await clock.settle() }
  // the failed call's records have no value and say why; the other call's records have theirs
  expect(Object.keys(w.kept.values).length).toBe(3)
  expect(w.kept.failed['chat/room.jsonl#L4']).toBe('the call failed: api-error 400 (invalid_request_error)')
  expect(w.toasts.join('\n')).toContain('1 call failed: api-error 400')
  expect(w.toasts.join('\n')).toContain('--again')
})

test("the detail of a label's card: each example shows its labels; a number key checks the record shown, which steps on; when the detail closes the card is counted again and Claude hears of the checks", async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '02-label-apology value-0' } as never)
  await pane($, clock)
  expect(await press($, clock, edit('e'))).toEqual({ text: '', cursor: 0 })
  const t = await pane($, clock)
  expect(t).toContain('examples of apology = yes · 1 of 3')
  expect(t).toContain('I am sorry, I broke the build.')
  expect(t).toContain('apology: yes · model 0.90: says sorry')
  // the bar names the keys that check it, by the label's values
  const hint = textOf(await $.ui.render({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never))
  expect(hint).toContain('1 yes · 2 no')
  // 1 agrees with the first record; 2 says the second is no: each is the person's check, and the examples step on
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  await pane($, clock)
  expect(await press($, clock, edit('2'))).toEqual({ text: '', cursor: 0 })
  const after = await pane($, clock)
  const checks = w.runs.filter(r => r.includes('--check')).map(r => r.slice(r.indexOf('label')).join(' '))
  expect(checks).toEqual(['label apology --check chat/room.jsonl#L1 yes --json', 'label apology --check chat/room.jsonl#L3 no --json'])
  expect(after).toContain('· 3 of 3')
  // flipped back, the checked records say so
  await press($, clock, edit('['))
  expect(await pane($, clock)).toContain('apology: yes → you: no')
  // the pane is gone (a close the module did not hear): before the next prompt to main, Claude reads the checks in a row
  // of its own
  w.opened.length = 0
  await $.prompt.submit({ text: 'so?', origin: { kind: 'composer' } } as never)
  expect(w.runs.some(r => r.slice(-3).join(' ') === 'label apology --json')).toBe(true)
  const note = (session.appended() as unknown as { message: { content: { text?: string }[] } }[]).map(r => String(r.message.content[0]?.text ?? '')).join('\n')
  expect(note).toContain('The analyst checked 2 records of the label apology: they agree with 1 and changed 1: chat/room.jsonl#L3 (the label said yes, the analyst says no)')
  expect(note).toContain('its counts are now query q9')
})

test('a label shows on what is drawn: the details of any card\'s part say how its rows split by each label that holds them', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '03-per-agent agent-29' } as never)
  await pane($, clock)
  expect(await press($, clock, edit('enter'))).toEqual({ text: '', cursor: 0 })
  const t = await pane($, clock)
  expect(t).toContain('16 rows')
  expect(t).toContain('label apology: 3 yes · 13 no')
})
