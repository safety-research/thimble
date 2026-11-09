// The guidance (guidance/guidance.ts): the first prompt of every conversation, and the first after a compaction,
// carries guidance.md's text as context beside it, once. All text is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { resetPrompts } from '../prompts/prompts'
import { test } from './kit'
import { tempRun } from './stubs'

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

/** The conversation as its next request holds it, which the test's core answers `session.messages` with. */
type World = { messages: Any[]; context: string[][] }

/** The test's world, whose prompts/guidance.md is GUIDANCE. */
function world(on: Any): World {
  resetPrompts()
  const w: World = { messages: [], context: [] }
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' })
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 1, stdout: '', stderr: 'made-up: no such command' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/prompts/guidance.md') ? GUIDANCE : '' }))
  on('session.messages', () => ({ value: w.messages }))
  // the engine: the prompt enters with its context, which the next request holds as a reminder after the prompt
  on('prompt.submit', (_$: unknown, e: Any) => {
    const context = [...(e.context ?? [])]
    w.context.push(context)
    w.messages.push({ role: 'user', content: [{ type: 'text', text: e.text }, ...context.map(c => ({ type: 'text', text: `<system-reminder>\nprompt.submit hook additional context: ${c}\n</system-reminder>` }))] })
    w.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'A made-up answer.' }] })
    return { text: e.text, context }
  })
  return w
}

/** The person asks; the guidance this prompt carried, the one copy there must be. */
async function ask($: Any, w: World, text = 'Which runs failed?'): Promise<string[]> {
  await $.prompt.submit({ text })
  return w.context.at(-1)!
}

async function thimbleText($: Any, w: World): Promise<string> {
  const carried = await ask($, w)
  expect(carried.length).toBe(1)
  return carried[0]
}

test("the first prompt carries guidance.md's text beside it, the next prompts do not carry it again, and the first after a compaction does, once", { options: { citations: 'auto cite' } }, async ($, on) => {
  const w = world(on)
  expect(await thimbleText($, w)).toBe(GUIDANCE.trim())
  expect(await ask($, w, 'And why?')).toEqual([])
  expect(await ask($, w, 'Show me one.')).toEqual([])
  // a compaction replaces the copy with a summary: the next prompt carries it again, once
  w.messages = [{ role: 'user', content: [{ type: 'text', text: 'Summary: the analyst asked which runs failed; thimble is on in this folder.' }] }]
  expect(await ask($, w, 'And why?')).toEqual([GUIDANCE.trim()])
  expect(await ask($, w, 'Show me one.')).toEqual([])
})

test('only the newest copy counts: an older copy holds the text (Cards on demand), a newer one says cards are off, so with Cards auto the next prompt carries the text again, once', { options: { citations: 'auto cite' } }, async ($, on) => {
  const w = world(on)
  const asked = (text: string, context: string) => ({ role: 'user', content: [{ type: 'text', text }, { type: 'text', text: `<system-reminder>\nprompt.submit hook additional context: ${context}\n</system-reminder>` }] })
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'A made-up answer.' }] }
  const cardsOff = `${GUIDANCE.replace(/## Cards\n\n[^\n]*\n\n/, '').trim()}\n\nCards are off, so draw no cards.`
  // Cards was on demand, then off, and is auto now
  w.messages = [asked('Which runs failed?', `${GUIDANCE.trim()}\n\nDraw a card only when the analyst asks for one.`), answer, asked('And why?', cardsOff), answer]
  expect(await ask($, w, 'Show me one.')).toEqual([GUIDANCE.trim()])
  expect(await ask($, w, 'And the next?')).toEqual([])
})
