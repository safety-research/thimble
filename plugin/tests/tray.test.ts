// The cite and explain tray (tray/): ] at an empty prompt opens it on the acting answer's first citation, which draws in
// focus; its card shows the check and the evidence, its keys show in the bar; a press on a citation opens it too; a
// question typed with it open carries the citation's scope to Claude, shows `▸ about …` under the prompt, and closes
// the tray; 0 closes it. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { CITE_TINT } from '../marks/evidence'
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

/** A resumed session with one answer, TEXT, whose citation the check left as `item`; `more`: the turn's cards, the
 *  message's parts and kept files to add (a card's meta.json under cards/<id>/). */
async function resumed($: Any, on: Any, item: Any, session = 's-tray', more: { cards?: Any[]; parts?: Any; kept?: Record<string, string> } = {}): Promise<{ submitted: Any[]; clock: Any }> {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  const submitted: Any[] = []
  on('session.id', () => ({ value: session }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const kept: Record<string, string> = {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: [item] }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: more.cards ?? [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: TEXT, at: 1, ...(more.parts ? { parts: more.parts } : {}) }] }),
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
  // the value in the soft tint, the place dim
  const drawnBand = all(await $.ui.render(above()))
  expect(drawnBand.some(n => n.type === 'Text' && n.props?.backgroundColor === CITE_TINT.dark && textOf(n) === '12')).toBe(true)
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'runs/summary.txt:4')?.props).toMatchObject({ dimColor: true })
  expect(band).toContain('a ask')
  expect(band).toContain('0 close')
  expect(band).not.toContain('v card')
  // the citation draws in focus in the answer
  const drawn = await $.ui.render(answer('row-t1', TEXT))
  const cite = all(drawn).find(n => n.type === 'Button' && String(n.props?.label).startsWith('citation 1'))
  expect(all(cite).some(n => n.type === 'Text' && n.props?.backgroundColor === 'selectionBg' && textOf(n) === '12 of 40')).toBe(true)

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
  // the corrected words draw as a settled citation: purple, underlined
  const drawn = all(await $.ui.render(answer('row-t1', TEXT)))
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === '11 of 40')?.props).toMatchObject({ color: 'merged', underline: true })
  expect(textOf(drawn)).not.toContain('corrected')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let drawnBand = all(await $.ui.render(above()))
  let band = textOf(drawnBand)
  // the header's status, what it was under it (no reason), the code line that printed the value, its output line
  expect(band).toContain('✓ corrected · cite')
  expect(band).toContain('was 12 of 40')
  expect(band).not.toContain('The output says 11')
  expect(band).toContain('print(f"failed: {bad}")│failed: 11')
  expect(band).not.toContain('runs: 40')
  expect(band).not.toContain('print("runs:", n)')
  expect(drawnBand.find(n => n.type === 'Text' && textOf(n) === 'print(f"failed: {bad}")')?.props?.color).toBe('#9cdcfe')
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
  expect(band).toContain('c one line')
  expect(band).not.toContain('Output of the code')
  expect(band).not.toContain('The code')
  expect(all(open).some(n => n.type === 'Text' && n.props?.backgroundColor === CITE_TINT.dark && textOf(n) === '11')).toBe(true)
  // c again: back to the one line
  await clock.advance(2000)
  await $.prompt.edit(key('c'))
  band = textOf(await $.ui.render(above()))
  expect(band).not.toContain('runs: 40')
  expect(band).toContain('failed: 11')
})

test('a wrong citation: × wrong in the header, why in one dim sentence under it, then its evidence', async ($, on) => {
  await resumed($, on, { ...QUOTED, status: 'failed', failedBy: 'check', reason: 'Line 4 counts 12 failed, but 3 were retried. The rest passed.' }, 's-tray-5')
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  const drawn = all(await $.ui.render(above()))
  const band = textOf(drawn)
  expect(band).toContain('× wrong · cite')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === '× wrong')?.props?.color).toBe('error')
  expect(drawn.find(n => n.type === 'Text' && textOf(n) === 'Line 4 counts 12 failed, but 3 were retried.')?.props).toMatchObject({ dimColor: true })
  expect(band).not.toContain('The rest passed')
  expect(band).toContain('failed: 12')
})

test('] stops on a card Claude drew inline, where it stands in the answer: here before the words, so first; a asks about it', async ($, on) => {
  const id = 'c0123456789ab'
  const meta = { id, version: 1, title: 'Runs by status', toolUseId: 'toolu_made_up_1', turn: 't1', agentId: null, anchorRow: null, keys: [], read: '2 rows', columns: [], file: 'runs.json', gen: 1, error: null, calls: { toolu_made_up_1: { version: 1 } }, at: 1 }
  await resumed($, on, QUOTED, 's-tray-3', {
    cards: [{ id, toolUseId: 'toolu_made_up_1', seq: 1, after: 0 }],
    kept: { [`cards/${id}/meta.json`]: JSON.stringify(meta) },
  })
  // ]: the card above the words, which takes the keys (a ask, 0 back); no tray
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  let band = textOf(await $.ui.render(above()))
  expect(band).toContain('a ask')
  expect(band).toContain('0 back')
  expect(band).toContain('] next citation')
  expect(band).not.toContain('failed: 12')
  // ] again: the citation in the words under it
  expect(await $.prompt.edit(key(']'))).toEqual({ text: '', cursor: 0 })
  band = textOf(await $.ui.render(above()))
  expect(band).toContain('failed: 12')
  expect(band).toContain('[ previous card')
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
