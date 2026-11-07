// The ask before a large label run (labels/use.ts): Claude reads the ask after its command and asks the person with
// Claude Code's question tool; their answer there runs as the person, and Claude reads what it started. The labels
// pane's own run (labels/edit.ts) asks the person at once. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { rerunLabel } from '../labels/edit'
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

/** An engine for the labels pane's rerun alone (labels/edit.ts): its state, a kernel that answers the rerun of the label
 *  `spam` with `rerun` (its --json) and writes `ask`'s line in the person's feed when given, then the person's choice
 *  with a sample; and Claude Code's question dialog, which picks the choice at `pick`. What ran and what was asked. */
function rerunEngine(rerun: Any, ask: Any | null, pick: number): { $: Any; ran: string[][]; asked: Any[] } {
  const state = new Map<string, unknown>()
  const ran: string[][] = []
  const asked: Any[] = []
  let feed = ''
  const isFeed = (path: string) => /\/events\/[^/]+\.jsonl$/.test(path)
  const $ = {
    env: { get: async (name: string) => ({ THIMBLE_HOME: '/made-up/th', THIMBLE_ROOT: '/made-up/data' } as Any)[name] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-rerun', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    fs: {
      exists: async () => false,
      stat: async (path: string) => (isFeed(path) ? { kind: 'file', size: new TextEncoder().encode(feed).length } : { kind: 'missing', size: 0 }),
      read: async (path: string) => (isFeed(path) ? feed : ''),
      write: async () => undefined,
    },
    state: { get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }), set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } } },
    ui: {
      invalidate: () => undefined,
      ask: async (question: string, o: Any) => { asked.push({ question, ...o }); return o.options[pick] },
    },
    // what runs a moment later runs at once; a wait never ends
    clock: { now: async () => 0, after: (ms: number, fn: () => void) => { if (!ms) void Promise.resolve().then(fn); return { cancel() {} } } },
    process: {
      run: async (argv: string[]) => {
        const a = argv.slice(1)
        ran.push(a)
        let out: unknown = []
        if (a.includes('--answer')) out = { name: 'spam', choice: 'sample', reads: 300, of: 420, waiting: 300 }
        else if (a.includes('--prompt')) {
          if (ask) feed += `${JSON.stringify(ask)}\n`
          out = rerun
        }
        return { exitCode: 0, stdout: JSON.stringify(out), stderr: '' }
      },
    },
  }
  return { $, ran, asked }
}

const SPAM = { name: 'spam', kind: 'prompt', rule: 'The message is spam.', in: 'chat.jsonl', values: ['yes', 'no'], model: null, records: 340, matched: 420 }

test('the labels pane applies a sample the ask picked again over its same records: a change of its model reads those, with no ask', async () => {
  resetLabelUse()
  const { $, ran, asked } = rerunEngine({ name: 'spam', records: 340, waiting: 340, counts: {}, run: { state: 'asked', waiting: 340 } }, null, 0)
  expect(await rerunLabel($, '/made-up/data', { ...SPAM, trial: true, limit: null }, { model: 'haiku' })).toBeNull()
  const args = ran.find(a => a.includes('--prompt'))!
  expect(args).toContain('--same-records')
  expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'haiku'])
  expect(args).not.toContain('--limit')
  expect(asked).toEqual([])
  // a change of the records it goes over applies it over those
  ran.length = 0
  await rerunLabel($, '/made-up/data', { ...SPAM, trial: true, limit: null }, { in: 'chat2.jsonl' })
  expect(ran.find(a => a.includes('--prompt'))).not.toContain('--same-records')
})

test("a large run the person starts in the labels pane: they are asked at once in Claude Code's question dialog, each choice with its cost on the label's model; their choice runs as theirs, and Claude reads it with their next prompt", async () => {
  resetLabelUse()
  const ask = { kind: 'label_ask', name: 'spam', root: '/made-up/data', ask: 'a7', units: 420, calls: 9, sample: 300, chars: 30000, model: 'haiku', text: 'Read 420 records of chat.jsonl with Claude', meta: '9 model calls', t: 2 }
  const { $, ran, asked } = rerunEngine({ name: 'spam', records: 420, waiting: 420, counts: {}, run: { state: 'ask', ask: { id: 'a7' }, waiting: 420 } }, ask, 1)
  expect(await rerunLabel($, '/made-up/data', { ...SPAM, trial: false, records: 420 }, { model: 'haiku' })).toBeNull()
  expect(ran.find(a => a.includes('--prompt'))).not.toContain('--same-records')
  expect(asked).toHaveLength(1)
  expect(asked[0].question).toBe('Read 420 records of chat.jsonl with Claude for the label spam?')
  expect(asked[0].options[0]).toMatch(/^Run all · 9 calls to Claude Haiku 5\.5, about 20 s/)
  expect(asked[0].options[1]).toMatch(/^Run on a sample of 300 · 7 calls to Claude Haiku 5\.5/)
  expect(asked[0].options[2]).toBe('Cancel')
  expect(ran.find(a => a.includes('--answer'))).toEqual(['label', 'spam', '--answer', 'sample', '--ask', 'a7'])
  // the ask is the person's: none waits for Claude's question tool, and Claude reads their choice with the next prompt
  expect((await $.state.get({ plugin: 'thimble', key: 'labelAsk' })).value).toBeNull()
  const told = Object.values((await $.state.get({ plugin: 'thimble', key: 'tell' })).value as Record<string, string>).join('\n')
  expect(told).toContain("The analyst chose a random sample of 300 of the label spam's 420 records")
})
