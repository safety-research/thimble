// The cite and explain tray (tray/): ] at an empty prompt opens it on the acting answer's first citation, which draws in
// focus; its card shows the check and the evidence, its keys show in the bar; a press on a citation opens it too; a
// question typed with it open carries nothing of it and closes the tray; 0 closes it. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { accent, themeLast } from '../core/theme'
import { treeRows } from '../core/trail.mjs'
import { markColors } from '../explain/place.mjs'
import { citeTint } from '../marks/view'
import { evidenceOpener } from '../tray/tray'
import { test } from './kit'
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
/** An element's children, beside its props or in them. */
function kidsOf(n: Any): Any[] {
  const c = n?.children ?? n?.props?.children
  return Array.isArray(c) ? c : c == null ? [] : [c]
}

// these tests read the citations Claude wrote, as the auto modes draw them
const CITES = { options: { citations: 'auto cite + verify' } }

const TEXT = 'Of the runs, [12 of 40](#) failed on the p95 check.'
const view = { columns: 100, rows: 40, isFullscreen: true }
const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: view, props: { text, isFirstOfReply: true } }) as never
const above = (maxRows = 20) => ({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} }, viewport: view }) as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never

/** A resumed session with one answer, TEXT (or `more.text`), whose citation the check left as `item` (or whose
 *  citations, a list of items); `more`: the turn's cards, the message's parts and kept files to add (a card's meta.json
 *  under cards/<id>/). */
async function resumed($: Any, on: Any, item: Any, session = 's-tray', more: { cards?: Any[]; parts?: Any; kept?: Record<string, string>; text?: string; env?: Record<string, string>; scrolls?: Any[]; panes?: () => Any[] } = {}): Promise<{ submitted: Any[]; clock: Any; spawns: Any[] }> {
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
  on('ui.scroll', (_$: unknown, e: Any) => { more.scrolls?.push(e); return { value: undefined } })
  on('ui.panes', () => ({ value: more.panes?.() ?? [] }) as never)
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

test('] opens the tray on a citation with its evidence; a question asked with it open carries nothing of it; 0 closes it', CITES, async ($, on) => {
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

test('a corrected value computed by code: drawn in the reply as a verified one, with no sign; the header says corrected, the line under it what it was, then the line that printed it and its output; + shows all the code and output; - goes back', CITES, async ($, on) => {
  const { clock } = await resumed($, on, {
    n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'corrected', shown: '11 of 40', was: '12 of 40', reason: 'The output says 11. One run was retried.',
    evidence: { kind: 'computed', by: 'checker', code: 'import json\nprint("runs:", n)\nprint(f"failed: {bad}")\nprint("passed:", n - bad)', output: 'runs: 40\nfailed: 11\npassed: 29', highlight: [[17, 19]] },
  }, 's-tray-2')
  // the corrected words draw as a settled citation: underlined, the purple tint on hover, and no sign after them. What
  // they were shows in the tray alone
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  const corrected = drawn.find(n => n.type === 'Text' && textOf(n) === '11 of 40')
  expect(corrected?.props).toMatchObject({ underline: true })
  expect(corrected?.props?.backgroundColor).toBeUndefined()
  expect(corrected?.hover ?? corrected?.props?.hover).toMatchObject({ backgroundColor: citeTint() })
  expect(textOf(drawn)).toContain('11 of 40 failed')
  expect(textOf(drawn)).not.toContain('*')
  expect(textOf(drawn)).not.toContain('12 of 40')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let drawnBand = all(await $.ui.render(above()))
  let band = textOf(drawnBand)
  // the header's status says corrected, in a checked one's color, what it was under it (no reason), the code line that
  // printed the value, its output line
  expect(band).toContain('✓ corrected  a ask · 0 close')
  expect(band).not.toContain('verified')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === ' corrected')?.props).toMatchObject({ color: 'success' })
  expect(band).toContain('closewas 12 of 40')
  expect(band).not.toContain('corrected; was')
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

test('each key of the tray is a click too: + expand all and − collapse as + and -, a click on the citation in the reply or in the tray\'s title closes it, and 0 close in its header closes it', CITES, async ($, on) => {
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

test('a citation the check found false: × failed in the header, as any failed one, why in one dim sentence under it, x repair, then its evidence; x starts a check of it again in the background, no turn of main', CITES, async ($, on) => {
  const { submitted, clock, spawns } = await resumed($, on, { ...QUOTED, status: 'failed', failedBy: 'check', reason: 'Line 4 counts 12 failed, but 3 were retried. The rest passed.' }, 's-tray-5')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const drawn = all(await $.ui.render(above()))
  const band = textOf(drawn)
  expect(band).toContain('× failed  a ask · 0 close')
  expect(band).not.toContain('wrong')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === '×')?.props?.color).toBe('error')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === ' failed')?.props?.color).toBe('error')
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

test('a repair that corrected the citation says repaired in its header and what it was under it; one that still could not confirm it says not repaired and why, and offers x again', CITES, async ($, on) => {
  await resumed($, on, [
    { ...WRONG, sentence: TWO, status: 'corrected', repair: true, shown: '9 of 40', was: '12 of 40' },
    { ...SECOND, status: 'failed', failedBy: 'evidence', repair: true, reason: 'No file holds a count of failed runs.' },
  ], 's-tray-10', { text: TWO })
  await $.prompt.edit(key(']'))
  const card = textOf(await $.ui.render(above()))
  // ] stays on the bar while the tray is open; the header keeps the tray's own keys
  expect(card).toContain('✓ repaired  a ask · 0 close')
  expect(card).toContain('thimble  ] next citation')
  expect(card).toContain('closewas 12 of 40')
  expect(card).not.toContain('repaired; was')
  expect(card).not.toContain('x repair')
  await $.prompt.edit(key(']'))
  const again = textOf(await $.ui.render(above()))
  expect(again).toContain('not repaired: No file holds a count of failed runs.')
  expect(again).toContain('x repair')
})



test('a citation whose check did not run is failed: × in the reply, × failed in the card with the plain reason, and x starts its check; so is a check the session ended mid-way', CITES, async ($, on) => {
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
  expect(band).toContain('× failed  a ask · 0 close')
  expect(band).toContain('thimble  ] next citation')
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
  expect(ended).toContain('× failed  a ask · 0 close')
  expect(ended).toContain('thimble  [ previous citation')
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
  test(`a click on the file's place in the tray (${how}) opens the citation's evidence in the side pane`, CITES, async ($, on) => {
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
    expect(textOf(await $.ui.render(above()))).not.toContain("didn't open here")
  })
}
test("a corrected citation's evidence in the side pane says ✓ corrected and what it was, as its tray does", CITES, async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  await resumed($, on, { ...QUOTED, status: 'corrected', shown: '11 of 40', was: '12 of 40' }, 's-tray-pane-corrected')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const ui = await $.ui.mount(above())
  await ui.press({ key: 'tray-file' })
  await ui.unmount()
  const pane = await $.ui.render({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'citation 1', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: view } as never)
  const words = textOf(pane)
  expect(words).toContain('✓ corrected  11 of 40')
  expect(words).not.toContain('verified')
  expect(words).toContain('was 12 of 40')
  expect(words).not.toContain('corrected; was')
  for (const t of ['✓', ' corrected']) expect(all(pane).find(n => n.type === 'Text' && textOf(n) === t)?.props).toMatchObject({ color: 'success', bold: true })
})

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
  expect(line?.kind).toBe('failed')
  expect(String(line?.text)).toContain("Claude Code did not open the citation's evidence here")
  expect(String(line?.text)).not.toContain('citation in the reply')
})

// Claude Code places a pane at any width only for the person's press or command, never for a key at the prompt (its
// prompt.edit is no person's input): below 144 columns a at the prompt cannot open the thread, so the bar names what
// opens it there, a click on `a ask` in the bar; that press opens it at any width
test('a on a card at a narrow terminal: the bar names the click on a ask, and that press opens the thread', CITES, async ($, on) => {
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
  expect(band).toContain('a needs a wider terminal: widen the window to show the side pane, or click “a ask”.')
  expect(band).not.toContain('Hint:')
  expect(band).toContain('a ask')
  // the press on a ask in the bar: Claude Code places it
  wide = true
  const ui = await $.ui.mount(above())
  await ui.press({ key: 'bar-tray-a' })
  await ui.unmount()
  expect(opens).toEqual(['thimble', 'thimble'])
  // open now: the notice goes
  expect(textOf(await $.ui.render(above()))).not.toContain('Hint: click')
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

test('a heads-up on a citation\'s words is one ] away; it shows whole, with no paging, no order to the reader and no line about the next prompt', CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-4', { parts: HEADS })
  // ]: the heads-up first, not the citation under it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('a ask · 0 close')
  expect(band).toContain('Retried runs count twice')
  expect(band).toContain('but not the failures among the other runs.')
  expect(band).not.toContain('? ask about this heads-up')
  expect(band).toContain('] next citation')
  for (const gone of ['m more', 'lines 1–', 'Your next prompt', 'leave it out', 'Claude can do this', 'o ask']) expect(band).not.toContain(gone)
  expect(all(await $.ui.render(above(40))).some(n => n.props?.key === 'tray-page' || n.props?.key === 'tray-window')).toBe(false)
  // ] goes on to the citation, then the explainer after it
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('failed: 12')
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(textOf(await $.ui.render(above(40)))).toContain('The time that 95 of 100 checks stay under.')
})

// a value code computed, the citation's evidence ten lines of output
const OUTPUT = ['runs: 40', ...Array.from({ length: 8 }, (_, i) => `run ${i + 1}: ok`), 'failed: 12'].join('\n')
const TALL = {
  n: 1, row: 'row-t1', words: '12 of 40', start: 13, end: 26, sentence: TEXT, status: 'verified', shown: '12 of 40',
  evidence: { kind: 'computed', by: 'checker', code: 'print("runs:", n)\nfor i, r in enumerate(runs):\n    print(f"run {i + 1}: {r}")\nprint(f"failed: {bad}")', output: OUTPUT, highlight: [[OUTPUT.length - 2, OUTPUT.length]] },
}

test('a tray taller than the rows the band has over the bar shows its body in a window of them: the band ends with the whole bar, its failure line too, the dim row under the window says how many more lines there are, and the wheel over the band moves the window', CITES, async ($, on) => {
  const scrolls: Any[] = []
  const { clock } = await resumed($, on, TALL, 's-tray-tall', { scrolls })
  const drawn = async (maxRows: number) => {
    const band = await $.ui.render(above(maxRows))
    return { band, rows: kidsOf(band), text: textOf(band), window: all(band).find(n => n.props?.key === 'tray-window-in') }
  }
  // the band fits its rows, and its last rows are the bar's, whole, under the tray
  const fits = (d: Awaited<ReturnType<typeof drawn>>, maxRows: number) => {
    expect(treeRows(d.band, 100)).toBeLessThanOrEqual(maxRows)
    const tray = d.rows.findIndex(n => n.props?.key === 'tray-band')
    expect(tray).toBeGreaterThan(-1)
    expect(d.rows.slice(tray + 1).map(n => n.props?.key)).toContain('bar')
    expect(String(d.rows.at(-1)?.props?.key)).toMatch(/^bar/)
  }
  // the person's wheel over the band, as Claude Code raises it, and the band's scrolls that reached Claude Code's own
  const wheel = (by: number) => $.ui.scroll({ component: 'AbovePrompt', requestId: 'above', offset: 0, by, bodyRows: 7, contentRows: 8, origin: { kind: 'person' } } as never)
  const bandScrolls = () => scrolls.filter(e => e?.component === 'AbovePrompt').length
  // ] then +: all the code and its ten lines of output
  const open = async () => {
    expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
    expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
  }
  await open()
  // the session's start said the card sandbox cannot start here, a failure line that wraps above the bar: the tray
  // takes the rows left over all of it
  fits(await drawn(10), 10)
  // the next prompt takes that line and closes the tray; opened again, in a band of eight rows
  await $.prompt.submit({ text: 'and the other runs?', origin: { kind: 'composer' } } as never)
  await open()
  let d = await drawn(8)
  fits(d, 8)
  // the tray's head and its keys stay; the body shows from its top, the lines under the window counted
  expect(d.text).toContain('a ask')
  expect(d.window?.props?.top).toBeUndefined()
  expect(Number(/expand (\d+) more line/.exec(d.text)?.[1])).toBeGreaterThan(5)
  // the wheel over the band moves the window, a row a tick, and the band itself does not move
  await wheel(2)
  d = await drawn(8)
  fits(d, 8)
  expect(d.window?.props?.top).toBe(-2)
  expect(bandScrolls()).toBe(0)
  // at the last rows the row under the window counts the lines above, and the wheel goes back up
  await wheel(100)
  d = await drawn(8)
  fits(d, 8)
  const above8 = Number(/↑ (\d+) line/.exec(d.text)?.[1])
  expect(above8).toBeGreaterThan(5)
  expect(d.window?.props?.top).toBe(-above8)
  await wheel(-100)
  d = await drawn(8)
  expect(d.window?.props?.top).toBeUndefined()
  // a band with the rows for all of it shows it whole, with no window
  const whole = await drawn(40)
  expect(whole.window).toBeUndefined()
  expect(whole.text).toContain('│runs: 40│run 1: ok')
  // and the wheel over it is Claude Code's again
  await wheel(1)
  expect(bandScrolls()).toBe(1)
})

test('a tray cut at a short height: d expand N more lines, a click too, shows the rest, as many lines as the band has room for, its blank rows too, and the row then says how many remain; ↑ N lines above and u go a page back up; a word that starts with d is typed', CITES, async ($, on) => {
  const { clock } = await resumed($, on, TALL, 's-tray-page')
  const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`
  const drawn = async (maxRows = 8) => {
    const band = await $.ui.render(above(maxRows))
    const top = all(band).find(n => n.props?.key === 'tray-window-in')?.props?.top
    const keys = kidsOf(band).map(n => String(n.props?.key))
    // the band's blank rows: above the tray, and over the bar
    const blanks = kidsOf(band).filter(n => n.type === 'Text' && textOf(n) === ' ').length
    return {
      band, keys, blanks, text: textOf(band), top: typeof top === 'number' ? -top : 0, rows: Number(all(band).find(n => n.props?.key === 'tray-window')?.props?.height),
      button: (id: string) => all(band).find(n => n.type === 'Button' && n.props?.key === `tray-page-${id}`),
    }
  }
  // the band fits its rows, the bar's row last: the bar stays on screen
  const fits = (d: Awaited<ReturnType<typeof drawn>>) => {
    expect(treeRows(d.band, 100)).toBeLessThanOrEqual(8)
    expect(d.keys.at(-1)).toMatch(/^bar/)
  }
  // a click on the row under the window, in the band as mounted at the same height
  const click = async (id: string) => {
    const band = await $.ui.mount(above(8))
    await band.press({ key: `tray-page-${id}` })
    await band.unmount()
  }
  // ] then +: all the code and its output
  const open = async () => {
    expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
    expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
  }
  await open()
  await drawn(10)
  // the failure line of the session's start goes with the next prompt, which closes the tray; opened again
  await $.prompt.submit({ text: 'and the other runs?', origin: { kind: 'composer' } } as never)
  await open()
  let d = await drawn()
  fits(d)
  const below = Number(/expand (\d+) more line/.exec(d.text)?.[1])
  const first = d.rows
  expect(below).toBeGreaterThan(5)
  expect(d.top).toBe(0)
  // the band's blank rows, above the tray and over the bar
  expect(d.blanks).toBe(2)
  // the row under the window: its key, where it acts, then what it does
  expect(textOf(d.button('down'))).toBe(`d expand ${below} more lines`)
  // a click on it: the tray takes the band's blank rows too, and its window moves on to the lines after the ones shown
  await click('down')
  d = await drawn()
  fits(d)
  expect(d.blanks).toBe(0)
  expect(d.rows).toBe(first + 2)
  const moved = d.top
  expect(moved).toBe(Math.max(1, first - 1))
  // the lines that still remain, and those above
  expect(d.text).toContain(`d expand ${below - 2 - moved} more line`)
  expect(d.text).toContain(`↑ ${lines(moved)} above`)
  // ↑ N lines above: a page back up; the tray keeps the rows it took
  await click('up')
  d = await drawn()
  expect(d.top).toBe(0)
  expect(d.rows).toBe(first + 2)
  // d at an empty prompt shows the lines after the window, u goes back up
  expect(await $.prompt.edit(key('d'))).toEqual({ text: '', cursor: 0 })
  expect((await drawn()).top).toBe(first + 1)
  await clock.advance(2000)
  expect(await $.prompt.edit(key('u'))).toEqual({ text: '', cursor: 0 })
  expect((await drawn()).top).toBe(0)
  await clock.advance(2000)
  // another mark, or the same one opened again, starts in the rows over the bar
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  await open()
  d = await drawn()
  expect(d.rows).toBe(first)
  expect(d.blanks).toBe(2)
  // a word that starts with d: the tray goes back as it was, and the word is typed
  expect(await $.prompt.edit(key('d'))).toEqual({ text: '', cursor: 0 })
  expect((await drawn()).rows).toBe(first + 2)
  const word = await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'o' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'o' } as never) as Any
  expect(word.text).toBe('do')
  d = await drawn()
  expect(d.top).toBe(0)
  expect(d.rows).toBe(first)
  expect(d.blanks).toBe(2)
})

// a value code computed, the citation's evidence three hundred lines of output
const LONG_OUTPUT = ['runs: 300', ...Array.from({ length: 300 }, (_, i) => `run ${i + 1}: ok`), 'failed: 12'].join('\n')
const LONG = { ...TALL, evidence: { ...TALL.evidence, output: LONG_OUTPUT, highlight: [[LONG_OUTPUT.length - 2, LONG_OUTPUT.length]] } }

test('at the narrowest tray, with lines above and below in the hundreds, the row under the window shows both parts whole, each with its key, on its one row', CITES, async ($, on) => {
  const { clock } = await resumed($, on, LONG, 's-tray-page-narrow')
  // a band 40 columns wide: the tray at its narrowest, 36 columns inside its frame
  const narrow = (maxRows: number) => { const a = above(maxRows) as Any; return { ...a, props: { ...a.props, bodyColumns: 40 }, viewport: { ...a.viewport, columns: 40 } } as never }
  const open = async () => {
    expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
    expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
  }
  await open()
  await $.prompt.submit({ text: 'and the other runs?', origin: { kind: 'composer' } } as never)
  await open()
  await $.ui.render(narrow(8))
  // the window in the middle of the body, with more than a hundred lines above it and below it
  await $.ui.scroll({ component: 'AbovePrompt', requestId: 'above', offset: 0, by: 150, bodyRows: 7, contentRows: 8, origin: { kind: 'person' } } as never)
  const band = await $.ui.render(narrow(8))
  const row = all(band).find(n => n.props?.key === 'tray-scroll')
  const text = textOf(row)
  // both parts, each with its key, in the row's 36 columns
  expect(text.length).toBeLessThanOrEqual(36)
  const [, above_, below_] = /^u ↑ (\d+) above · d expand (\d+) more$/.exec(text) ?? []
  expect(Number(above_)).toBeGreaterThanOrEqual(100)
  expect(Number(below_)).toBeGreaterThanOrEqual(100)
  // each part still a click named by its whole words
  expect(all(row).filter(n => n.type === 'Button').map(n => n.props.label)).toEqual([`↑ ${above_} lines above`, `expand ${below_} more lines`])
  // a wider tray keeps the whole words
  const wide = textOf(all(await $.ui.render(above(8))).find(n => n.props?.key === 'tray-scroll'))
  expect(wide).toMatch(/^u ↑ \d+ lines above · d expand \d+ more lines$/)
})

// a heads-up whose words are a citation's words, or hold them
const headsOn = (term: string) => ({ explain: { order: ['h1'], items: { h1: { id: 'h1', kind: 'heads', term, title: 'Names are typed in', bullets: ['Anyone who edits types a name.'] } } } })
const filledOf = (drawn: Any[]) => drawn.filter(n => n.type === 'Text' && n.props?.backgroundColor).map(textOf)

test("a heads-up on a citation's words stays on them when the check corrects them, never on the same word elsewhere in the reply", CITES, async ($, on) => {
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

test('a heads-up whose words hold a citation covers them all: its fill under the citation\'s underline, every word a press of the heads-up', CITES, async ($, on) => {
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

test('`a ask` in the tray\'s header opens a side thread about the heads-up; a prompt typed with it open carries nothing of it', CITES, async ($, on) => {
  const opens: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.id); return { value: { isPlaced: true } } as never })
  on('ui.close', () => ({ value: undefined }))
  const { submitted } = await resumed($, on, QUOTED, 's-tray-ask', { parts: HEADS })
  await $.prompt.edit(key(']'))
  const ui = await $.ui.mount(above(40))
  const head = all(await $.ui.render(above(40))).find(n => n.props?.key === 'tray-head')
  expect(textOf(head)).toMatch(/a ask · 0 close$/)
  expect(textOf(head)).not.toContain(']')
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

test("an explainer's or a heads-up's links to a file's lines draw as the answer's citations: one of lines the answer cites opens that citation, another the lines themselves", CITES, async ($, on) => {
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

test('c cites the selected words in auto cite + verify too: while they wait the bar says c cite beside the claims\' w claims, and c opens their citation in the tray; with none selected, c is a letter of the prompt, and w opens Claims', CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const opens: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.title); return { value: { isPlaced: true } } as never })
  let selected: Any = { text: 'failed on the p95 check', requestId: 'row-t1' }
  on('ui.selection', () => ({ value: selected }))
  let gets = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { gets++; return next(e) })
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite')
  // the claims keep their item on the bar while words wait: c and w each name one thing
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('c cite')
  expect(band).toContain('w claims')
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  // the words are a citation of their own, open in the tray, and its check started; the selection no longer waits
  band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('failed on the p95 check')
  expect(band).toContain('a ask · 0 close')
  expect(spawns.length).toBe(1)
  expect(band).not.toContain('c cite')
  expect(band).toContain('w claims')
  // with nothing selected, c is typed and opens nothing, as q, a letter no one takes (the first such letter reads what
  // the cards' keys need, once); at the key c reads the selection and none of the state: the open tray's citation,
  // which c does not act on, is not read for it
  selected = undefined
  expect(await $.prompt.edit(key('q'))).toEqual({ text: 'q', cursor: 1 })
  gets = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: 'c', cursor: 1 })
  expect(gets).toBe(0)
  await clock.advance(1000)
  expect(opens).toEqual([])
  // w opens Claims
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(opens).toEqual(['Claims'])
})

test('with Claims off, c cites the selected words, and with none selected c is a letter of the prompt, since nothing on the bar names it', { options: { citations: 'auto cite + verify', claimsMode: 'off' } }, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const opens: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.title); return { value: { isPlaced: true } } as never })
  let selected: Any = { text: 'failed on the p95 check', requestId: 'row-t1' }
  on('ui.selection', () => ({ value: selected }))
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite-off')
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  // the words are a citation of their own, open in the tray, and its check started
  expect(textOf(await $.ui.render(above(40)))).toContain('failed on the p95 check')
  expect(spawns.length).toBe(1)
  // nothing selected: c is typed, and opens nothing; so is w, whose pane is off
  selected = undefined
  expect(textOf(await $.ui.render(above(40)))).not.toContain('c cite')
  expect(await $.prompt.edit(key('c'))).toEqual({ text: 'c', cursor: 1 })
  await clock.advance(1000)
  expect(await $.prompt.edit(key('w'))).toEqual({ text: 'w', cursor: 1 })
  await clock.advance(1000)
  expect(opens).toEqual([])
})

test("c with words selected reads the selection once and no state at the key, however many answers the session holds: whether they wait is kept from the bar's drawing, and words selected since are checked in full", CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  // words dragged over more than one row: Claude Code names no row, so they are looked for in every answer
  let selected: Any = { text: 'failed on the p95 check' }
  let selections = 0
  on('ui.selection', () => { selections++; return { value: selected } })
  let gets = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { gets++; return next(e) })
  // sixty answers after the one that holds the words
  const kept: Record<string, string> = {}
  for (let n = 2; n <= 61; n++) {
    kept[`answers/t${n}.json`] = JSON.stringify({ v: 1, turn: { turnId: `t${n}`, n, prompt: { text: `and run ${n}?`, by: 'composer', row: `row-q${n}` }, rows: [`row-t${n}`], answer: `row-t${n}`, reason: 'answer', startedAt: n, endedAt: n, labels: [], cards: [], seq: 0 }, msgs: [{ row: `row-t${n}`, turnId: `t${n}`, text: `Run ${n} passed every check.`, at: n }] })
  }
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite-long', { kept })
  // the bar draws, and names c cite
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  // c: one read of the selection, none of the state, within the hook's few milliseconds
  gets = 0
  selections = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  expect(gets).toBe(0)
  expect(selections).toBe(1)
  await clock.advance(1000)
  // the words are a citation of their own, open in the tray, and its check started
  expect(textOf(await $.ui.render(above(40)))).toContain('failed on the p95 check')
  expect(spawns.length).toBe(1)
  // cited, the selection no longer waits: c is typed, and reads no state either (q, a letter no one takes, first reads
  // what the cards' keys need, once)
  expect(await $.prompt.edit(key('q'))).toEqual({ text: 'q', cursor: 1 })
  gets = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: 'c', cursor: 1 })
  expect(gets).toBe(0)
  // words selected since the bar last drew: the key checks them in full, and c cites them
  selected = { text: 'Run 7 passed every check' }
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(spawns.length).toBe(2)
})

test("a double click on one of the bar's items selects its word, which is the bar's, not the answer's that also has it: the bar names neither c nor e; the answer's words, as its row draws them, still count", CITES, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  await resumed($, on, { ...QUOTED, status: 'corrected', shown: '11 of 40', was: '12 of 40' }, 's-tray-control', { text: 'Of the runs, [12 of 40](#) failed on the p95 check, as the claims show.' })
  expect(textOf(await $.ui.render(above()))).toContain('w claims')
  // `claims`, as a double click on the bar's `w claims` selects it
  selected = { text: 'claims' }
  let band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('c cite')
  expect(band).not.toContain('e explain')
  // the same word in the answer, among others
  selected = { text: 'as the claims show', requestId: 'row-t1' }
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  // the corrected words the row draws in place of the citation's
  expect(textOf(await $.ui.render(answer('row-t1', 'Of the runs, [12 of 40](#) failed on the p95 check, as the claims show.')))).toContain('11 of 40 failed')
  selected = { text: 'runs, 11 of 40 failed', requestId: 'row-t1' }
  band = textOf(await $.ui.render(above()))
  expect(band).toContain('c cite')
})

test("a click on thimble's controls that slid a cell leaves a piece of their words selected, no answer's words though the answer holds it whole: on the bar, the tray and a card's header on screen; once those are gone, their words in an answer count again", CITES, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  const text = 'Of the runs, [12 of 40](#) failed on the p95 check: it is in a sweep where 0 runs pass, so ask before you close it as done.'
  const id = 'c0123456789ad'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_9', agentId: 'a-made-up', anchorRow: 'row-t1', keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_9: { version: 1 } }, at: 1 }
  const { clock } = await resumed($, on, QUOTED, 's-tray-slid', { text, kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) } })
  const counts = async (sel: Any) => {
    // a selection made anew: none in between, as the click that makes it takes the one before down
    selected = undefined
    await $.ui.render(above(40))
    selected = sel
    const band = textOf(await $.ui.render(above(40)))
    expect(band.includes('c cite')).toBe(band.includes('e explain'))
    return band.includes('c cite')
  }
  // words of the answer: the bar names c and e
  expect(await counts({ text: 'failed on the p95 check', requestId: 'row-t1' })).toBe(true)
  // a click on the bar's `e explain` as it names it, then on `s rewrite` and `thimble`
  selected = { text: 'in' }
  expect(textOf(await $.ui.render(above(40)))).not.toContain('c cite')
  expect(textOf(await $.ui.render(above(40)))).not.toContain('e explain')
  expect(await counts({ text: 'it' })).toBe(false)
  expect(await counts({ text: 'im' })).toBe(false)
  // the tray open: a click on its `a ask` or `0 close`
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(textOf(await $.ui.render(above(40)))).toContain('a ask · 0 close')
  expect(await counts({ text: 'a' })).toBe(false)
  expect(await counts({ text: 'as' })).toBe(false)
  expect(await counts({ text: '0 ' })).toBe(false)
  // the answer's own words still count while the tray is open
  expect(await counts({ text: 'a sweep', requestId: 'row-t1' })).toBe(true)
  // a card under the answer, on screen: a click on its header's `p artifact` or `a ask`, in the answer's row
  expect(textOf(await $.ui.render(answer('row-t1', text)))).toContain('Runs by status')
  expect(await counts({ text: 'p', requestId: 'row-t1' })).toBe(false)
  expect(await counts({ text: 'as', requestId: 'row-t1' })).toBe(false)
  // the tray closed and the card out of view: those words in the answer count again
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(textOf(await $.ui.render(above(40)))).not.toContain('0 close')
  await $.ui.render({ ...(answer('row-t1', text) as Any), props: { text, isFirstOfReply: true, onScreen: null } } as never)
  await clock.advance(10)
  expect(await counts({ text: 'close', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'ask', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'as', requestId: 'row-t1' })).toBe(true)
})

test("a click that slid a cell on the row under a paged tray's window leaves a piece of its words selected: no answer's words, though the answer holds them whole", CITES, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  const text = 'Of the runs, [12 of 40](#) failed on the p95 check; more lines of its output follow.'
  const { clock } = await resumed($, on, TALL, 's-tray-slid-page', { text })
  const counts = async (sel: Any, maxRows: number) => {
    // a selection made anew: none in between, as the click that makes it takes the one before down
    selected = undefined
    await $.ui.render(above(maxRows))
    selected = sel
    const band = textOf(await $.ui.render(above(maxRows)))
    expect(band.includes('c cite')).toBe(band.includes('e explain'))
    return band.includes('c cite')
  }
  // ] then +: all the code and its output, in a band of eight rows: the row under the window names the lines below
  const open = async () => {
    expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
    expect(await $.prompt.edit(key('+'))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
  }
  await open()
  await $.prompt.submit({ text: 'and the other runs?', origin: { kind: 'composer' } } as never)
  await open()
  expect(textOf(await $.ui.render(above(8)))).toMatch(/d expand \d+ more lines/)
  // a click on it that slid a cell: its words, with its key and without
  expect(await counts({ text: 'more' }, 8)).toBe(false)
  expect(await counts({ text: 'lines' }, 8)).toBe(false)
  expect(await counts({ text: 'd expand' }, 8)).toBe(false)
  // the answer's own words still count
  expect(await counts({ text: 'failed on the p95 check', requestId: 'row-t1' }, 8)).toBe(true)
})

test("a click that slid a cell on a card's title, a press that asks about the card, leaves a piece of it selected in the answer's row: the bar names neither c nor e; the card's body, a chart label and a word of the answer that the title holds too still count", CITES, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  const text = 'Of the runs, [12 of 40](#) failed on the p95 check: it is in a sweep where 0 runs pass, so ask before you close it as done.'
  const id = 'c0123456789ae'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_8', agentId: 'a-made-up', anchorRow: 'row-t1', keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_8: { version: 1 } }, at: 1 }
  await resumed($, on, QUOTED, 's-tray-title', { text, kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) } })
  const counts = async (sel: Any) => {
    // a selection made anew: none in between, as the click that makes it takes the one before down
    selected = undefined
    await $.ui.render(above(40))
    selected = sel
    const band = textOf(await $.ui.render(above(40)))
    expect(band.includes('c cite')).toBe(band.includes('e explain'))
    return band.includes('c cite')
  }
  // the card under the answer, on screen: its title is a press that asks about it
  const title = all(await $.ui.render(answer('row-t1', text))).find(n => n.type === 'Button' && String(n.props?.label).startsWith('ask about') && textOf(n) === 'Runs by status')
  expect(title).toBeDefined()
  // a click on it that slid a cell: at its start, inside a word, over a space, a word the answer does not hold, and
  // the whole title
  for (const piece of ['Ru', 'ns', 'tu', 'y ', 'by', 'Runs by status']) expect(await counts({ text: piece, requestId: 'row-t1' })).toBe(false)
  // a word of the answer that the title holds too
  expect(await counts({ text: 'runs', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'Runs', requestId: 'row-t1' })).toBe(true)
  // the card's body, in the answer's row: a word of its table, a chart label
  expect(await counts({ text: 'passed', requestId: 'row-t1' })).toBe(true)
  expect(await counts({ text: 'passed  ████████████ 28', requestId: 'row-t1' })).toBe(true)
  // the card out of view: words selected in the row count as its own again
  await $.ui.render({ ...(answer('row-t1', text) as Any), props: { text, isFirstOfReply: true, onScreen: null } } as never)
  expect(await counts({ text: 'by', requestId: 'row-t1' })).toBe(true)
})

test("c on words selected since the bar last drew reads a few states at most, however many answers: the selection's watch works out whether they wait as it sees them, and the key's own check reads the newest turns alone", CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  let selected: Any = { text: 'failed on the p95 check', requestId: 'row-t1' }
  let selections = 0
  on('ui.selection', () => { selections++; return { value: selected } })
  let gets = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { gets++; return next(e) })
  // sixty answers after the one that holds the words
  const kept: Record<string, string> = {}
  for (let n = 2; n <= 61; n++) {
    kept[`answers/t${n}.json`] = JSON.stringify({ v: 1, turn: { turnId: `t${n}`, n, prompt: { text: `and run ${n}?`, by: 'composer', row: `row-q${n}` }, rows: [`row-t${n}`], answer: `row-t${n}`, reason: 'answer', startedAt: n, endedAt: n, labels: [], cards: [], seq: 0 }, msgs: [{ row: `row-t${n}`, turnId: `t${n}`, text: `Run ${n} passed every check.`, at: n }] })
  }
  const { clock, spawns } = await resumed($, on, QUOTED, 's-tray-cite-tick', { kept })
  // the answer and the bar draw, in the fullscreen layout, whose selection the watch reads; the bar names c cite
  await $.ui.render(answer('row-t1', TEXT))
  expect(textOf(await $.ui.render(above()))).toContain('c cite')
  // other words selected, which the watch sees at its next read; the bar has not drawn since: c reads the selection
  // alone, within the hook's few milliseconds
  selected = { text: 'Run 7 passed every check', requestId: 'row-t7' }
  await clock.advance(400)
  gets = 0
  selections = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  expect(gets).toBe(0)
  expect(selections).toBe(1)
  await clock.advance(1000)
  expect(spawns.length).toBe(1)
  // words selected the moment before c, before the watch's next read: the key checks them itself, reading the
  // answer they lie in and the newest turns, not every one
  selected = { text: 'Run 9 passed every check', requestId: 'row-t9' }
  gets = 0
  expect(await $.prompt.edit(key('c'))).toEqual({ text: '', cursor: 0 })
  expect(gets).toBeLessThan(8)
  await clock.advance(1000)
  expect(spawns.length).toBe(2)
})

test("the Claims pane's w close is a click alone: a w typed while the pane holds the keyboard reaches the prompt, where it closes the pane once its word window closed, and a question that starts with w is typed whole", CITES, async ($, on) => {
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.selection', () => ({ value: undefined }))
  // the side pane as Claude Code keeps it: up from an open until a close
  let up = false
  const opens: Any[] = []
  const closes: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opens.push(e.title); up = true; return { value: { isPlaced: true } } as never })
  on('ui.close', (_$: unknown, e: Any) => { closes.push(e.id); up = false; return { value: undefined } as never })
  const { clock } = await resumed($, on, QUOTED, 's-tray-wclose', { panes: () => (up ? [{ id: 'thimble', title: 'Claims' }] : []) })
  expect(textOf(await $.ui.render(above()))).toContain('w claims')
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(opens).toEqual(['Claims'])
  // the pane's key row ends with w close, a click alone: no Button of the pane takes w, so Claude Code types a w typed
  // in the pane into the prompt
  const pane = await $.ui.render({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'Claims', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: view } as never)
  const buttons = all(pane).filter(n => n.type === 'Button')
  expect(buttons.filter(b => b.props.hotkey === 'w')).toEqual([])
  const close = buttons.find(b => String(b.key ?? b.props.key) === 'key-w')
  expect([close?.props.label, textOf(close)]).toEqual(['close', 'w: close'])
  // that w, alone: the pane closes once its word window closed
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(closes).toEqual(['thimble'])
  // open again: a question that starts with w, typed on, is a word, whole in the prompt, and the pane stays
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(1000)
  expect(opens).toEqual(['Claims', 'Claims'])
  expect(await $.prompt.edit(key('w'))).toEqual({ text: '', cursor: 0 })
  expect(await $.prompt.edit(key('h'))).toEqual({ text: 'wh', cursor: 2 })
  expect(await $.prompt.edit({ ...(key('y') as Any), text: 'wh', cursor: 2, start: 2, end: 2 } as never)).toEqual({ text: 'why', cursor: 3 })
  await clock.advance(1000)
  expect(closes).toEqual(['thimble'])
})

test('a sentence the check rewrote draws as rewritten, its citation corrected, though the analyst asked about other words of it: those step aside', CITES, async ($, on) => {
  const fixed = { ...QUOTED, status: 'corrected', shown: '11 of 40', was: '12 of 40', rewrite: 'Of the runs, [11 of 40] failed on the p99 check.' }
  const asked = { n: 2, row: 'row-t1', words: 'failed on the p95 check', start: 27, end: 50, sentence: 'Of the runs, [12 of 40] [failed on the p95 check].', status: 'deferred', shown: 'failed on the p95 check', asked: true }
  await resumed($, on, [fixed, asked], 's-tray-rewritten')
  const drawn = textOf(await $.ui.render(answer('row-t1', TEXT)))
  expect(drawn).toContain('Of the runs, 11 of 40 failed on the p99 check.')
  expect(drawn).not.toContain('×')
  expect(drawn).not.toContain('*')
})

test("with Citations manual, ] passes the citations Claude wrote (they draw as plain words); a click on their words still opens one", { options: { citations: 'manual' } }, async ($, on) => {
  // the answer's only citation is Claude's: nothing for ] to open, so ] is the prompt's and types
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  await resumed($, on, QUOTED)
  expect((await $.prompt.edit(key(']')) as Any)?.text).toBe(']')
  expect(textOf(await $.ui.render(above()))).not.toContain('12 of 40')
  // the reply draws it as plain words, underlined under the pointer, and a press still opens it
  const cite = all(await $.ui.render(answer('row-t1', TEXT))).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  const words = all(cite).find(n => n.type === 'Text' && textOf(n) === '12 of 40')
  expect(words.props?.underline).toBeUndefined()
  expect((cite.hover ?? cite.props.hover).underline).toBe(true)
  const reply = await $.ui.mount(answer('row-t1', TEXT))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  expect(textOf(await $.ui.render(above()))).toContain('failed: 12')
})

test('while the tray is open the bar names what ] goes to from the mark the tray shows, its name in that mark\'s look: a heads-up opened with h over its citation names the citation after it, as when ] reached it, and ] goes there', CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-steps', { parts: HEADS })
  // ] is on the bar, not in the header, while the tray is open
  const stepKey = async () => all(await $.ui.render(above(40))).find(n => n.type === 'Button' && String(n.props?.key ?? '').endsWith('tray-]'))
  const head = async () => textOf(await stepKey())
  // the look of the words that name the mark ] goes to, in the bar's ] key, beside `next`
  const named = async (what: string) => {
    const k = await stepKey()
    const props = (t: string) => { const n = all(k).find(x => x.type === 'Text' && textOf(x) === t); if (!n) return null; const { key: _k, children: _c, ...rest } = n.props; return rest }
    return { next: props(' next '), what: props(what) }
  }
  const fills = markColors(themeLast())
  // ] reaches the heads-up on the citation's words, then the citation, then the explainer
  await $.prompt.edit(key(']'))
  expect(await head()).toContain('] next citation')
  // a citation's name underlined, in the text's own color, as a citation's words in the reply
  expect(await named('citation')).toEqual({ next: { dimColor: true }, what: { underline: true } })
  await clock.advance(2000)
  await $.prompt.edit(key(']'))
  expect(await head()).toContain('] next explainer')
  // an explainer's name on the explainers' teal
  expect(await named('explainer')).toEqual({ next: { dimColor: true }, what: { backgroundColor: fills.glossBg } })
  // h on the citation opens the heads-up over it: the same box, the same header
  await clock.advance(2000)
  await $.prompt.edit(key('h'))
  await clock.advance(2000)
  expect(textOf(await $.ui.render(above(40)))).toContain('Retried runs count twice')
  expect(await head()).toContain('] next citation')
  // ] goes to the citation, as the header says
  await $.prompt.edit(key(']'))
  await clock.advance(2000)
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('failed: 12')
  expect(band).not.toContain('Retried runs count twice')
})

test("at rest the bar names ] and the mark it opens while the answer the keys act on shows marks, in either layout, a press that opens it as ] does: `show` the answer's first mark, `next` a later one, the mark's name in its own look; its verb is in thimble's color while one of the answer's marks is not opened, and dim as the bar's other keys' words once the person opened each", CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-rest', { parts: HEADS })
  const rest = async (isFullscreen = true) => all(await $.ui.render({ ...(above(40) as Any), viewport: { ...view, isFullscreen } } as never)).find(n => n.type === 'Button' && n.props?.key === 'bar-tray-next')
  const words = (b: Any) => all(b).find(n => n.type === 'Text' && textOf(n).startsWith(' '))
  const look = (b: Any, what: string) => all(b).find(n => n.type === 'Text' && textOf(n) === what)?.props
  const fills = markColors(themeLast())
  // the heads-up on the citation's words comes first; nothing of the answer was opened yet: lit, and `heads up` on the
  // heads-ups' orange, as its words in the reply
  for (const isFullscreen of [true, false]) {
    const b = await rest(isFullscreen)
    expect(textOf(b)).toBe('] show heads up')
    expect(all(b).find(n => n.type === 'Text' && textOf(n) === ']')?.props).toMatchObject({ color: accent(), bold: true })
    expect(words(b)?.props?.color).toBe(accent())
    expect(look(b, 'heads up')).toMatchObject({ backgroundColor: fills.headsBg })
    expect(look(b, 'heads up')?.color).toBeUndefined()
    expect(look(b, 'heads up')?.dimColor).toBeUndefined()
  }
  // a press on it opens the heads-up; the open tray names ] in its header alone
  const ui = await $.ui.mount(above(40))
  await ui.press({ key: 'bar-tray-next' })
  await ui.unmount()
  const band = textOf(await $.ui.render(above(40)))
  expect(band).toContain('Retried runs count twice')
  expect(band.match(/\] next/g)).toEqual(['] next'])
  // closed: the citation and the explainer are not opened yet, so the words stay lit, and name the citation, which ]
  // opens now: `citation` underlined, as a citation's words in the reply
  await clock.advance(2000)
  await $.prompt.edit(key('0'))
  expect(textOf(await rest())).toBe('] next citation')
  expect(words(await rest())?.props?.color).toBe(accent())
  expect(words(await rest())?.props?.dimColor).toBeUndefined()
  expect(look(await rest(), 'citation')).toMatchObject({ underline: true })
  expect(look(await rest(), 'citation')?.color).toBeUndefined()
  // ] from rest opens the citation, then on to the explainer: each mark opened, so dim, and ] names the first mark
  // again, which keeps its look
  for (const k of [']', ']', '0']) {
    await clock.advance(2000)
    await $.prompt.edit(key(k))
  }
  expect(textOf(await rest())).toBe('] show heads up')
  expect(words(await rest())?.props).toMatchObject({ dimColor: true })
  expect(words(await rest())?.props?.color).toBeUndefined()
  expect(look(await rest(), 'heads up')).toMatchObject({ backgroundColor: fills.headsBg })
})

test("while the bar's ] is lit, ] from rest opens the first of the answer's marks the person has not opened, which the bar names; from there ] and [ step in reading order; once each was opened, ] from rest opens the first mark again", CITES, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-unopened', { parts: HEADS })
  const rest = async () => textOf(all(await $.ui.render(above(40))).find(n => n.type === 'Button' && n.props?.key === 'bar-tray-next'))
  const press = async (k: string) => {
    await clock.advance(2000)
    await $.prompt.edit(key(k))
  }
  const shows = async () => textOf(await $.ui.render(above(40)))
  // in reading order: the heads-up on the citation's words, the citation, the explainer. ] opens the heads-up first
  expect(await rest()).toBe('] show heads up')
  await press(']')
  expect(await shows()).toContain('Retried runs count twice')
  await press('0')
  // the citation is the first not opened: the bar names it, and ] opens it
  expect(await rest()).toBe('] next citation')
  await press(']')
  let band = await shows()
  expect(band).toContain('failed: 12')
  expect(band).not.toContain('Retried runs count twice')
  // from there ] and [ step in reading order: on to the explainer, back to the citation, back to the heads-up
  await press(']')
  band = await shows()
  expect(band).toContain('The time that 95 of 100 checks stay under.')
  await press('[')
  band = await shows()
  expect(band).toContain('failed: 12')
  expect(band).not.toContain('The time that 95 of 100 checks stay under.')
  await press('[')
  expect(await shows()).toContain('Retried runs count twice')
  await press('0')
  // each mark opened: ] is no longer lit, and from rest it opens the first mark again
  expect(await rest()).toBe('] show heads up')
  await press(']')
  expect(await shows()).toContain('Retried runs count twice')
})

test('each key shows once, where it acts: a card on screen names a in its header only while a reaches it; the open tray names a in its header, and on a card ] reached the bar names it', CITES, async ($, on) => {
  const id = 'c0123456789af'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_7', agentId: 'a-made-up', anchorRow: 'row-t1', keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_7: { version: 1 } }, at: 1 }
  const { clock } = await resumed($, on, QUOTED, 's-tray-head-a', { kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) } })
  // the card's Client says it is on screen, as it does once drawn
  const shown = await $.ui.mount(answer('row-t1', TEXT))
  await shown.unmount()
  const head = async () => textOf(all(await $.ui.render(answer('row-t1', TEXT))).find(n => n.props?.key === 'head-keys'))
  const band = async () => textOf(await $.ui.render(above(40)))
  expect(await head()).toBe('a ask · p artifact')
  // ]: the tray on the citation names a in its header, and a goes there, so the card's header names ask without it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await band()).toContain('] next card · a ask · 0 close')
  expect(await head()).toBe('ask · p artifact')
  // ] again reaches the card: the bar names a, which asks about it, and the card's header still names ask without it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  const stand = await band()
  expect(stand).toContain('a ask · [ previous citation · 0 back')
  expect(stand.match(/a ask/g)).toEqual(['a ask'])
  expect(await head()).toBe('ask · p artifact')
  // 0 gives the keys back: a reaches the card again, and its header names it
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await band()).not.toContain('a ask')
  expect(await head()).toBe('a ask · p artifact')
})

test('each key shows once, where it acts: with Heads-ups on demand, the tray on a citation with a heads-up on its words names h in its header, and the bar leaves its h heads-ups out until the tray closes', { options: { citations: 'auto cite + verify', details: 'on demand' } }, async ($, on) => {
  const { clock } = await resumed($, on, QUOTED, 's-tray-h-once', { parts: HEADS })
  const band = async () => textOf(await $.ui.render(above(40)))
  expect(await band()).toContain('h heads-ups')
  // ] reaches the heads-up on the citation's words, and ] again the citation: h opens that heads-up over it, which the
  // tray's header names alone
  for (const k of [']', ']']) {
    expect(await $.prompt.edit(key(k))).toEqual({ text: '', cursor: 0 })
    await clock.advance(2000)
  }
  const open = await band()
  expect(open).toContain('failed: 12')
  expect(open.match(/h heads-ups?/g)).toEqual(['h heads-up'])
  // closed: h asks for heads-ups on the answer again, and the bar names it
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(2000)
  expect(await band()).toContain('h heads-ups')
})

test('an answer that shows no marks: the bar names no ]', CITES, async ($, on) => {
  await resumed($, on, [], 's-tray-rest-none', { text: 'Of the runs, 12 of 40 failed on the p95 check.' })
  const band = await $.ui.render(above(40))
  expect(all(band).some(n => n.props?.key === 'bar-tray-next')).toBe(false)
  expect(textOf(band)).not.toContain('] next')
  expect(textOf(band)).not.toContain('] show')
})

test("the pointer over a heads-up's or an explainer's words underlines them, over their stronger fill, as thimble's other presses are underlined under it", CITES, async ($, on) => {
  await resumed($, on, QUOTED, 's-tray-hover', { parts: HEADS })
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  for (const label of ['heads up 12 of 40', 'explain p95']) {
    const press = drawn.find(n => n.type === 'Button' && String(n.props?.label).startsWith(label))
    expect(press?.hover ?? press?.props?.hover).toMatchObject({ inverse: false, underline: true })
    expect((press?.hover ?? press?.props?.hover)?.backgroundColor).toBeTruthy()
  }
})
