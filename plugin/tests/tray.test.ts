// The cite and explain tray (tray/): ] at an empty prompt opens it on the acting answer's first citation, which draws in
// focus; its card shows the check and the evidence, its keys show in the bar; a press on a citation opens it too; a
// question typed with it open carries the citation's scope to Claude, shows `▸ about …` under the prompt, and closes
// the tray; 0 closes it. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { citeTint } from '../marks/view'
import { evidenceOpener } from '../tray/tray'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : '') + textOf(n.children)
}
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  all(n.children, out)
  return out
}

const TEXT = 'Of the runs, [12 of 40](#) failed on the p95 check.'
const view = { columns: 100, rows: 40, isFullscreen: true }
const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: view, props: { text, isFirstOfReply: true } }) as never
const above = (maxRows = 20) => ({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} }, viewport: view }) as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never

/** A resumed session with one answer, TEXT (or `more.text`), whose citation the check left as `item` (or whose
 *  citations, a list of items); `more`: the turn's cards, the message's parts and kept files to add (a card's meta.json
 *  under cards/<id>/). */
async function resumed($: Any, on: Any, item: Any, session = 's-tray', more: { cards?: Any[]; parts?: Any; kept?: Record<string, string>; text?: string; env?: Record<string, string> } = {}): Promise<{ submitted: Any[]; clock: Any; spawns: Any[] }> {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', ...(more.env ?? {}) })
  const clock = mock.clock(on, { now: 0 })
  const submitted: Any[] = []
  const spawns: Any[] = []
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const kept: Record<string, string> = {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: Array.isArray(item) ? item : [item] }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: more.cards ?? [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: more.text ?? TEXT, at: 1, ...(more.parts ? { parts: more.parts } : {}) }] }),
    ...(more.kept ?? {}),
  }
  const keptOf = (path: string) => Object.keys(kept).find(k => path.endsWith(`/${k}`))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: keptOf(e.path) ? kept[keptOf(e.path)!] : promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: [...new Set(Object.keys(kept).filter(k => String(e.path).endsWith(`/${k.split('/')[0]}`)).map(k => k.split('/').slice(0, 3).join('/')))].map(k => ({ name: k.split('/')[1], kind: k.split('/').length > 2 ? 'dir' : 'file' })) }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('config.list', () => ({ value: [] }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-made-up', agentId: `agent-repair-${spawns.length}` } as never })
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => { submitted.push(e); return { text: e.text } })
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  return { submitted, clock, spawns }
}


// the check verified the citation, with a quote of the file it read: the reply's marks as a resumed session finds them
const QUOTED = {
  n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40', reason: 'Line 4 says 12 failed. It counts every run.',
  evidence: { kind: 'quote', file: 'runs/summary.txt', line: '4', lines: [{ n: 3, text: 'runs: 40' }, { n: 4, text: 'failed: 12', highlight: [8, 10] }, { n: 5, text: 'passed: 28' }] },
}

test('] opens the tray on a citation with its evidence; a question asked with it open is about it; 0 closes it', async ($, on) => {
  const { submitted, clock } = await resumed($, on, QUOTED)
  // a resumed session: the answer and its checked citation are read back
  // ]: the tray above the bar, on the citation, its keys in the bar
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('12 of 40')
  // the header's right: the status beside the kind; verified says no reason; then the file's place, dim, and the one
  // line that holds the value, after a rule
  expect(band).toContain('✓ verified · cite')
  expect(band).not.toContain('Line 4 says')
  expect(band).toContain('runs/summary.txt:4│failed: 12')
  expect(band).not.toContain('4 │')
  expect(band).not.toContain('runs: 40')
  expect(band).not.toContain('passed: 28')
  // the value bold in the citations' look, the place dim
  const drawnBand = all(await $.ui.render(above()))
  expect(drawnBand.some(n => n.type === 'Text' && n.props?.backgroundColor === undefined && (n.hover ?? n.props?.hover)?.backgroundColor === citeTint() && n.props?.underline === true && n.props?.bold === true && textOf(n) === '12')).toBe(true)
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'runs/summary.txt:4')?.props).toMatchObject({ dimColor: true })
  expect(band).toContain('a ask')
  expect(band).toContain('0 close')
  expect(band).not.toContain('v card')
  // the citation draws in focus in the answer
  const drawn = await $.ui.render(answer('row-t1', TEXT))
  const cite = all(drawn).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  expect(all(cite).some(n => n.type === 'Text' && n.props?.backgroundColor === citeTint() && n.props?.bold === true && textOf(n) === '12 of 40')).toBe(true)

  // a question typed with the tray open: its scope goes with it, the tray closes, and the prompt shows what it was about
  await $.prompt.submit({ text: 'why so many?', origin: { kind: 'composer' } } as never)
  const told = (submitted.at(-1).context ?? []).join('\n')
  expect(told).toContain('citation of your reply open in the tray: "12 of 40"')
  expect(told).toContain('Its evidence is runs/summary.txt:4.')
  expect(told).toContain('They opened the citation "12 of 40"')
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
  await $.turn.start({ text: 'why so many?', turnId: 't2' } as never)
  await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'why so many?' }] }, door: 'prompt', origin: { kind: 'composer' }, uuid: 'row-q2' } as never)
  const asked = textOf(await $.ui.render({ plugin: 'thimble', component: 'UserMessage', surface: 'terminal', requestId: 'row-q2', viewport: view, props: { text: 'why so many?', origin: { kind: 'composer' } } } as never))
  expect(asked).toContain('▸ about the citation "12 of 40"')
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: '', durationMs: 10, isAborted: false } as never)
  await clock.advance(100)

  // a press on the citation opens the tray on it; 0 closes it
  const ui = await $.ui.mount(answer('row-t1', TEXT))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  expect(textOf(await $.ui.render(above()))).toContain('failed: 12')
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('failed: 12')
  expect(band).not.toContain('a ask')
})

test('a corrected value computed by code: purple in the reply; the line that printed it, then its output; c shows all the code and output; c again goes back', async ($, on) => {
  const { clock } = await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'corrected', shown: '11 of 40', was: '12 of 40', reason: 'The output says 11. One run was retried.',
    evidence: { kind: 'computed', by: 'checker', code: 'import json\nprint("runs:", n)\nprint(f"failed: {bad}")\nprint("passed:", n - bad)', output: 'runs: 40\nfailed: 11\npassed: 29', highlight: [[17, 19]] },
  }, 's-tray-2')
  // the corrected words draw as a settled citation: underlined, the purple tint on hover
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  const corrected = drawn.find(n => n.type === 'Text' && textOf(n) === '11 of 40')
  expect(corrected?.props).toMatchObject({ underline: true })
  expect(corrected?.props?.backgroundColor).toBeUndefined()
  expect(corrected?.hover ?? corrected?.props?.hover).toMatchObject({ backgroundColor: citeTint() })
  expect(textOf(drawn)).not.toContain('corrected')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let drawnBand = all(await $.ui.render(above()))
  let band = textOf(drawnBand)
  // the header's status, what it was under it (no reason), the code line that printed the value, its output line
  expect(band).toContain('✓ verified · cite')
  expect(band).toContain('corrected; was 12 of 40')
  expect(band).not.toContain('The output says 11')
  expect(band).toContain('print(f"failed: {bad}")│failed: 11')
  // the two output lines the one line leaves out, counted at the end of the ruled block, dim
  expect(band).toContain('│failed: 11│+ 2 more lines')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === '+ 2 more lines')?.props?.dimColor).toBe(true)
  expect(band).not.toContain('runs: 40')
  expect(band).not.toContain('print("runs:", n)')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'print(f"failed: {bad}")')?.props?.color).toBe('permission')
  expect(drawnBand.some(n => n.type === 'Code')).toBe(false)
  expect(band).toContain('c all code and output')
  // (keys apart, so they are not a word typed)
  await clock.advance(2000)
  // c: all the code (as code), then all the output after the rule, its value still in the tint; no headings
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  const open = await $.ui.render(above())
  const code = all(open).find(n => n.type === 'Code')
  expect(code?.props?.source).toBe('import json\nprint("runs:", n)\nprint(f"failed: {bad}")\nprint("passed:", n - bad)')
  band = textOf(open)
  expect(band).toContain('│runs: 40│failed: 11│passed: 29')
  expect(band).not.toContain('more line')
  expect(band).toContain('c one line')
  expect(band).not.toContain('Output of the code')
  expect(band).not.toContain('The code')
  expect(all(open).some(n => n.type === 'Text' && n.props?.backgroundColor === undefined && (n.hover ?? n.props?.hover)?.backgroundColor === citeTint() && n.props?.underline === true && n.props?.bold === true && textOf(n) === '11')).toBe(true)
  // c again: back to the one line
  await clock.advance(2000)
  await $.prompt.edit(key('c'))
  band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('runs: 40')
  expect(band).toContain('failed: 11')
})

test('a citation the check found false: × failed in the header, as any failed one, why in one dim sentence under it, x repair, then its evidence; x starts a check of it again in the background, no turn of main', async ($, on) => {
  const { submitted, clock, spawns } = await resumed($, on, { ...QUOTED, status: 'failed', failedBy: 'check', reason: 'Line 4 counts 12 failed, but 3 were retried. The rest passed.' }, 's-tray-5')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const drawn = all(await $.ui.render(above()))
  const band = textOf(drawn)
  expect(band).toContain('× failed · cite')
  expect(band).not.toContain('wrong')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === '× failed')?.props?.color).toBe('error')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === 'Line 4 counts 12 failed, but 3 were retried.')?.props).toMatchObject({ dimColor: true })
  expect(band).not.toContain('The rest passed')
  expect(band).toContain('failed: 12')
  // the citation stays underlined in the reply, red, with × after it
  const reply = all(await $.ui.render(answer('row-t1', TEXT)))
  expect(reply.find(n => n.type === 'Text' && textOf(n) === '12 of 40' && n.props?.color)?.props).toMatchObject({ color: 'error', underline: true })
  expect(reply.find(n => n.type === 'Text' && textOf(n) === ' ×')?.props?.color).toBe('error')
  // x repair: in the bar and in the card
  expect(band).toContain('x repair')
  expect(drawn.some(n => n.type === 'Button' && n.props?.label === 'repair this citation')).toBe(true)
  // x: a checker fork for this one citation, once the word window has passed; no turn of main
  await clock.advance(2000)
  expect(await $.prompt.edit(key('x'))).toEqual({ text: '', cursor: 0 })
  expect(spawns.length).toBe(0)
  await clock.advance(1000)
  expect(spawns.length).toBe(1)
  expect(spawns[0].description).toBe('checking a citation again (x)')
  expect(spawns[0].prompt).toContain('PROMPT checker')
  expect(spawns[0].prompt).toContain('The analyst pressed x to repair citation 1.')
  expect(spawns[0].prompt).toContain('The first check found it wrong: "Line 4 counts 12 failed, but 3 were retried. The rest passed."')
  expect(submitted.length).toBe(0)
  // (the test kit names no agent it starts, so the fork's run and end are marks.test.ts's)
})

const WRONG = { ...QUOTED, status: 'failed', failedBy: 'check', reason: 'Line 4 counts 12 failed.' }

// a reply with two citations, each in its own words
const TWO = 'Of the runs, [12 of 40](#) failed on the [p95 check](#).'
const SECOND = { n: 2, row: 'row-t1', words: 'p95 check', start: 41, end: 55, sentence: TWO, shown: 'p95 check' }

test('a repair that corrected the citation says repaired and what it was; one that still could not confirm it says not repaired and why, and offers x again', async ($, on) => {
  await resumed($, on, [
    { ...WRONG, sentence: TWO, status: 'corrected', repair: true, shown: '9 of 40', was: '12 of 40' },
    { ...SECOND, status: 'failed', failedBy: 'evidence', repair: true, reason: 'No file holds a count of failed runs.' },
  ], 's-tray-10', { text: TWO })
  await $.prompt.edit(key(']'))
  const card = textOf(await $.ui.render(above()))
  expect(card).toContain('repaired; was 12 of 40')
  expect(card).not.toContain('x repair')
  await $.prompt.edit(key(']'))
  const again = textOf(await $.ui.render(above()))
  expect(again).toContain('not repaired: No file holds a count of failed runs.')
  expect(again).toContain('x repair')
})



test('a citation whose check did not run is failed: × in the reply, × failed in the card with the plain reason, and x starts its check; so is a check the session ended mid-way', async ($, on) => {
  // an earlier thimble kept the first as unchecked, with no evidence, and the second as checking when its session
  // ended: the resumed session finds both failed
  const { evidence: _e, ...words } = QUOTED
  const { clock, spawns, submitted } = await resumed($, on, [
    { ...words, sentence: TWO, status: 'unchecked', reason: 'the reply was interrupted before its citations were checked' },
    { ...SECOND, status: 'checking' },
  ], 's-tray-12', { text: TWO })
  const reply = all(await $.ui.render(answer('row-t1', TWO)))
  expect(reply.find(n => n.type === 'Text' && textOf(n) === '12 of 40' && n.props?.color)?.props).toMatchObject({ color: 'error', underline: true })
  expect(reply.find(n => n.type === 'Text' && textOf(n) === ' ×')?.props?.color).toBe('error')
  await $.prompt.edit(key(']'))
  const drawn = all(await $.ui.render(above()))
  const band = textOf(drawn)
  expect(band).toContain('× failed · cite')
  expect(band).not.toContain('not checked')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === 'The check did not run.')?.props).toMatchObject({ dimColor: true })
  expect(band).not.toContain('gave no evidence')
  expect(band).toContain('x repair: start its check')
  expect(drawn.some(n => n.type === 'Button' && n.props?.label === 'check this citation')).toBe(true)
  // the one the session ended mid-way: failed, and x offered
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  const ended = textOf(await $.ui.render(above()))
  expect(ended).toContain('p95 check')
  expect(ended).toContain('× failed · cite')
  expect(ended).toContain('The check did not run.')
  expect(ended).not.toContain('session ended')
  expect(ended).toContain('x repair')
  // x on the first starts its check
  await clock.advance(2000)
  await $.prompt.edit(key('['))
  await clock.advance(2000)
  await $.prompt.edit(key('x'))
  await clock.advance(1000)
  expect(spawns.length).toBe(1)
  expect(spawns[0].prompt).toContain('The analyst pressed x to check citation 1, whose first check did not run.')
  expect(spawns[0].prompt).not.toContain('right value')
  expect(submitted.length).toBe(0)
  // (the test kit names no agent it starts, so the check's run and end are marks.test.ts's)
})


// A click on the file's place in the tray opens the citation's evidence in the side pane, by a button or, where the
// terminal draws hyperlinks, by the link
for (const [how, env] of [['a button', {}], ['a file link', { FORCE_HYPERLINK: '1' }]] as const) {
  test(`a click on the file's place in the tray (${how}) opens the citation's evidence in the side pane`, async ($, on) => {
    const opens: Any[] = []
    on('ui.open', (_$: unknown, e: Any) => { opens.push(e.id); return { value: { isPlaced: true } } as never })
    on('ui.close', () => ({ value: undefined }))
    await resumed($, on, QUOTED, `s-tray-pane-${how}`, { env })
    expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
    const ui = await $.ui.mount(above())
    const place = all(await ui.drawn()).find(n => n.props?.key === 'tray-file')
    expect(place?.type).toBe(how === 'a button' ? 'Button' : 'Markdown')
    await ui.press(place.type === 'Markdown' ? { key: 'tray-file', link: { href: place.props.pressableLinks[0] } } : { key: 'tray-file' })
    await ui.unmount()
    expect(opens).toEqual(['thimble'])
    expect(textOf(await $.ui.render(above()))).not.toContain('did not open the side pane')
  })
}
// Claude Code places a pane at any width only for an open made while the person's press runs; an open the handler
// leaves to run after it returns is unasked and waits undrawn below 144 columns (the tray's file place showed "did not
// open the side pane" at 118 columns). The test kit's press waits for such work too, so the handler is called here as
// Claude Code calls it: the open must be made by the time what it returns settles.
test("the tray's file place makes its pane open inside the press, before its handler settles", async () => {
  const opens: string[] = []
  const notices: string[] = []
  const later = <T>(v: T) => new Promise<T>(r => setTimeout(() => r(v), 1))
  const state = new Map<string, unknown>()
  const $: Any = {
    state: { get: (k: Any) => later({ value: state.get(k.key) ?? null }), set: (k: Any, v: unknown) => later(void state.set(k.key, v)) },
    ui: { open: (p: Any) => later((opens.push(p.id), { isPlaced: true })), panes: () => later([]), close: () => later(undefined), toast: (t: string) => later(void notices.push(t)) },
  }
  const pressed = evidenceOpener($, { row: 'row-t1', n: 1 })()
  expect(pressed).toBeInstanceOf(Promise)
  await pressed
  expect(opens).toEqual(['thimble'])
  expect(state.get('pane')).toMatchObject({ kind: 'evidence', args: { row: 'row-t1', n: 1 } })
})

// A press on the file's place opens the pane at any width; where Claude Code still places none (no surface here draws
// panes), the notice says so and sends the person to what shows the evidence: not to the reply's citation, whose press
// opens the tray they already have
test("the tray's file place where no pane can open: the notice does not send the person to the reply's citation", async () => {
  const state = new Map<string, unknown>()
  const $: Any = {
    state: { get: async (k: Any) => ({ value: state.get(k.key) ?? null }), set: async (k: Any, v: unknown) => void state.set(k.key, v) },
    ui: { open: async () => ({ isPlaced: false, reason: 'no attached surface places panes' }), panes: async () => [], close: async () => undefined },
  }
  await evidenceOpener($, { row: 'row-t1', n: 1 })()
  await new Promise(r => setTimeout(r, 1))
  const line = state.get('failLine') as Any
  expect(line?.kind).toBe('notice')
  expect(String(line?.text)).toContain('did not open the side pane')
  expect(String(line?.text)).not.toContain('citation in the reply')
})

// Claude Code places a pane at any width only for the person's press or command, never for a key at the prompt (its
// prompt.edit is no person's input): below 144 columns a at the prompt cannot open the thread, so the bar names what
// opens it there, a click on `a ask` in the bar; that press opens it at any width
test('a on a card at a narrow terminal: the bar names the click on a ask, and that press opens the thread', async ($, on) => {
  const id = 'c0123456789ac'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_1', turn: 't1', agentId: null, anchorRow: null, keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_1: { version: 1 } }, at: 1 }
  const opens: Any[] = []
  let wide = false
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.id); return { value: wide ? { isPlaced: true } : { isPlaced: false, reason: 'unasked below 144 columns (118 now)' } } as never })
  on('ui.close', () => ({ value: undefined }))
  const { clock } = await resumed($, on, QUOTED, 's-tray-narrow', {
    cards: [{ id, toolUseId: 'toolu_made_up_1', seq: 1, after: 0 }],
    kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) },
  })
  // each key after the one before's word window
  for (const k of [']', '[', 'a']) {
    expect(await $.prompt.edit(key(k))).toEqual({ text: '', cursor: 0 })
    await clock.advance(1000)
  }
  expect(opens).toEqual(['thimble'])
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('wider terminal')
  expect(band).toContain('“a ask”')
  // the press on a ask in the bar: Claude Code places it
  wide = true
  const ui = await $.ui.mount(above())
  await ui.press({ key: 'bar-tray-a' })
  await ui.unmount()
  expect(opens).toEqual(['thimble', 'thimble'])
  // open now: the notice goes
  expect(textOf(await $.ui.render(above()))).not.toContain('wider terminal')
})

// a heads-up on the citation's words, with long bullets, and an explainer after it
const HEADS = {
  explain: {
    order: ['h1', 'g1'],
    items: {
      h1: { id: 'h1', kind: 'heads', term: '12 of 40', title: 'Retried runs count twice', bullets: [
        'Four of the runs were retried after a timeout, and the summary file counts each try as its own run, so the share of failures reads higher than the share of distinct runs.',
        'The check read the summary file only, so it cannot say which of the tries failed or whether a retry passed later on in the same sweep of runs.',
        'The runs that were not retried all finished inside their budget, so the timeout explains the retries but not the failures among the other runs.',
      ], todo: 'Count distinct run ids before you quote the share.' },
      g1: { id: 'g1', term: 'p95', body: 'The time that 95 of 100 checks stay under.' },
    },
  },
}

test('a heads-up on a citation\'s words is one ] away; a tray taller than the room keeps the bar on screen, and m shows the rest', async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-4', { parts: HEADS })
  // ]: the heads-up first, not the citation under it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let drawn = await $.ui.render(above(12))
  let band = textOf(drawn)
  expect(band).toContain('heads up')
  expect(band).toContain('Retried runs count twice')
  expect(band).toContain('] next citation')
  // the band's room is 12 rows: the tray fits in what the bar and the blank rows leave, and says there is more
  const page = all(drawn).find(n => n.props?.key === 'tray-page')
  expect(page?.props).toMatchObject({ overflow: 'hidden' })
  const barRows = all(drawn).filter(n => n.props?.key === 'bar').length
  expect(page.props.height + 3 + 1 + 2 + barRows).toBeLessThanOrEqual(12)
  expect(band).toContain('m more · lines 1–')
  expect(band).not.toContain('Count distinct run ids')
  // the fewest rows that show it whole hold all of it and the bar: its 10 lines at this width, the blank row over
  // them, the frame's three rows and the two blank rows
  let whole = 12
  while (textOf(await $.ui.render(above(whole))).includes('m more')) whole++
  expect(3 + 1 + 10 + 2 + barRows).toBeLessThanOrEqual(whole)
  await $.ui.render(above(12))
  // m: the next lines, then from the top
  await clock.advance(2000)
  expect(await $.prompt.edit(key('m'))).toEqual({ text: '', cursor: 0 })
  band = textOf(await $.ui.render(above(12)))
  expect(band).not.toContain('m more · lines 1–')
  // a tall screen shows it whole
  band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('Count distinct run ids')
  expect(band).not.toContain('m more')
  // ] goes on to the citation, then the explainer after it
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('failed: 12')
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('The time that 95 of 100 checks stay under.')
})

test('an explainer paragraph taller than the room shows a room of its rows at a time: m goes on inside it, then from the top', async ($, on) => {
  const long = `${Array.from({ length: 60 }, (_, i) => `word${i} of a long explainer`).join(' ')}.`
  const { clock } = await resumed($, on, QUOTED, 's-tray-15', { parts: { explain: { order: ['g1'], items: { g1: { id: 'g1', term: 'p95', body: long } } } } })
  // ] to the citation, ] to the explainer
  await $.prompt.edit(key(']'))
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  const pageNow = async () => {
    const drawn = await $.ui.render(above(12))
    return { body: all(drawn).find(n => n.props?.key === 'tray-page-body'), more: /m (more|from the top) · lines/.exec(textOf(drawn))?.[0] ?? '' }
  }
  let p = await pageNow()
  expect(p.more).toContain('m more')
  expect(p.body.props.marginTop ?? 0).toBe(0)
  // each m moves the paragraph up by the rows already shown, until the page says m from the top
  const tops: number[] = []
  for (let i = 0; i < 20 && !p.more.startsWith('m from the top'); i++) {
    await clock.advance(2000)
    await $.prompt.edit(key('m'))
    p = await pageNow()
    tops.push(p.body.props.marginTop ?? 0)
  }
  expect(p.more).toContain('m from the top')
  expect(tops.length).toBeGreaterThan(1)
  for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeLessThan(tops[i - 1])
  // and m from the top starts it again
  await clock.advance(2000)
  await $.prompt.edit(key('m'))
  expect((await pageNow()).body.props.marginTop ?? 0).toBe(0)
})
