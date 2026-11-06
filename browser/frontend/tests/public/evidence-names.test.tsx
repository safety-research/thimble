// @vitest-environment jsdom
// The card a page's checked passage shows on hover names each ref its comments rest on as the citation's chip does: a
// file ref by its path and its lines.
import { afterEach, expect, test } from 'vitest'
import { EvidencePop } from '../../src/report/Evidence.tsx'
import type { CheckLook, DocComment } from '../../src/report/checkComments.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
})

const look: CheckLook = { colour: () => 'grey', name: () => 'check', rank: () => 0 }

test('a file ref reads as its path and its lines', async () => {
  const comment: DocComment = {
    id: 'c1',
    sid: 's1',
    span: ['s1'],
    check: 'k1',
    text: 'The count rests on two lines of the log.',
    author: 'check',
    evidence: ['revisions.jsonl#L12', 'notes/week two.md#L3'],
    tag: false,
  }
  const el = await mount(<EvidencePop comments={[comment]} look={look} />)
  await settle()
  expect(el.querySelector('.wu-evpop-src')?.textContent).toBe('revisions.jsonl L12 · notes › week two.md L3')
})
