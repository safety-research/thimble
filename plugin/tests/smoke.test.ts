// The whole hooks module in one session: it loads, a session starts, a prompt goes through, and the line above the
// prompt draws, with a failure line on it, without throwing. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

function world(on: Any) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-smoke' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  // a folder of data (made up) whose coverage cannot be counted: the bar's failure line says so
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path === '/made-up/data/thimble/labels' }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: e.argv.includes('coverage')
    ? { exitCode: 1, stdout: '', stderr: 'a made-up reason', isStdoutTruncated: false, isStderrTruncated: false }
    : { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  return { clock }
}

test('the module loads, a session starts, a prompt goes through, and the bar draws', async ($, on) => {
  const w = world(on)
  // the bar shows from the start, and its first drawing counts the folder
  expect(textOf(await $.ui.render(BAND))).toContain('thimble')
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const r = (await $.prompt.submit({ text: 'How many runs failed?' } as never)) as Any
  expect(r.text).toBe('How many runs failed?')
  // the count after the start failed: its line, with the keys that fix or report it
  await w.clock.advance(100)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('thimble')
  expect(line).toContain('f fix this')
  expect(line).toContain('F report only')
})
