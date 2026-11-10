// The keys that act on Claude's answers (core/answerview.ts restoredKey): thimble takes neither { nor }, so at an empty
// prompt each types as any other character does, and every answer keeps Claude Code's own drawing. All data is made
// up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

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
const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } }) as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never

test('{ and } at an empty prompt type into the box, with two answers or more, and no answer is marked', async ($, on) => {
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
  // what the box holds once a key is typed
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
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
  // { and } each go into the box, at an empty prompt, as the person typed them
  for (const k of ['{', '}']) {
    expect(await $.prompt.edit(key(k))).toEqual({ text: k, cursor: 1 })
    await clock.advance(1000)
  }
  // no answer is marked: both stay Claude Code's own drawing
  expect(textOf(await $.ui.render(answer('row-t1', 'The revert undid a change.')))).toBe('the engine')
  expect(textOf(await $.ui.render(answer('row-t2', 'Two runs failed.')))).toBe('the engine')
  // the bar names s (squeeze/seam.ts), which acts on the last answer
  const band = textOf(await $.ui.render({ plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never))
  expect(band).toContain('thimble')
  expect(band).toContain('s simplify')
})
