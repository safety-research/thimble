// The signs after a reply's citations that say where each one stands (marks/view.ts, marks/register.ts): a citation not
// checked yet has a dim ? after it; one the check corrected has its new words with no sign, as a verified one, and
// nothing under the row: a press on them opens the tray, whose status says corrected and which says what Claude wrote.
// On a resumed session whose replies' citations are kept as their check left them. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'
import { test } from './kit'

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

const TEXT = 'Of the runs, [15 of 40](#) failed, most on the [p95 check](#).'
const at = (w: string) => ({ start: TEXT.indexOf(`[${w}]`), end: TEXT.indexOf(`[${w}]`) + `[${w}](#)`.length })
const view = { columns: 100, rows: 40, isFullscreen: true }
const above = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} }, viewport: view } as never
const answer = { plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: 'row-t1', viewport: view, props: { text: TEXT, isFirstOfReply: true } } as never

/** A resumed session with one answer, TEXT, whose citations the check left as `items`. */
async function resumed($: Any, on: Any, items: Any[]): Promise<void> {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-marksigns' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const kept: Record<string, string> = {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'how many failed?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: TEXT, at: 1 }] }),
  }
  const keptOf = (path: string) => Object.keys(kept).find(k => path.endsWith(`/${k}`))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: keptOf(e.path) ? kept[keptOf(e.path)!] : /\/prompts\/[^/]+\.md$/.test(e.path) ? 'PROMPT' : '' }))
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
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', () => ({ model: 'claude-made-up', agentId: 'agent-check-1' }) as never)
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => ({ text: e.text }))
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
}

/** The sign drawn right after a citation's words (its own Button), or '' when none is drawn there. */
function signAfter(drawn: Any, n: number): { sign: string; props: Any } {
  const runs = all(drawn).filter(x => x.type === 'Button' && String(x.props?.label).startsWith(`citation ${n}:`))
  const last = runs[runs.length - 1]
  const text = textOf(last)
  return /^ [?*×]$/.test(text) ? { sign: text.trim(), props: all(last).find(x => x.type === 'Text')?.props } : { sign: '', props: null }
}

test('with Citations auto cite, a citation not checked yet has a dim ? after it; a checked one has none', { options: { citations: 'auto cite' } }, async ($, on) => {
  await resumed($, on, [
    { n: 1, row: 'row-t1', words: '15 of 40', ...at('15 of 40'), sentence: TEXT, status: 'verified', shown: '15 of 40', reason: 'Counted.' },
    { n: 2, row: 'row-t1', words: 'p95 check', ...at('p95 check'), sentence: TEXT, status: 'deferred', shown: 'p95 check' },
  ])
  const drawn = await $.ui.render(answer)
  expect(textOf(drawn)).toContain('p95 check ?')
  const wait = signAfter(drawn, 2)
  expect(wait.sign).toBe('?')
  expect(wait.props).toMatchObject({ dimColor: true })
  expect(wait.props.color).toBeUndefined()
  expect(signAfter(drawn, 1).sign).toBe('')
})

test('a citation the check corrected has its new words with no sign after them, drawn as a verified one, and nothing under the row; a press on them opens the tray, whose status says corrected and which says what Claude wrote', { options: { citations: 'auto cite + verify' } }, async ($, on) => {
  await resumed($, on, [
    { n: 1, row: 'row-t1', words: '15 of 40', ...at('15 of 40'), sentence: TEXT, status: 'corrected', shown: '12 of 40', was: '15 of 40', reason: 'The summary counts 12 failed runs. It lists each run.' },
    { n: 2, row: 'row-t1', words: 'p95 check', ...at('p95 check'), sentence: TEXT, status: 'verified', shown: 'p95 check' },
  ])
  const drawn = await $.ui.render(answer)
  const words = textOf(drawn)
  // the new words in the reply, no sign after them; the words Claude wrote and the check's reason are not in it
  expect(words).toContain('Of the runs, 12 of 40 failed')
  expect(words).not.toContain('*')
  expect(signAfter(drawn, 1).sign).toBe('')
  expect(signAfter(drawn, 2).sign).toBe('')
  expect(words).not.toContain('15 of 40')
  expect(words).not.toContain('The summary counts')
  // its words look as the verified citation's: underlined in the text's own color, no fill at rest
  const look = (w: string) => { const p = all(drawn).find(x => x.type === 'Text' && textOf(x) === w)?.props ?? {}; return { underline: p.underline, color: p.color, backgroundColor: p.backgroundColor } }
  expect(look('12 of 40')).toEqual(look('p95 check'))
  expect(look('12 of 40')).toEqual({ underline: true, color: undefined, backgroundColor: undefined })
  // a press on its words opens the tray on the citation: its status says corrected, in the color of a checked one, and
  // the line under it what the words were
  const cite = all(drawn).find(x => x.type === 'Button' && String(x.props?.label).startsWith('citation 1:') && textOf(x) === '12 of 40')
  expect(cite).toBeDefined()
  expect(textOf(await $.ui.render(above))).not.toContain('was 15 of 40')
  const ui = await $.ui.mount(answer)
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  const tray = await $.ui.render(above)
  const band = textOf(tray)
  expect(band).toContain('✓ corrected')
  expect(band).not.toContain('verified')
  expect(band).toContain('was 15 of 40')
  expect(band).not.toContain('corrected; was')
  expect(all(tray).find(x => x.type === 'Text' && textOf(x) === ' corrected')?.props).toMatchObject({ color: 'success' })
})

test('a narrowed citation keeps its words and has no sign; its tray says corrected, and that it was narrowed from what Claude cited', { options: { citations: 'auto cite + verify' } }, async ($, on) => {
  await resumed($, on, [
    { n: 1, row: 'row-t1', words: '15 of 40', ...at('15 of 40'), sentence: TEXT, status: 'corrected', shown: '15', narrowed: true, was: '15 of 40', reason: 'The summary counts 15.' },
    { n: 2, row: 'row-t1', words: 'p95 check', ...at('p95 check'), sentence: TEXT, status: 'verified', shown: 'p95 check' },
  ])
  const drawn = await $.ui.render(answer)
  expect(signAfter(drawn, 1).sign).toBe('')
  const cite = all(drawn).find(x => x.type === 'Button' && String(x.props?.label).startsWith('citation 1:'))
  const ui = await $.ui.mount(answer)
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  const band = textOf(await $.ui.render(above))
  expect(band).toContain('✓ corrected')
  expect(band).toContain('narrowed; was 15 of 40')
})
