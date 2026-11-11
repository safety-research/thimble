// @vitest-environment jsdom
// A mark whose source changed after its check (marks/marks.ts lookOf, marks/Mark.tsx): it draws stale, amber with ↻
// after the words, as the terminal draws it, and its label says stale and which file changed, with Repair, which checks
// it again against the files as they are now.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import type { MarkItem } from '../../src/marks/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const SOURCE = { file: 'README.md', path: '/made-up/data/README.md', line: '26', size: 2570, mtime: 1, sha256: 'a1' }
const item = (k: number, words: string, rest: Partial<MarkItem>): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, turn: 'a1b2c3d4', ...rest })
const open = (words: Element) => act(async () => void words.dispatchEvent(new MouseEvent('click', { bubbles: true })))

test('a mark whose cited file changed after its check draws stale, and its label says which file, with Repair', async () => {
  const evidence = { kind: 'quote' as const, file: 'README.md', line: '26', lines: [{ n: 26, text: 'uvicorn app.main:app --port 8000', highlight: [23, 32] as [number, number] }] }
  const checks = [
    item(0, 'port 8000', { evidence, sources: [{ ...SOURCE, changed: true }] }),
    item(1, 'Python 3.12', { evidence, sources: [{ ...SOURCE, line: '19' }] }),
    item(2, '12 of 40', { status: 'failed', failedBy: 'evidence', reason: 'No line shows 12.', sources: [{ ...SOURCE, changed: true }] }),
  ]
  const el = await mount(<ChatMarkdown text="It runs on [port 8000](#) with [Python 3.12](#); [12 of 40](#) failed." checks={checks} />)
  // a file a citation rests on changed: stale, with ↻ after the words; one whose own source reads as checked stays
  // verified, and a failed one stays failed
  expect([...el.querySelectorAll('.mark')].map((m) => [m.getAttribute('data-mark-look'), m.textContent])).toEqual([
    ['stale', 'port 8000↻'],
    ['verified', 'Python 3.12'],
    ['failed', '12 of 40×'],
  ])
  await open(el.querySelectorAll<HTMLElement>('.mark .mark-words')[0])
  await settle()
  const head = document.querySelector('.mark-pop .mark-pop-head')
  expect(head?.querySelector('.mark-pop-stale')?.textContent).toBe('↻ stale README.md changed after the check.')
  expect(head?.querySelector('button')?.textContent).toBe('Repair')
  // the evidence under it is what the check read
  expect(document.querySelector('.mark-pop .cite-cell')?.textContent).toBe('port 8000')
})
