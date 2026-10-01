// @vitest-environment jsdom
// The card a slide's, a story's or a page's checked passage shows on hover names each ref its comments rest on as the
// citation's chip does: a cited step by what it points at in plain words, never by its tool's name or its input as JSON.
import { afterEach, expect, test } from 'vitest'
import { forgetCalls, setCallWords } from '../../src/lib/calls.ts'
import { EvidencePop } from '../../src/report/Evidence.tsx'
import type { CheckLook, DocComment } from '../../src/report/checkComments.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  forgetCalls()
})

const look: CheckLook = { colour: () => 'grey', name: () => 'check', rank: () => 0 }

test('a cited step reads as what it points at, a file ref as its file', async () => {
  setCallWords('orient01', 3, 'StructuredOutput', { summary: 'Reverts are short.' })
  setCallWords('orient01', 4, 'mcp__plugin_thimble_thimble__critique', { context: 'The account the drafts present.' })
  setCallWords('orient01', 5, 'Bash', { command: 'grep -c revert revisions.jsonl', description: 'Count revert revisions' })
  const comment: DocComment = {
    id: 'c1',
    sid: 's1',
    span: ['s1'],
    check: 'k1',
    text: 'The count rests on the summaries, not on the data.',
    author: 'check',
    evidence: ['call:orient01/3', 'call:orient01/4', 'call:orient01/5#L2', 'revisions.jsonl#L12'],
    tag: false,
  }
  const el = await mount(<EvidencePop comments={[comment]} look={look} />)
  await settle()
  const names = el.querySelector('.wu-evpop-src')?.textContent ?? ''
  expect(names).toBe('an agent’s report · the critic’s report · Count revert revisions · line 2 · revisions.jsonl L12')
  expect(names).not.toMatch(/StructuredOutput|critique|Bash|[{}]/)
})
