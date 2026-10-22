// The guidance block (guidance/guidance.ts): every conversation's first request carries one context block named
// `thimble` with guidance.md's text, and a switched-off feature's section is left out. All text is made up.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { resetPrompts } from '../prompts/prompts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const GUIDANCE = [
  'thimble is on in this folder. A made-up opening.',
  '',
  '## Communicating',
  '',
  'Answer first: [12 of 40](#) runs failed.',
  '',
  '## Marking claims',
  '',
  'Mark a claim as [words](#).',
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

function world(on: Any) {
  resetPrompts()
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' })
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/prompts/guidance.md') ? GUIDANCE : '' }))
  // the engine's own blocks, which the plugin keeps
  on('prompt.context', (_$: unknown, e: Any) => ({ blocks: e.blocks }))
}

async function thimbleBlock($: Any): Promise<{ all: Any[]; text: string }> {
  const r: Any = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'Today is a made-up day.' }] })
  const mine = r.blocks.filter((b: Any) => b.name === 'thimble')
  expect(mine.length).toBe(1)
  return { all: r.blocks, text: mine[0].text }
}

test("the first request carries the thimble block with guidance.md's text, after the engine's blocks", async ($, on) => {
  world(on)
  const { all, text } = await thimbleBlock($)
  expect(all.map((b: Any) => b.name)).toEqual(['currentDate', 'thimble'])
  expect(text).toBe(GUIDANCE.trim())
})

test('with cards off, the Cards section is left out and the rest stays', { options: { cards: false } }, async ($, on) => {
  world(on)
  const { text } = await thimbleBlock($)
  expect(text).not.toContain('## Cards')
  expect(text).not.toContain('`card` tool')
  expect(text).toContain('## Marking claims')
  expect(text).toContain('[12 of 40](#)')
  expect(text).toContain('## Labels')
})

test("with marks off, the Marking claims section is left out and the other examples' marks read as plain words", { options: { marks: false } }, async ($, on) => {
  world(on)
  const { text } = await thimbleBlock($)
  expect(text).not.toContain('## Marking claims')
  expect(text).not.toContain('](#)')
  expect(text).toContain('Answer first: 12 of 40 runs failed.')
  expect(text).toContain('Sort records with a label: 7 of 30 tickets.')
  expect(text).toContain('## Cards')
})
