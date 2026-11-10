// The tour on a Claude Code older than the one it needs (tour/tour.ts TOUR_CLAUDE_CODE: 2.1.314, the first that places
// its rows with $.ui.place). thimble runs on such a Claude Code, and the tour says at once that it needs a newer one,
// instead of starting: /thimble:tour does not enter, and the person reads why; Claude's Skill call is refused with why;
// the skill expanded another way (the first prompt of `thimble tour`) asks Claude to say why. On 2.1.314 /thimble:tour
// enters as ever. These tests answer no ui.place, so they run on every Claude Code thimble runs on. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { TOO_OLD } from '../tour/tour'
import { test } from './kit'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A session on Claude Code `version`: the prompts, tool calls and skill prompts that reach the bottom. */
async function session($: Any, on: Any, version: string) {
  const got = { prompts: [] as string[], tools: [] as string[], skills: [] as string[] }
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  on('session.version', () => ({ value: { version, base: version } }))
  on('session.id', () => ({ value: 's-tour-old' }))
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
  on('ui.panes', () => ({ value: [] }) as never)
  on('config.list', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => { got.prompts.push(String(e.text)); return { text: e.text } })
  on('tool.call', (_$: unknown, e: Any) => { got.tools.push(String(e.tool)); return { result: `ran ${e.tool}` } })
  on('skill.prompt', (_$: unknown, e: Any) => { got.skills.push(String(e.text)); return { text: e.text } })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  return got
}

const tour = ($: Any) => $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)

test('on Claude Code 2.1.311, /thimble:tour does not enter and says that the tour needs 2.1.314, Claude\'s Skill call is refused with why, and the skill expanded another way asks Claude to say why', async ($, on) => {
  const got = await session($, on, '2.1.311')
  expect(TOO_OLD).toBe('The tour needs Claude Code 2.1.314 or later: update it (claude update), then type /thimble:tour again.')
  expect(await tour($)).toEqual({ drop: TOO_OLD })
  expect(got.prompts).toEqual([])
  expect(await $.tool.call({ tool: 'Skill', skill: 'thimble:tour', tool_use_id: 'toolu_made_up_1' } as never)).toEqual({ deny: TOO_OLD })
  expect(got.tools).toEqual([])
  await $.skill.prompt({ skill: 'tour', text: 'The tour skill, as written.', frontmatter: {}, source: 'plugin' } as never)
  expect(got.skills).toEqual([`Reply with this sentence alone: ${TOO_OLD}`])
  // another skill, and the person's own prompt, enter as ever
  await $.prompt.submit({ text: 'Which orders were refunded?', origin: { kind: 'composer' } } as never)
  expect(got.prompts).toEqual(['Which orders were refunded?'])
})

test('on Claude Code 2.1.314, and on a development build of it, /thimble:tour enters as ever', async ($, on) => {
  const got = await session($, on, '2.1.314-dev.20261030.t101500.sha1a2b3c4')
  const r = await tour($)
  expect(r.drop).toBeUndefined()
  expect(got.prompts).toEqual(['/thimble:tour'])
})
