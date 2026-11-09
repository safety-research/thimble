// The cite and explain tray (tray/): ] at an empty prompt opens it on the newest answer's first citation, which draws
// in focus; its card shows the check and the evidence; a question typed with it open carries nothing of it and closes
// the tray; a press on a citation opens it too; 0 closes it; a press on an older answer's citation marks no answer, and
// ] from rest still starts at the newest answer; v closes it so the card shows, and a letter after v puts it back; ]
// and [ reach a card where the reply draws it. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { citeTint } from '../marks/view'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : n.type === 'Code' ? String(n.props.source) : '') + textOf(n.children)
}
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  all(n.children, out)
  return out
}
// these tests read the citations Claude wrote, as the auto modes draw them
const CITES = { options: { citations: 'auto cite + verify' } }

const TEXT = 'Of the runs, [12 of 40](#) failed on the p95 check.'
const view = { columns: 100, rows: 40, isFullscreen: true }
const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: view, props: { text, isFirstOfReply: true } }) as never
const above = (maxRows = 20) => ({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} }, viewport: view }) as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never

/** A resumed session with one answer, TEXT, whose citation the check left as `item`. */
async function resumed($: Any, on: Any, item: Any, more: Record<string, string> = {}): Promise<{ submitted: Any[]; clock: Any }> {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  const submitted: Any[] = []
  on('session.id', () => ({ value: 's-tray' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const kept: Record<string, string> = {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: [item] }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: TEXT, at: 1 }] }),
    ...more,
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
  on('ui.panes', () => ({ value: [] }) as never)
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', () => ({ model: 'claude-made-up', agentId: 'agent-repair-1' }) as never)
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => { submitted.push(e); return { text: e.text } })
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  return { submitted, clock }
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
  // the file's place as the label over its lines, dim, and the lines the check read after a rule, all of them while
  // they fit, so no marker
  expect(band).toContain('✓ verified  a ask · 0 close')
  expect(band).not.toContain('· citation')
  expect(band).not.toContain('Line 4 says')
  expect(band).toContain('runs/summary.txt · line 4│runs: 40│failed: 12│passed: 28')
  expect(band).not.toContain('4 │')
  expect(band).not.toContain('⋯')
  // the value on the citations' purple tint alone, in the line's own weight and color; the place and the lines around
  // the cited one dim
  const drawnBand = all(await $.ui.render(above()))
  const value = drawnBand.find(n => n.type === 'Text' && textOf(n) === '12' && n.props?.backgroundColor)
  expect(value?.props).toMatchObject({ backgroundColor: citeTint() })
  for (const look of ['bold', 'underline', 'color', 'dimColor']) expect(value?.props?.[look]).toBeUndefined()
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'runs/summary.txt · line 4')?.props).toMatchObject({ dimColor: true })
  for (const around of ['runs: 40', 'passed: 28']) expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === around)?.props).toMatchObject({ dimColor: true })
  // each key once: the bar under it keeps its own keys and names none of the tray's
  expect(band.match(/a ask/g)).toEqual(['a ask'])
  expect(band.match(/0 close/g)).toEqual(['0 close'])
  expect(band).toContain('s simplify')
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

// a second answer, newer than TEXT's, with a citation of its own
const NEWER = 'Most of them, [9 of 12](#), ran on the old build.'
const NEWER_CITE = {
  n: 1, row: 'row-t2', words: '9 of 12', start: NEWER.indexOf('[9 of 12]'), end: NEWER.indexOf('[9 of 12]') + 12, sentence: NEWER, status: 'verified', shown: '9 of 12', reason: 'Line 2 says 9.',
  evidence: { kind: 'quote', file: 'runs/builds.txt', line: '2', lines: [{ n: 2, text: 'old build: 9', highlight: [11, 12] }] },
}

test('a press on a citation of an older answer opens the tray and marks no answer; once 0 closes it, ] starts at the newest answer', CITES, async ($, on) => {
  await resumed($, on, QUOTED, {
    'marks/row-t2.json': JSON.stringify({ key: 'row-t2', turnId: 't2', rows: ['row-t2'], startedAt: 2, settledAt: 3, items: [NEWER_CITE] }),
    'answers/t2.json': JSON.stringify({ v: 1, turn: { turnId: 't2', n: 2, prompt: { text: 'which build?', by: 'composer', row: 'row-q2' }, rows: ['row-t2'], answer: 'row-t2', reason: 'answer', startedAt: 2, endedAt: 3, labels: [], cards: [], seq: 0 }, msgs: [{ row: 'row-t2', turnId: 't2', text: NEWER, at: 3 }] }),
  })
  // a press on the older answer's citation opens the tray on it
  const cite = all(await $.ui.render(answer('row-t1', TEXT))).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  const ui = await $.ui.mount(answer('row-t1', TEXT))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  expect(textOf(await $.ui.render(above()))).toContain('failed: 12')
  // 0 closes it, and the older answer keeps its ●: nothing stands in its place
  expect(await $.prompt.edit(key('0'))).toEqual({ text: '', cursor: 0 })
  const older = textOf(await $.ui.render(answer('row-t1', TEXT)))
  expect(older).toContain('●')
  expect(older).not.toContain('▸')
  // from rest, ] opens the newest answer's citation, not the older one again
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const band = textOf(await $.ui.render(above()))
  expect(band).toContain('old build: 9')
  expect(band).not.toContain('failed: 12')
})

test('v with the tray open closes it, so the card that draws under the answer shows; a letter right after v puts it back', CITES, async ($, on) => {
  // what the box holds once a key is typed
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  // the answer v draws: main's last answer row, as a resumed session reads it back
  const { clock } = await resumed($, on, QUOTED, { 'answer.json': JSON.stringify({ row: 'row-t1' }) })
  // ] opens the tray; a letter right after ] would make a word of both, so the test waits out the word window
  const open = async () => {
    await $.prompt.edit(key(']'))
    expect(textOf(await $.ui.render(above()))).toContain('✓ verified')
    await clock.advance(1000)
  }
  await open()
  // a letter right after v: the person types a word, and the tray stands as it was
  await $.prompt.edit(key('v'))
  expect(textOf(await $.ui.render(above()))).not.toContain('✓ verified')
  await $.prompt.edit({ ...(key('e') as Any), text: 'v', cursor: 1, start: 1, end: 1 } as never)
  await clock.advance(10)
  expect(textOf(await $.ui.render(above()))).toContain('✓ verified')
  // v alone: the tray stays closed
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'backspace' }, text: '', cursor: 0, start: 0, end: 0, inputText: '' } as never)
  await clock.advance(1000)
  await open()
  await $.prompt.edit(key('v'))
  await clock.advance(1000)
  expect(textOf(await $.ui.render(above()))).not.toContain('✓ verified')
})

// a reply that places a card on a line of its own after its first paragraph (Claude drew the card before it wrote the
// reply), with a citation above the card and one under it
const CARD = 'c0a1b2c3d4'
const PLACED = `${TEXT}\n\n[Runs by status](card:${CARD})\n\nThe slowest run took [41 s](#).`
const SLOWEST = {
  n: 2, row: 'row-t1', words: '41 s', start: PLACED.indexOf('[41 s]'), end: PLACED.indexOf('[41 s]') + 9, sentence: 'The slowest run took [41 s](#).', status: 'verified', shown: '41 s', reason: 'Line 9 says 41 s.',
  evidence: { kind: 'quote', file: 'runs/summary.txt', line: '9', lines: [{ n: 9, text: 'slowest: 41 s', highlight: [9, 13] }] },
}

test('] and [ walk the citations and the card in the order the reply draws them: a card it places after its first paragraph stands after that paragraph\'s citation, though Claude drew it before the reply', CITES, async ($, on) => {
  await resumed($, on, QUOTED, {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: [QUOTED, SLOWEST] }),
    // the card's call came before the reply's text: none of the turn's text rows stands above it
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: [{ id: CARD, toolUseId: 'toolu_made_up_c1', seq: 1, after: 0 }], seq: 1 }, msgs: [{ row: 'row-t1', turnId: 't1', text: PLACED, at: 1 }] }),
    [`cards/${CARD}/meta.json`]: JSON.stringify({ id: CARD, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_c1', turn: 't1', agentId: null, anchorRow: null, inRow: 'row-t1', callsBeforeRow: ['toolu_made_up_c1'], keys: [], read: '40 rows', columns: ['run', 'status'], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_c1: { version: 1, title: 'Runs by status', file: 'runs.json', read: '40 rows' } }, at: 1 }),
  })
  const step = async (k: string) => {
    expect(await $.prompt.edit(key(k))).toEqual({ text: '', cursor: 0 })
    return textOf(await $.ui.render(above()))
  }
  // from rest, ] opens the citation above the card, and names the card as the next stop
  let band = await step(']')
  expect(band).toContain('12 of 40')
  expect(band).toContain('] next card')
  // ] reaches the card under the first paragraph, which takes the keys
  band = await step(']')
  expect(band).toContain('a ask · ] next citation · 0 back')
  // ] goes on to the citation under the card, the last stop; [ goes back through the card to the first citation
  band = await step(']')
  expect(band).toContain('41 s')
  expect(band).toContain('[ previous card')
  band = await step('[')
  expect(band).toContain('a ask · ] next citation · 0 back')
  band = await step('[')
  expect(band).toContain('12 of 40')
  expect(band).toContain('] next card')
})
