// Where the features that act on answers draw (core/answerview.ts, marks/view.ts, marks/register.ts): a feature's spans
// on a row's words, checked and drawn; the margin that asks a side thread about a passage; the answer the person
// picked with { drawn with ▸; and the features' keys, which no card takes. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { checkSpans, restoredKeys, type Span } from '../core/answerview'
import { ownKeys } from '../hooks/keys'
import { marksIn } from '../marks/message.js'
import { messageEl } from '../marks/view'
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

test('spans are kept on plain words, inside one citation or over a whole one, never across part of one or over another; the focused one looks focused', () => {
  const marks = marksIn(TEXT)
  const at = (w: string, from = 0) => TEXT.indexOf(w, from)
  const span = (id: string, start: number, len: number): Span => ({ id, start, end: start + len, look: TEAL, focus: { backgroundColor: '#4fc3b2' }, label: `explain ${id}` })
  const given = [
    span('a', at('hydrate'), 7),
    span('b', at('user query'), 10),
    span('c', at('until [the'), 10), // across the citation's link syntax
    span('d', at('hydrate') + 2, 3), // over span a
    span('e', TEXT.length - 2, 9), // past the end
    span('f', at('until [the'), '[the user query ends](#)'.length + 6), // over the whole citation
  ]
  const kept = checkSpans(given, TEXT, marks, 'b')
  expect(kept.map(s => s.id)).toEqual(['a', 'b'])
  expect(checkSpans([given[5]], TEXT, marks, null).map(s => TEXT.slice(s.start, s.end))).toEqual(['until [the user query ends](#)'])
  expect(kept[1]!.look.backgroundColor).toBe('#4fc3b2')
  expect(checkSpans('not a list', TEXT, marks, null)).toEqual([])
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

test('a key at an empty prompt reads no state once the plugin has read it: its hook has a few milliseconds of its own time', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-keys' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  // what Claude Code's box does with a key thimble does not take: types it
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text}${e.inputText}`, cursor: e.text.length + e.inputText.length }))
  let gets = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { gets++; return next(e) })
  const press = (key: string) => $.prompt.edit({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key } as never)
  // the first key reads what the keys need; a letter no one takes then reads nothing, nor does c (its pane opens later)
  expect(await press('h')).toEqual({ text: 'h', cursor: 1 })
  expect(gets).toBeGreaterThan(0)
  gets = 0
  expect(await press('q')).toEqual({ text: 'q', cursor: 1 })
  expect(gets).toBe(0)
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
  expect(band).not.toContain('answer 1 of 2')
  await turn('t3', 'You are welcome.')
  expect(textOf(await $.ui.render(answer('row-t1', 'The revert undid a change.')))).toBe('the engine')
})

