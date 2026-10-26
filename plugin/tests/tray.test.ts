// The cite and explain tray (tray/): ] at an empty prompt opens it on the acting answer's first citation, which draws in
// focus; its card shows the check and the evidence, its keys show in the bar; a press on a citation opens it too; a
// question typed with it open carries nothing of it and closes the tray; 0 closes it. All data is made up. `claude plugin test plugin`.
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

test('] opens the tray on a citation with its evidence; a question asked with it open carries nothing of it; 0 closes it', async ($, on) => {
  const { submitted, clock } = await resumed($, on, QUOTED)
  // a resumed session: the answer and its checked citation are read back
  // ]: the tray above the bar, on the citation, its keys in its header
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('12 of 40')
  // the header's right: the status, then its keys as the bar draws keys (no kind word); verified says no reason; then
  // the file's place, dim, and the one line that holds the value, after a rule
  expect(band).toContain('✓ verified  a ask · 0 close')
  expect(band).not.toContain('· citation')
  expect(band).not.toContain('Line 4 says')
  expect(band).toContain('runs/summary.txt:4│failed: 12')
  expect(band).not.toContain('4 │')
  expect(band).not.toContain('runs: 40')
  expect(band).not.toContain('passed: 28')
  // the value bold in the citations' look, the place dim
  const drawnBand = all(await $.ui.render(above()))
  expect(drawnBand.some(n => n.type === 'Text' && n.props?.backgroundColor === undefined && (n.hover ?? n.props?.hover)?.backgroundColor === citeTint() && n.props?.underline === true && n.props?.bold === true && textOf(n) === '12')).toBe(true)
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'runs/summary.txt:4')?.props).toMatchObject({ dimColor: true })
  // each key once: the bar under it keeps its own keys and names none of the tray's
  expect(band.match(/a ask/g)).toEqual(['a ask'])
  expect(band.match(/0 close/g)).toEqual(['0 close'])
  expect(band).toContain('s rewrite')
  // the citation draws in focus in the answer
  const drawn = await $.ui.render(answer('row-t1', TEXT))
  const cite = all(drawn).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  expect(all(cite).some(n => n.type === 'Text' && n.props?.backgroundColor === citeTint() && n.props?.bold === true && textOf(n) === '12 of 40')).toBe(true)

  // a question typed with the tray open is not about the citation: no scope goes with it (only that the person opened
  // it, core/engaged.ts), the tray closes, and the prompt shows nothing under it
  await $.prompt.submit({ text: 'why so many?', origin: { kind: 'composer' } } as never)
  const told = (submitted.at(-1).context ?? []).join('\n')
  expect(told).not.toContain('open in the tray')
  expect(told).toContain('They opened the citation "12 of 40"')
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
  await $.turn.start({ text: 'why so many?', turnId: 't2' } as never)
  await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'why so many?' }] }, door: 'prompt', origin: { kind: 'composer' }, uuid: 'row-q2' } as never)
  const asked = textOf(await $.ui.render({ plugin: 'thimble', component: 'UserMessage', surface: 'terminal', requestId: 'row-q2', viewport: view, props: { text: 'why so many?', origin: { kind: 'composer' } } } as never))
  expect(asked).not.toContain('▸ about')
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

test('a corrected value computed by code: purple in the reply; the line that printed it, then its output; + shows all the code and output; - goes back', async ($, on) => {
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
  expect(band).toContain('✓ verified')
  expect(band).toContain('corrected; was 12 of 40')
  expect(band).not.toContain('The output says 11')
  expect(band).toContain('print(f"failed: {bad}")│failed: 11')
  // + expand all at the end of the ruled block, dim
  expect(band).toContain('│failed: 11│+ expand all')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === '+ expand all')?.props?.dimColor).toBe(true)
  expect(band).not.toContain('runs: 40')
  expect(band).not.toContain('print("runs:", n)')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'print(f"failed: {bad}")')?.props?.color).toBe('permission')
  expect(drawnBand.some(n => n.type === 'Code')).toBe(false)
  expect(band).toContain('+ expand all')
  // (keys apart, so they are not a word typed)
  await clock.advance(2000)
  // +: all the code (as code), then all the output after the rule, its value still in the tint; no headings
  expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
  const open = await $.ui.render(above())
  const code = all(open).find(n => n.type === 'Code')
  expect(code?.props?.source).toBe('import json\nprint("runs:", n)\nprint(f"failed: {bad}")\nprint("passed:", n - bad)')
  band = textOf(open)
  expect(band).toContain('│runs: 40│failed: 11│passed: 29')
  expect(band).not.toContain('expand all')
  expect(band).toContain('− collapse')
  expect(band).not.toContain('Output of the code')
  expect(band).not.toContain('The code')
  expect(all(open).some(n => n.type === 'Text' && n.props?.backgroundColor === undefined && (n.hover ?? n.props?.hover)?.backgroundColor === citeTint() && n.props?.underline === true && n.props?.bold === true && textOf(n) === '11')).toBe(true)
  // -: back to the one line
  await clock.advance(2000)
  expect(await $.prompt.edit(key('-'))).toEqual({ text: '', cursor: 0 })
  band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('runs: 40')
  expect(band).toContain('failed: 11')
})

test('each key of the tray is a click too: + expand all and − collapse as + and -, a click on the citation in the reply or in the tray\'s title closes it, and 0 close in its header closes it', async ($, on) => {
  await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40',
    evidence: { kind: 'computed', by: 'checker', code: 'print("runs:", n)\nprint(f"failed: {bad}")', output: 'runs: 40\nfailed: 12\npassed: 28', highlight: [[17, 19]] },
  }, 's-tray-clicks')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('✓ verified')
  expect(band).toContain('+ expand all')
  expect(band).not.toContain('next prompt')
  // + expand all: all the output, as +; − collapse: back
  let tray = await $.ui.mount(above())
  await tray.press({ key: 'more-press' })
  await tray.unmount()
  band = textOf(await $.ui.render(above()))
  expect(band).toContain('│runs: 40│failed: 12│passed: 28')
  expect(band).toContain('− collapse')
  tray = await $.ui.mount(above())
  await tray.press({ key: 'more-press' })
  await tray.unmount()
  band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('runs: 40')
  expect(band).toContain('+ expand all')
  // a click on the citation's words in the tray's title closes it, as in the reply
  tray = await $.ui.mount(above())
  await tray.press({ key: 'tray-title' })
  await tray.unmount()
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
  // a click on the citation opens the tray; a second click on it closes it
  const cite = all(await $.ui.render(answer('row-t1', TEXT))).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  let reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  expect(textOf(await $.ui.render(above()))).toContain('failed: 12')
  reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
  // again open; `0 close` in its header closes it, its key bold in thimble's purple as the bar draws a key
  reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  const zero = all(await $.ui.render(above())).find(n => n.type === 'Button' && n.props?.key === 'tray-0')
  expect(textOf(zero)).toBe('0 close')
  const k = all(zero).find(n => n.type === 'Text' && textOf(n) === '0')
  expect(k?.props).toMatchObject({ bold: true })
  expect(typeof k?.props?.color).toBe('string')
  tray = await $.ui.mount(above())
  await tray.press({ key: 'tray-0' })
  await tray.unmount()
  expect(textOf(await $.ui.render(above()))).not.toContain('failed: 12')
})

test('a citation the check found false: × failed in the header, as any failed one, why in one dim sentence under it, x repair, then its evidence; x starts a check of it again in the background, no turn of main', async ($, on) => {
  const { submitted, clock, spawns } = await resumed($, on, { ...QUOTED, status: 'failed', failedBy: 'check', reason: 'Line 4 counts 12 failed, but 3 were retried. The rest passed.' }, 's-tray-5')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const drawn = all(await $.ui.render(above()))
  const band = textOf(drawn)
  expect(band).toContain('× failed  a ask · 0 close')
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
  expect(band).toContain('× failed  ] next citation · a ask · 0 close')
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
  expect(ended).toContain('× failed  [ previous citation · a ask · 0 close')
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
      ] },
      g1: { id: 'g1', term: 'p95', body: 'The time that 95 of 100 checks stay under.', here: 'The sweep [lists it per run](runs/summary.txt#L4), and [the config sets the limit](conf/limits.toml#L2-3).' },
    },
  },
}

test('a heads-up on a citation\'s words is one ] away; it shows whole, with no paging, no order to the reader and no line about the next prompt', async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-4', { parts: HEADS })
  // ]: the heads-up first, not the citation under it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above(12)))
  expect(band).toContain('a ask · 0 close')
  expect(band).toContain('Retried runs count twice')
  expect(band).toContain('but not the failures among the other runs.')
  expect(band).not.toContain('? ask about this heads-up')
  expect(band).toContain('] next citation')
  for (const gone of ['m more', 'lines 1–', 'Your next prompt', 'leave it out', 'Claude can do this', 'o ask']) expect(band).not.toContain(gone)
  expect(all(await $.ui.render(above(12))).some(n => n.props?.key === 'tray-page')).toBe(false)
  // ] goes on to the citation, then the explainer after it
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('failed: 12')
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('The time that 95 of 100 checks stay under.')
})

// a heads-up whose words are a citation's words, or hold them
const headsOn = (term: string) => ({ explain: { order: ['h1'], items: { h1: { id: 'h1', kind: 'heads', term, title: 'Names are typed in', bullets: ['Anyone who edits types a name.'] } } } })
const filledOf = (drawn: Any[]) => drawn.filter(n => n.type === 'Text' && n.props?.backgroundColor).map(textOf)

test("a heads-up on a citation's words stays on them when the check corrects them, never on the same word elsewhere in the reply", async ($, on) => {
  const text = 'The edits came from [3,103 different usernames](#). Each run has a different fake date.'
  await resumed($, on, {
    n: 1, row: 'row-t1', words: '3,103 different usernames', start: 20, end: 50, sentence: 'The edits came from [3,103 different usernames].', status: 'corrected', shown: '3,102 different usernames', was: '3,103 different usernames', reason: 'Line 2 says 3102.',
    evidence: { kind: 'quote', file: 'names.txt', line: '2', lines: [{ n: 2, text: 'names: 3102' }] },
  }, 's-tray-heads-corrected', { text, parts: headsOn('3,103 different usernames') })
  const drawn = all(await $.ui.render(answer('row-t1', text)))
  expect(filledOf(drawn)).toEqual(['3,102 different usernames'])
  // the words keep the citation's underline, and a press on them opens the heads-up first (] goes on to the citation)
  const press = drawn.find(n => n.type === 'Button' && all(n).some((t: Any) => t.type === 'Text' && textOf(t) === '3,102 different usernames'))
  expect(String(press?.props.label)).toMatch(/^heads up/)
  expect(all(press).find(n => n.type === 'Text' && textOf(n) === '3,102 different usernames')?.props).toMatchObject({ underline: true })
  expect(textOf(drawn)).not.toContain('the check of the citations changed')
})

test('a heads-up whose words hold a citation covers them all: its fill under the citation\'s underline, every word a press of the heads-up', async ($, on) => {
  const text = 'Answers were shared by [1,212 accounts](#) in June.'
  await resumed($, on, { ...QUOTED, words: '1,212 accounts', start: 23, end: 42, sentence: 'Answers were shared by [1,212 accounts] in June.', shown: '1,212 accounts' }, 's-tray-heads-over', { text, parts: headsOn('by 1,212 accounts') })
  const drawn = all(await $.ui.render(answer('row-t1', text)))
  expect(filledOf(drawn)).toEqual(['by ', '1,212 accounts'])
  const press = drawn.find(n => n.type === 'Button' && all(n).some((t: Any) => t.type === 'Text' && textOf(t) === '1,212 accounts'))
  expect(all(press).find(n => n.type === 'Text' && textOf(n) === '1,212 accounts')?.props).toMatchObject({ underline: true })
  // all its words open the heads-up, the citation's too; ] reaches it first, then the citation
  expect(press?.props.label).toBe('heads up by 1,212 accounts')
  expect(drawn.some(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))).toBe(false)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(12)))).toContain('Names are typed in')
})

test('`a ask` in the tray\'s header opens a side thread about the heads-up; a prompt typed with it open carries nothing of it', async ($, on) => {
  const opens: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.id); return { value: { isPlaced: true } } as never })
  on('ui.close', () => ({ value: undefined }))
  const { submitted } = await resumed($, on, QUOTED, 's-tray-ask', { parts: HEADS })
  await $.prompt.edit(key(']'))
  const ui = await $.ui.mount(above(40))
  const head = all(await $.ui.render(above(40))).find(n => n.props?.key === 'tray-head')
  expect(textOf(head)).toMatch(/] next citation · a ask · 0 close$/)
  expect(all(head).find(n => n.props?.key === 'tray-a')?.props.label).toBe('ask about the heads-up "Retried runs count twice"')
  await ui.press({ key: 'tray-a' })
  await ui.unmount()
  expect(opens).toEqual(['thimble'])
  // a prompt typed with a heads-up open: no scope of it, no `▸ about` (Claude reads it with the comments anyway)
  await $.prompt.edit(key(']'))
  await $.prompt.submit({ text: 'what else?', origin: { kind: 'composer' } } as never)
  const told = (submitted.at(-1).context ?? []).join('\n')
  expect(told).not.toContain('open in the tray')
})

test("an explainer's or a heads-up's links to a file's lines draw as the answer's citations: one of lines the answer cites opens that citation, another the lines themselves", async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-links', { parts: HEADS, kept: { 'conf/limits.toml': '[limits]\np95_ms = 800\ntimeout_s = 30\n' } })
  // ] heads-up, ] citation, ] explainer
  for (let i = 0; i < 3; i++) { await clock.advance(2000); await $.prompt.edit(key(']')) }
  const drawn = all(await $.ui.render(above(40)))
  const cites = drawn.filter(n => n.type === 'Button' && String(n.props?.label).startsWith('citation '))
  expect(cites.map(n => n.props.label)).toEqual(['citation 1: lists it per run', 'citation 0: the config sets the limit'])
  // underlined in the text's color, the citations' tint on hover, as in the answer: no link color
  const words = all(cites[1]).find(n => n.type === 'Text' && textOf(n) === 'the config sets the limit')
  expect(words?.props).toMatchObject({ underline: true })
  expect(words?.props.color).toBe(undefined)
  expect(drawn.some(n => n.type === 'Markdown' && String(n.props.text).includes('conf/limits.toml'))).toBe(false)
  // the one of the lines the answer cites opens that citation, over the explainer
  let ui = await $.ui.mount(above(40))
  await ui.press({ key: cites[0].props.key })
  await ui.unmount()
  expect(textOf(await $.ui.render(above(40)))).toContain('failed: 12')
  await clock.advance(2000)
  await $.prompt.edit(key('0'))
  // the other opens its lines, as a citation of a file shows them; 0 goes back to the explainer
  ui = await $.ui.mount(above(40))
  await ui.press({ key: cites[1].props.key })
  await ui.unmount()
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('conf/limits.toml:2-3')
  expect(band).toContain('2  p95_ms = 800')
  expect(band).toContain('3  timeout_s = 30')
  await clock.advance(2000)
  await $.prompt.edit(key('0'))
  expect(textOf(await $.ui.render(above(40)))).toContain('The time that 95 of 100 checks stay under.')
})
