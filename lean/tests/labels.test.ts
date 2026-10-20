// Labels in the terminal (shell/labels.ts, panes/detail.js, the label verb, and the fan-out of a verb's model calls in
// shell/shell.tsx): calls a verb starts together are made side by side; a --prompt label asks for the label verb in the
// change feed, which the shell runs beside the session with its progress under the card and the new card in the old
// one's place; the detail shows each example's labels, the number keys check the record shown, and Claude hears of the
// checks when the detail closes (or at its next prompt). `claude plugin test lean`. The Node children and `thimble` are answered at process.run.
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
type Verb = (input: Any) => Any
// the test runner's timer: a real wait lets the work the hooks left running go on
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

function world(on: Any, verb: Verb = () => ({ verb: 'label', text: 'ok' })) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  const files: Record<string, string> = {
    [CARD]: JSON.stringify(OBJECT(1)), [`${ROOT}/thimble/objects/.versions/02-label-apology/v1.json`]: JSON.stringify(OBJECT(1)),
    [`${ROOT}/thimble/objects/03-per-agent.json`]: JSON.stringify({ id: '03-per-agent', version: 1, title: 'Messages per agent', program: 'return k.text("card")', data: {}, lineage: { cites: [] } }),
  }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` || e.path.endsWith('/verbs/label/verb.json') }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/verbs/label/verb.json')) return { value: JSON.stringify({ name: 'label', feed: true, parallel: 2, rounds: 10 }) }
    return { value: files[e.path] ?? promptStub(e.path) ?? '' }
  })
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('fs.stat', (_$: unknown, e: { path: string }) => (e.path in files ? { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: 0 } } : { value: { kind: 'missing', size: 0, mtimeMs: 0 } }))
  const runs: string[][] = []
  const inputs: Any[] = []
  const labelOf: Record<string, Any> = { 'chat/room.jsonl#L1': { apology: { value: 'yes', values: ['yes', 'no'], by: 'model', confidence: 0.9, reason: 'says sorry' } }, 'chat/room.jsonl#L3': { apology: { value: 'yes', values: ['yes', 'no'], by: 'model', confidence: 0.8 } }, 'chat/room.jsonl#L5': { apology: { value: 'yes', values: ['yes', 'no'], by: 'model', confidence: 0.6 } } }
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'tail') return ok((files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1))
    if (e.argv.some(a => a.endsWith('prep.mjs'))) return ok({ drawing: JSON.parse(String(e.init?.stdin || '{}')).object?.id === '03-per-agent' ? PER_AGENT : DRAWING, verbs: [], problems: [] })
    if (e.argv.some(a => a.endsWith('verb.mjs'))) {
      const input = JSON.parse(String(e.init?.stdin || '{}'))
      inputs.push(input)
      return ok(verb(input))
    }
    const at = e.argv.indexOf('label')
    if (at >= 0 && e.argv[at + 1] === '--of') return ok(Object.fromEntries(e.argv.slice(at + 2).filter(r => labelOf[r]).map(r => [r, labelOf[r]])))
    if (at >= 0 && e.argv.includes('--check')) {
      const i = e.argv.indexOf('--check')
      const ref = e.argv[i + 1]!
      const was = labelOf[ref]?.apology?.value ?? null
      labelOf[ref] = { apology: { ...labelOf[ref]?.apology, value: e.argv[i + 2], by: 'person', checked: true, was } }
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
  return { files, runs, inputs, submitted, toasts, opened, labelOf }
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

const need = (key: string, units = 50) => ({ kind: 'complete', key, request: { model: 'sonnet', prompt: `batch ${key}`, units, telemetry: { feature: 'labels' } } })
const answered: Any = { isAnswered: true, text: '[]', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }

test('calls a verb starts together are made side by side, at most `parallel` at once; a busy one is tried again; the verb runs once more with every answer', async ($, on) => {
  const w = world(on, (input: Any) => (input.answers?.k1 && input.answers?.k2 && input.answers?.k3
    ? { verb: 'label', text: `read ${Object.keys(input.answers).length} batches` }
    : { verb: 'label', need: need('k1'), needs: [need('k1'), need('k2'), need('k3', 20)], limits: { parallel: 2, rounds: 10 } }))
  const clock = mock.clock(on)
  let running = 0
  let most = 0
  const asked: Any[] = []
  let busy = 1
  on('model.complete', async (_$: unknown, e: Any) => {
    asked.push(e)
    running++
    most = Math.max(most, running)
    await new Promise(r => setTimeout(r, 5))
    running--
    if (e.prompt === 'batch k2' && busy-- > 0) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' } } as never
    return { value: answered } as never
  })
  const r = $.command.run({ command: 'verb', args: 'label 02-label-apology apology' } as never)
  for (let i = 0; i < 20; i++) { await clock.advance(1000); await new Promise(res => setTimeout(res, 10)) }
  const out = await r
  // three calls and one try again; never more than two at once; the units the verb noted for its progress never sent
  expect(asked.map(x => x.prompt).sort()).toEqual(['batch k1', 'batch k2', 'batch k2', 'batch k3'])
  expect(most).toBe(2)
  expect(asked.every(x => x.units === undefined && x.telemetry === undefined)).toBe(true)
  expect(w.inputs.length).toBe(2)
  expect(w.inputs[1].round).toBe(1)
  expect(String(out.text)).toContain('read 3 batches')
})

test("a --prompt label asks for the label verb in the change feed: it runs beside the session on the label's card, its progress under the card, then the new card in the old one's place; Claude hears what it did with the next prompt", async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => { release = r })
  const w = world(on, (input: Any) => (input.answers?.k1
    ? (w.files[CARD] = JSON.stringify(OBJECT(2)), { verb: 'label', saved: { id: '02-label-apology', v: 2 }, text: 'apology: 3 of 6 records have a value (3 yes).', note: 'The model finished reading the records of the label apology.' })
    : { verb: 'label', need: need('k1', 6), limits: { parallel: 4, rounds: 60 } }))
  const clock = mock.clock(on)
  on('model.complete', async () => { await gate; return { value: answered } as never })
  // Claude's `thimble label apology --prompt …`: the kernel saved the card and asked for the verb
  on('tool.call', () => {
    const t = Date.now() / 1000
    w.files[EVENTS] = (w.files[EVENTS] || '') + JSON.stringify({ t, kind: 'save', session: SESSION, root: ROOT, object: '02-label-apology', version: 1 }) + '\n'
      + JSON.stringify({ t, kind: 'verb', verb: 'label', session: SESSION, root: ROOT, object: '02-label-apology', version: 1, args: 'apology' }) + '\n'
    return { result: 'label apology v1 · prompt\n' }
  })
  await $.turn.start({ turnId: 't1', text: 'which are apologies?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'thimble label apology --in "chat/*.jsonl" --prompt "The message apologizes."' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'I labeled the messages.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'I labeled the messages.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  // the verb ran on the card with the label's name, and waits on its call: the row under the card says how far it is
  expect(w.inputs[0].object.id).toBe('02-label-apology')
  expect(w.inputs[0].args).toBe('apology')
  await reply($)
  await clock.settle()
  expect(textOf(await reply($))).toContain('label… 0 of 6 records')
  release()
  for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); await clock.settle() }
  // done: the new version is drawn in the old one's place, and Claude reads what the verb said with the next prompt
  const shown = JSON.parse(w.files['/home/t/.thimble/lean/shown/s-1.json']!).under[ROW.slice(0, 24)]
  expect(shown.map((x: Any) => `${x.id}@${x.v}`)).toEqual(['02-label-apology@2'])
  expect(textOf(await reply($))).not.toContain('label…')
  await $.prompt.submit({ text: 'and?' } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('The label verb ran on 02-label-apology, as `thimble label` asked. The model finished reading the records of the label apology.')
  expect(w.toasts).toEqual([])
})

test('a verb asked for while the command still runs starts then: a chained `--wait` waits on calls already being made, and the card is drawn at the version the verb saved', async ($, on) => {
  const w = world(on, (input: Any) => (input.answers?.k1
    ? (w.files[CARD] = JSON.stringify(OBJECT(2)), { verb: 'label', saved: { id: '02-label-apology', v: 2 }, text: 'apology: 6 of 6 records have a value.' })
    : { verb: 'label', need: need('k1', 6) }))
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: answered }) as never)
  let during = false
  on('tool.call', async () => {
    const t = Date.now() / 1000 + 5
    w.files[EVENTS] = JSON.stringify({ t, kind: 'save', session: SESSION, root: ROOT, object: '02-label-apology', version: 1 }) + '\n'
      + JSON.stringify({ t, kind: 'verb', verb: 'label', session: SESSION, root: ROOT, object: '02-label-apology', version: 1, args: 'apology' }) + '\n'
    for (let i = 0; i < 100 && w.inputs.length < 2; i++) await new Promise(r => setTimeout(r, 10))
    during = w.inputs.length === 2
    return { result: 'apology: 6 of 6 records have a value' }
  })
  await $.turn.start({ turnId: 't1', text: 'which are apologies?' } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'thimble label apology --in chat.jsonl --prompt "x" && thimble label apology --wait' } as never)
  for (let i = 0; i < 20 && !during; i++) { await clock.advance(1000); await new Promise(r => setTimeout(r, 20)) }
  await call
  await clock.settle()
  // the verb ran, and its calls were made, before the command ended; reading the feed after it starts it no second time
  expect(during).toBe(true)
  expect(w.inputs.length).toBe(2)
  // the save the command made (v1) is read after it; the card is drawn at v2, which the verb saved meanwhile
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'I labeled the messages.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'I labeled the messages.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  expect(JSON.parse(w.files['/home/t/.thimble/lean/shown/s-1.json']!).under[ROW.slice(0, 24)].map((x: Any) => `${x.id}@${x.v}`)).toEqual(['02-label-apology@2'])
})

test('a call that fails says so plainly: a toast with what failed, and the verb keeps what the other calls gave', async ($, on) => {
  const w = world(on, (input: Any) => (input.answers?.k1
    ? { verb: 'label', saved: { id: '02-label-apology', v: 2 }, failed: true, text: 'apology: 3 of 6 records have a value (3 yes). 3 have no value (1 call failed: api-error 400): `thimble label apology --again` asks the model again.' }
    : { verb: 'label', need: need('k1', 3), needs: [need('k1', 3), need('k2', 3)] }))
  const clock = mock.clock(on)
  on('model.complete', (_$: unknown, e: Any) => ({ value: e.prompt === 'batch k2' ? { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request_error' } : answered }) as never)
  w.files[EVENTS] = JSON.stringify({ t: Date.now() / 1000 + 5, kind: 'verb', verb: 'label', session: SESSION, root: ROOT, object: '02-label-apology', version: 1, args: 'apology' }) + '\n'
  on('tool.call', () => ({ result: '' }))
  await $.tool.call({ tool: 'Bash', command: 'thimble label apology --again' } as never)
  for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); await clock.settle() }
  expect(w.inputs.length).toBe(2)
  // the failed call is an answer like any other, for the verb to say what it means
  expect(w.inputs[1].answers.k2).toMatchObject({ isAnswered: false, status: 400 })
  expect(w.toasts.join('\n')).toContain('1 call failed: api-error 400')
  expect(w.toasts.join('\n')).toContain('--again')
})

test("the detail of a label's card: each example shows its labels; a number key checks the record shown, which steps on; when the detail closes the card is counted again and Claude hears of the checks", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'obj', args: '02-label-apology value-0' } as never)
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
  // the pane is gone (a close the module did not hear): the next prompt to main carries the checks
  w.opened.length = 0
  await $.prompt.submit({ text: 'so?', origin: { kind: 'composer' } } as never)
  expect(w.runs.some(r => r.slice(-3).join(' ') === 'label apology --json')).toBe(true)
  const note = w.submitted.at(-1)!.context.join('\n')
  expect(note).toContain('The person checked 2 records of the label apology: they agree with 1 and changed 1: chat/room.jsonl#L3 (the label said yes, the person says no)')
  expect(note).toContain('its counts are now query q9')
})

test('a label shows on what is drawn: the details of any card\'s part say how its rows split by each label that holds them', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'obj', args: '03-per-agent agent-29' } as never)
  await pane($, clock)
  expect(await press($, clock, edit('enter'))).toEqual({ text: '', cursor: 0 })
  const t = await pane($, clock)
  expect(t).toContain('16 rows')
  expect(t).toContain('label apology: 3 yes · 13 no')
})
