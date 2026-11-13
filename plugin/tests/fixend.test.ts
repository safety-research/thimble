// A fix's end in the conversation, with the whole hooks module in one session: what came of a fixer's check reaches
// Claude Code as a row placed in the transcript ($.ui.place), drawn as a box with the keys that act on it, beside the
// line above the bar, so the person sees that it is done where they read. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const HOME = '/made-up/.thimble'

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

test("a fix checked while no session waited shows at the session's start as a box in the transcript, with its keys", async ($, on) => {
  mock.env(on, { THIMBLE_HOME: HOME, HOME: '/made-up/home', PATH: '/usr/bin', TMPDIR: '/made-up/tmp' })
  const clock = mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-fixend' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true } }))
  on('command.register', (_$: unknown, e: Any) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  // the lines Claude Code puts in the transcript, and those it keeps for the debug log
  const logs: { text: string; to: string }[] = []
  on('ui.log', (_$: unknown, e: Any) => { logs.push({ text: String(e.text), to: String(e.to) }); return { value: undefined } })
  const placed: string[] = []
  on('ui.place', (_$: unknown, e: Any) => { placed.push(String(e.id)); return { value: { isPlaced: true, requestId: `r-${e.id}` } } })
  // the kernel: one fix of this session's, ready, whose outcome no session showed yet
  const fix = { id: 1, title: 'Bar says read for coverage', words: ["make the bar's coverage item say read"], rounds: 1, made_in: 'terminal', created: 1761200000, state: 'ready', unshown: true, session: 's-fixend', work: `${HOME}/fixes/work/1`, commit: 'c0ffee1', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }], tests: 'passed', summary: 'The bar says r read 14%.', error: null }
  const ok = (out: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const i = e.argv.indexOf('fix')
    if (i >= 0 && e.argv[i + 1] === 'list') return ok({ fixes: [fix], on: true, live: `${HOME}/fixes/live`, version: '1.2.0', count_on: 0, pointed: false, due: null })
    if (i >= 0 && e.argv[i + 1] === 'shown') { fix.unshown = false; return ok(fix) }
    return ok({})
  })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(100)
  expect(placed.length).toBe(1)
  expect(logs.filter(l => l.to === 'transcript' && l.text.includes('Bar says read for coverage'))).toEqual([])
  const box = (await $.ui.render({ plugin: 'thimble', component: 'Placed', surface: 'terminal', requestId: `r-${placed[0]}`, viewport: { columns: 110, rows: 40, isFullscreen: true }, props: { id: placed[0], plugin: 'thimble' } } as never)) as Any
  expect(box.props.borderStyle).toBe('round')
  expect(textOf(box)).toBe('✓ thimble fixed: Bar says read for coverage · tests pass  y use it now · d what changed · n later')
})
