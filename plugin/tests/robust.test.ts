// What fails safe on the answers' paths: the three ui.render hooks on AssistantMessage (core/rowhook.ts), each of which
// answers the drawing beneath it when its own drawing throws, asking for it once; and a paste into the empty prompt,
// which asks the cards about its first key alone (hooks/keys.ts), so the prompt.edit hook keeps within its short budget
// whatever the paste's length. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { askOnce } from '../core/rowhook'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

test('a row hook whose drawing throws answers the drawing beneath, asked once, whether it asked before the throw or not', async () => {
  const asks: Any[] = []
  const next = async (x: Any) => { asks.push(x); return { type: 'Text', children: [`beneath ${x.props.text}`] } }
  const e = { props: { text: 'An answer.' } }
  // the hook's pattern (core/rowhook.ts): its drawing in a try, the drawing beneath on a throw
  const hook = async (draw: (below: (x?: Any) => Promise<Any>) => Promise<Any>) => {
    const below = askOnce(e, next)
    try { return await draw(below) } catch { return below() }
  }
  // it asked for the drawing beneath with its own text, then threw: that drawing stands, and beneath ran once
  const after = await hook(async below => { await below({ ...e, props: { text: 'A version.' } }); throw new Error('made-up') })
  expect(after.children).toEqual(['beneath A version.'])
  expect(asks.length).toBe(1)
  // it threw before asking: the drawing beneath, asked once
  asks.length = 0
  const before = await hook(async () => { throw new Error('made-up') })
  expect(before.children).toEqual(['beneath An answer.'])
  expect(asks.length).toBe(1)
  // it asks twice: one drawing beneath
  asks.length = 0
  await hook(async below => { await below(); return below() })
  expect(asks.length).toBe(1)
})

test('a paste into the empty prompt asks the cards about its first key alone, and is typed whole', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  mock.clock(on, { now: 0 })
  let reads = 0
  on('state.get', async (_$: unknown, e: Any, next: Any) => { reads++; return next(e) })
  on('session.id', () => ({ value: 's-robust' }))
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
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const paste = 'Start this in the background and reply with two short paragraphs about what the README says the dataset is.'
  const at = reads
  const r = (await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: paste } as never)) as Any
  expect(r).toEqual({ text: paste, cursor: paste.length })
  // a key's owner is a few reads; one per letter of the paste was over a hundred
  expect(reads - at).toBeLessThan(10)
})
