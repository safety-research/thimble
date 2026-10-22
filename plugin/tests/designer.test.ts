// v at an empty prompt (designer/v.ts), through the whole hooks module: v spawns the designer fork with designer.md
// once the word window has passed; v and then a letter in the window gives the word back and spawns nothing; v with no
// answer yet is a letter. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any, o: { unreadable?: number } = {}) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', PATH: '/usr/bin', TMPDIR: '/made-up/tmp' })
  const clock = mock.clock(on, { now: 1000 })
  const spawns: Any[] = []
  let unreadable = o.unreadable ?? 0
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/designer.md') && unreadable > 0) { unreadable--; throw new Error('made-up: the file cannot be read') }
    return { value: promptStub(e.path) ?? '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-made-up', agentId: `agent-${spawns.length}` } as never })
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  return { clock, spawns }
}

async function start($: Any) {
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true })
}

/** Main answers: its text row, as session.append stores it. */
async function answer($: Any) {
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The revert undid a change that broke the build.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-answer-1' })
}

const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

const press = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k })

test('v at an empty prompt spawns the designer fork with designer.md once the word window has passed', async ($, on) => {
  const w = world(on)
  await start($)
  await answer($)
  const r = (await $.prompt.edit(press('v') as never)) as Any
  expect(r.text).toBe('')
  await w.clock.advance(100)
  expect(w.spawns.length).toBe(0)
  await w.clock.advance(300)
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].prompt).toBe('PROMPT designer')
  expect(w.spawns[0].description).toBe('card of the last answer (v)')
})

test('v and then a letter within the word window gives the word back and spawns nothing', async ($, on) => {
  const w = world(on)
  await start($)
  await answer($)
  await $.prompt.edit(press('v') as never)
  await w.clock.advance(120)
  const r = (await $.prompt.edit(press('e') as never)) as Any
  expect(r.text).toBe('ve')
  expect(r.cursor).toBe(2)
  await w.clock.advance(1000)
  expect(w.spawns.length).toBe(0)
})

test('v before any answer is a letter', async ($, on) => {
  const w = world(on)
  await start($)
  const r = (await $.prompt.edit(press('v') as never)) as Any
  expect(r.text).toBe('v')
  await w.clock.advance(1000)
  expect(w.spawns.length).toBe(0)
})

test('a v whose prompt cannot be made types v, says why, and the next v works', async ($, on) => {
  const w = world(on, { unreadable: 1 })
  await start($)
  await answer($)
  const r = (await $.prompt.edit(press('v') as never)) as Any
  expect(r.text).toBe('v')
  expect(textOf(await $.ui.render(BAND))).toContain('The v key did not run')
  await w.clock.advance(1000)
  expect((await $.prompt.edit(press('v') as never) as Any).text).toBe('')
  await w.clock.advance(400)
  expect(w.spawns.length).toBe(1)
})
