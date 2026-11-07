// v at an empty prompt and the designer fork it starts (designer/v.ts), through the whole hooks module: v spawns the
// designer fork with designer.md once the word window has passed; an answer with Claude's messages after it is quoted in
// the fork's prompt. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', PATH: '/usr/bin', TMPDIR: '/made-up/tmp' })
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 1, stdout: '', stderr: 'made-up: no such command' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  const clock = mock.clock(on, { now: 1000 })
  const spawns: Any[] = []
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
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

test("v on an answer that Claude wrote other messages after (the tour's steps, say) quotes that answer in the fork's prompt, so the fork does not draw the newest message", async ($, on) => {
  const w = world(on)
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  await start($)
  const turn = async (id: string, prompt: string, text: string) => {
    await $.turn.start({ text: prompt, turnId: id } as never)
    await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: `row-${id}` } as never)
    await $.turn.complete({ turnId: id, reason: 'answer', answer: text, durationMs: 10, isAborted: false } as never)
  }
  await turn('t1', 'Why did the build break?', 'The revert undid a change that broke the build.')
  // a later turn that answers nothing, a step of the tour (tour/tour.ts): its words are no answer, and v stays on the
  // first answer
  await turn('t2', '(thimble tour) Step 1 done. Say step 2.', 'Run git revert HEAD to undo the last commit.')
  await $.prompt.edit(press('v') as never)
  await w.clock.advance(400)
  expect(w.spawns.length).toBe(1)
  const prompt = String(w.spawns[0].prompt)
  expect(prompt).toContain('The answer v was pressed under is not your last message')
  expect(prompt).toContain('The revert undid a change that broke the build.')
  expect(prompt).not.toContain('git revert')
})
