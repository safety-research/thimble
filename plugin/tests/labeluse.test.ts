// The ask before a large label run (labels/use.ts): Claude reads the ask after its command and asks the person with
// Claude Code's question tool; their answer there runs as the person, and Claude reads what it started. All data is
// made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { resetLabelUse } from '../labels/use'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

test("a large label run: Claude reads the ask after its command, as the question tool's input; the person's answer there runs as the person, and Claude reads what it started", async ($, on) => {
  resetLabelUse()
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', THIMBLE_ROOT: '/made-up/data' })
  const clock = mock.clock(on, { now: 0 })
  const ran: string[][] = []
  const ev = { kind: 'label_ask', name: 'spam', root: '/made-up/data', ask: 'a1', units: 420, calls: 9, sample: 300, text: 'Read 420 records of chat.jsonl with Claude', meta: '9 model calls', t: 1 }
  // the kernel's change feed: the ask's line, once Claude's command wrote it
  let feed = ''
  const isFeed = (path: string) => /\/events\/[^/]+\.jsonl$/.test(path)
  on('session.id', () => ({ value: 's-labeluse' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: isFeed(e.path) ? feed : '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_$: unknown, e: { path: string }) => ({ value: isFeed(e.path) ? { kind: 'file', size: new TextEncoder().encode(feed).length, mtimeMs: 0, isLink: false } : { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }))
  on('env.set', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv.slice(1))
    const out = e.argv.includes('--answer') ? '{"name": "spam", "choice": "sample", "reads": 300, "of": 420, "waiting": 300}' : '[]'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  // the kernel writes the ask's line in the feed while Claude's command runs
  on('tool.call', async (_$: unknown, e: Any) => {
    if (e.tool === 'Bash' && /--prompt/.test(e.command)) feed += `${JSON.stringify(ev)}\n`
    if (e.tool === 'AskUserQuestion') return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Run on a sample of 300' } } } as never
    return { result: 'Not started' } as never
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(100)
  // the command that made the ask: Claude reads the question to ask, with each choice's cost
  const r = await $.tool.call({ tool: 'Bash', command: 'thimble label spam --in chat.jsonl --prompt "The message is spam."' } as never) as Any
  const told = String((r.context ?? []).join('\n'))
  expect(told).toContain('Ask them now with AskUserQuestion')
  const input = JSON.parse(told.slice(told.indexOf('{')))
  expect(input.questions[0].question).toBe('Read 420 records of chat.jsonl with Claude for the label spam?')
  expect(input.questions[0].options).toEqual([
    { label: 'Run all', description: '9 calls to Claude Sonnet 5.5, about 20 s' },
    { label: 'Run on a sample of 300', description: '7 calls to Claude Sonnet 5.5, about 10 s' },
    { label: 'Cancel', description: 'reads none' },
  ])
  // the person answers Claude's question: their choice runs as their own command, and Claude reads what it started
  const answered = await $.tool.call({ tool: 'AskUserQuestion', ...input } as never) as Any
  expect(ran.find(a => a.includes('--answer'))).toEqual(['label', 'spam', '--answer', 'sample', '--ask', 'a1'])
  const note = String((answered.context ?? []).join('\n'))
  expect(note).toContain('random sample of 300 of the label spam\'s 420 records')
  expect(note).toContain('`thimble label spam --wait` waits for them and prints the label\'s counts')
  // Claude runs the label again, a new ask for the rest; a question of Claude's about something else runs no choice
  feed += `${JSON.stringify({ ...ev, ask: 'a2', units: 120, sample: 0, rest: true })}\n`
  await $.tool.call({ tool: 'Bash', command: 'thimble label spam' } as never)
  const n = ran.length
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which file first?', header: 'File', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }] } as never)
  expect(ran.slice(n).some(a => a.includes('--answer'))).toBe(false)
})
