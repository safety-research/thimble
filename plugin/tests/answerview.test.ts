// Where the features that act on answers draw (core/answerview.ts, marks/view.ts, marks/register.ts): a feature's spans
// on a row's words, checked and drawn as presses of their own (inside a citation, with the citation's press); the
// citation the tray shows in focus; a version of the words shown in place of Claude's, its citations looking as the
// checked ones with the same words; the answer the person picked with { drawn with ▸; and the features' items, lines
// and keys left empty by the seams. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { checkSpans, restoredKeys, type Span } from '../core/answerview'
import { ownKeys } from '../hooks/keys'
import { looksByWords } from '../marks/register'
import { marksIn } from '../marks/message.js'
import { messageEl } from '../marks/view'
import type { MarkItem } from '../marks/store'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const el = (type: string) => (props: Any) => ({ type, props })
const ELS = { Box: el('Box'), Text: el('Text'), Button: el('Button'), Markdown: el('Markdown'), Code: el('Code') }
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

const TEAL = { backgroundColor: '#1e4d47' }
const TEXT = 'The page waits on hydrate until [the user query ends](#), then hydrate runs.'

test('spans are kept on plain words or inside one citation, never across one or over another; the focused one looks focused', () => {
  const marks = marksIn(TEXT)
  const at = (w: string, from = 0) => TEXT.indexOf(w, from)
  const span = (id: string, start: number, len: number): Span => ({ id, start, end: start + len, look: TEAL, focus: { backgroundColor: '#4fc3b2' }, label: `explain ${id}` })
  const given = [
    span('a', at('hydrate'), 7),
    span('b', at('user query'), 10),
    span('c', at('until [the'), 10), // across the citation's link syntax
    span('d', at('hydrate') + 2, 3), // over span a
    span('e', TEXT.length - 2, 9), // past the end
  ]
  const kept = checkSpans(given, TEXT, marks, 'b')
  expect(kept.map(s => s.id)).toEqual(['a', 'b'])
  expect(kept[1]!.look.backgroundColor).toBe('#4fc3b2')
  expect(checkSpans('not a list', TEXT, marks, null)).toEqual([])
})

test('a span is a press of its own, highlighted; inside a citation it keeps the citation press and look and adds its fill; the tray\'s citation is bold', () => {
  const marks = marksIn(TEXT)
  const pressed: string[] = []
  const spans = [
    { start: TEXT.indexOf('hydrate'), end: TEXT.indexOf('hydrate') + 7, look: TEAL, label: 'explain hydrate', onPress: () => pressed.push('span') },
    { start: TEXT.indexOf('user query'), end: TEXT.indexOf('user query') + 10, look: TEAL, label: 'explain user query', onPress: () => pressed.push('inner') },
  ]
  const drawn = messageEl(ELS, { text: TEXT, marks, looks: [{ n: 1, status: 'verified' }], key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => pressed.push('mark'), spans, focus: 0 })
  expect(textOf(drawn)).toContain('The page waits on hydrate until the user query ends, then hydrate runs.')
  const buttons = all(drawn).filter(n => n.type === 'Button')
  const own = buttons.find(b => b.props.label === 'explain hydrate')!
  own.props.onPress()
  expect(pressed).toEqual(['span'])
  const inner = buttons.find(b => textOf(b) === 'user query')!
  expect(inner.props.label).toBe('citation 1: the user query ends')
  inner.props.onPress()
  expect(pressed).toEqual(['span', 'mark'])
  const innerText = all(inner).find(n => n.type === 'Text' && n.props.children === 'user query')
  expect(innerText.props).toMatchObject({ backgroundColor: 'selectionBg', bold: true })
  // the span's own words: a highlight, the fill behind them in the text's own color, not underlined (a citation is);
  // inside the citation: the citation's purple, underlined, on the span's fill
  const ownText = all(own).find(n => n.type === 'Text' && n.props.children === 'hydrate')
  expect(ownText.props).toMatchObject({ backgroundColor: '#1e4d47' })
  expect(ownText.props.underline).toBe(undefined)
  expect(ownText.props.color).toBe(undefined)
  const calm = messageEl(ELS, { text: TEXT, marks, looks: [{ n: 1, status: 'verified' }], key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => undefined, spans, focus: null })
  const tinted = all(calm).find(n => n.type === 'Text' && n.props.children === 'user query')
  expect(tinted.props).toMatchObject({ color: 'merged', underline: true, backgroundColor: '#1e4d47' })
  // dim words and the ▸ of an answer picked for the keys
  const dim = messageEl(ELS, { text: 'Two runs failed.', marks: [], looks: [], key: 'd', cols: 100, first: true, spin: '⠋', onMark: () => undefined, dim: true, lead: '▸' })
  expect(textOf(dim)).toContain('▸Two runs failed.')
  expect(all(dim).some(n => n.type === 'Text' && n.props.dimColor && n.props.children === 'Two runs failed.')).toBe(true)
})

test('each passage of a reply drawn here has a margin that asks a side thread about it: ? under the pointer, ↳ once asked', () => {
  const text = 'Two runs [failed](#).\nBoth timed out.\n\n## Why\n\nThe limit is 10 minutes.\n\n- a\n- b'
  const asked: string[] = []
  const has = (p: { label: string }) => p.label === '"a"'
  const drawn = messageEl(ELS, { text, marks: marksIn(text), looks: [{ n: 1, status: 'verified' }], key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => undefined, passages: { has, ask: p => asked.push(p.text) } })
  const buttons = all(drawn).filter(n => n.type === 'Button' && /^(ask about|open the thread about) /.test(n.props.label))
  // a line laid out here, a run of Claude Code's Markdown, a heading with its whole section, and a list whose items
  // stay together
  expect(buttons.map(b => b.props.label)).toEqual(['ask about "Two runs failed."', 'ask about "Both timed out."', 'ask about the section "Why"', 'ask about "The limit is 10 minutes."', 'open the thread about "a"'])
  // the ? shows only while the pointer is over its row, over the reply's ● on its first row
  const first = all(drawn).find(n => n.type === 'Box' && n.props.key === 'k-b0')!
  expect(textOf(first.props.children[0])).toBe('●?')
  const hidden = all(first).find(n => n.type === 'Box' && n.props.display === 'none')!
  expect(hidden.props.hover).toEqual({ display: 'flex' })
  expect(textOf(all(drawn).find(n => n.type === 'Button' && n.props.label.startsWith('open the thread'))!)).toBe('↳')
  buttons[2]!.props.onPress()
  expect(asked).toEqual(['## Why\n\nThe limit is 10 minutes.\n\n- a\n- b'])
  // with no passages, the rows draw as before: Claude Code's ● and no press
  const plain = messageEl(ELS, { text, marks: marksIn(text), looks: [{ n: 1, status: 'verified' }], key: 'k', cols: 100, first: true, spin: '⠋', onMark: () => undefined })
  expect(all(plain).some(n => n.type === 'Button' && /ask about/.test(n.props.label))).toBe(false)
})

test("a version shown in place of Claude's words: its citations look as the checked ones with the same words, others unchecked", () => {
  const items = [
    { n: 1, words: '12 of 40', status: 'corrected', shown: '15 of 40' },
    { n: 2, words: 'June 3', status: 'failed', failedBy: 'evidence', shown: 'June 3' },
  ] as unknown as MarkItem[]
  const marks = marksIn('On [june 3](#), [12  of 40](#) merged; [ten](#) were open.')
  expect(looksByWords(marks, items, false)).toEqual([
    { n: 2, status: 'failed', shown: 'June 3' },
    { n: 1, status: 'corrected', shown: '15 of 40' },
    { n: 0, status: 'unchecked' },
  ])
  expect(looksByWords(marksIn('[ten](#)'), [], true)).toEqual([{ n: 0, status: 'pending' }])
})

test("the features' letters are thimble's own, so no card takes them", () => {
  expect(restoredKeys()).toEqual(['s', 'c', 't'])
  for (const k of restoredKeys()) expect(ownKeys()).toContain(k)
})

const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } }) as never

test('{ at an empty prompt picks the answer before for the keys, drawn with ▸; a new turn gives the keys back', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-answerview' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const turn = async (id: string, text: string) => {
    await $.prompt.submit({ text: `question ${id}`, origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: `question ${id}`, turnId: id } as never)
    await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: `row-${id}` } as never)
    await $.turn.complete({ turnId: id, reason: 'answer', answer: text, durationMs: 10, isAborted: false } as never)
    await clock.advance(100)
  }
  await turn('t1', 'The revert undid a change.')
  await turn('t2', 'Two runs failed.')
  // at rest both answers are Claude Code's own drawing
  expect(textOf(await $.ui.render(answer('row-t1', 'The revert undid a change.')))).toBe('the engine')
  const r = (await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: '{' }, text: '', cursor: 0, start: 0, end: 0, inputText: '{' } as never)) as Any
  expect(r).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(answer('row-t1', 'The revert undid a change.')))).toContain('▸The revert undid a change.')
  expect(textOf(await $.ui.render(answer('row-t2', 'Two runs failed.')))).toBe('the engine')
  // the bar names s (squeeze/seam.ts) once there is an answer
  const band = textOf(await $.ui.render({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never))
  expect(band).toContain('thimble')
  expect(band).toContain('s squeeze')
  await turn('t3', 'You are welcome.')
  expect(textOf(await $.ui.render(answer('row-t1', 'The revert undid a change.')))).toBe('the engine')
})
