// Where thimble's drawing does not show (core/host.ts drawsHere: Claude Code runs without its terminal interface, as in
// the desktop app's Code tab, remote Cowork and claude -p), Citations and Cards act as off, as if the person had set
// them off (settings/features.mjs UNDRAWN): the guidance leaves out their sections, and the citations in its other
// examples read as plain words; no card tool is registered; and no check starts after a reply. In the terminal, all is
// as before. The SDK host here starts the session as `claude -p` with CLAUDE_CODE_ENTRYPOINT=sdk-cli does: no surface,
// not interactive. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { promptStub, tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const GUIDANCE = [
  'thimble is on in this folder. A made-up opening.',
  '',
  '## Communicating',
  '',
  'Answer first: [12 of 40](#) runs failed.',
  '',
  '## Citing claims',
  '',
  'Cite a claim as [words](#).',
  '',
  '## Cards',
  '',
  'Draw a card with the `card` tool.',
  '',
  '## Labels',
  '',
  'Sort records with a label: [7 of 30](#) tickets.',
  '',
].join('\n')

const REPLY = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#).'

/** How Claude Code starts the session: in its terminal interface, or as an SDK host runs it. */
const TERMINAL = { env: {}, start: { cwd: '/made-up/data', surface: 'terminal', isInteractive: true } }
const SDK = { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, start: { cwd: '/made-up/data', surface: null, isInteractive: false } }

/** A session started on `host`: the tools thimble registers, the context each prompt carried, and the agents thimble
 *  spawned. */
async function session($: Any, on: Any, host: typeof TERMINAL | typeof SDK) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', ...host.env })
  const clock = mock.clock(on, { now: 0 })
  const w = { clock, tools: [] as string[], context: [] as string[][], spawns: [] as Any[], messages: [] as Any[] }
  on('session.id', () => ({ value: 's-host' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: w.messages }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/prompts/guidance.md') ? GUIDANCE : e.path.endsWith('/prompts/checker.md') ? 'CHECK\n{{MARKS}}' : promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('config.list', () => ({ value: [] }))
  on('tool.register', (_$: unknown, e: { name: string }) => { w.tools.push(e.name); return { value: { tool: `mcp__thimble__${e.name}` } } })
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }) as never)
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { exitCode: 0, stdout: '', stderr: '', ...(tempRun(e.argv) ?? {}), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', (_$: unknown, e: Any) => { w.spawns.push(e); return { model: 'claude-made-up', agentId: `agent-${w.spawns.length}` } as never })
  on('agent.list', () => ({ value: w.spawns.map((_e, i) => ({ id: `agent-${i + 1}`, status: 'running', description: 'x', type: 'fork' })) }))
  on('tool.check', () => ({ decision: 'ask' }) as never)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  // the engine: the prompt enters with its context, which the next request holds after it
  on('prompt.submit', (_$: unknown, e: Any) => {
    const context = [...(e.context ?? [])]
    w.context.push(context)
    w.messages.push({ role: 'user', content: [{ type: 'text', text: e.text }, ...context.map(c => ({ type: 'text', text: `<system-reminder>\n${c}\n</system-reminder>` }))] })
    return { text: e.text, context }
  })
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start(host.start as never)
  return w
}

/** The person's question, and main's reply with citations: the guidance the prompt carried. */
async function ask($: Any, w: Any): Promise<string> {
  await $.prompt.submit({ text: 'How many runs failed?', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'How many runs failed?', turnId: 't1' } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: REPLY }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: REPLY, durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  expect(w.context[0]).toHaveLength(1)
  return w.context[0][0]
}

/** The checks of citations thimble started: its forks by their description, as a host lists them. */
const checks = (w: Any) => w.spawns.filter((s: Any) => s.description === 'checking citations')

test("in an SDK host's session, Citations and Cards act as off: the guidance has no Citing claims or Cards section and its examples' citations read as plain words, no card tool is registered, and no check starts after a reply", { options: { citations: 'auto cite + verify', cards: 'auto' } }, async ($, on) => {
  const w = await session($, on, SDK)
  expect(w.tools).not.toContain('card')
  const guidance = await ask($, w)
  expect(guidance).not.toContain('## Citing claims')
  expect(guidance).not.toContain('## Cards')
  expect(guidance).not.toContain('](#)')
  expect(guidance).toContain('Answer first: 12 of 40 runs failed.')
  expect(guidance).toContain('## Labels')
  expect(checks(w)).toHaveLength(0)
})

test("in an SDK host's session, Citations manual and Cards on demand act as off too: the guidance says nothing of when citations or cards come", { options: { citations: 'manual', cards: 'on demand' } }, async ($, on) => {
  const w = await session($, on, SDK)
  expect(w.tools).not.toContain('card')
  const guidance = await ask($, w)
  expect(guidance).not.toContain('## Cards')
  expect(guidance).not.toContain('Draw a card only')
  expect(guidance).not.toContain('These come only')
})

/** The sentence of main's guidance on the comments that come only when the analyst asks, with their keys. */
const ASKED = 'These come only when the analyst asks: explainers (e).'

for (const [who, options] of [
  ['Explainers on demand', { explain: 'on demand' }],
  ['the rows of a Minimal saved by 0.10.4 to 0.10.7, which a session there does not move', { minimal: true, citations: 'manual', explain: 'on demand', details: 'on demand', claimsMode: 'on demand' }],
] as const) {
  test(`in an SDK host's session, ${who}: Explainers act as off too, since no key reaches thimble there, and the guidance names no key for them`, { options }, async ($, on) => {
    const w = await session($, on, SDK)
    const guidance = await ask($, w)
    expect(guidance).not.toContain('These come only')
    expect(guidance).not.toContain('(e)')
  })
}

test('in the terminal, Explainers on demand: the guidance says they come when the analyst asks, by their key', { options: { explain: 'on demand' } }, async ($, on) => {
  const w = await session($, on, TERMINAL)
  expect((await ask($, w)).endsWith(ASKED)).toBe(true)
})

test("in the terminal, all is as before: the guidance keeps the Citing claims and Cards sections with their citations, the card tool is registered, and a check starts after a reply", { options: { citations: 'auto cite + verify', cards: 'auto' } }, async ($, on) => {
  const w = await session($, on, TERMINAL)
  expect(w.tools).toContain('card')
  const guidance = await ask($, w)
  expect(guidance).toBe(GUIDANCE.trim())
  expect(checks(w)).toHaveLength(1)
  expect(String(checks(w)[0].prompt)).toContain('[12 of 40]')
})
