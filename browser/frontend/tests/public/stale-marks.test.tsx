// @vitest-environment jsdom
// A mark whose source changed after its check (marks/marks.ts lookOf, marks/Mark.tsx): it draws stale, amber with ↻
// after the words, as the terminal draws it, and its label says ↻ stale at its head's right, with Repair, which checks
// it again against the files as they are now, and no more. A card's value too: its label shows what the check read of
// the card, whatever the card shows now, and says no more of it.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import type { MarkItem } from '../../src/marks/marks.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const SOURCE = { file: 'README.md', path: '/made-up/data/README.md', line: '26', size: 2570, mtime: 1, sha256: 'a1' }
const item = (k: number, words: string, rest: Partial<MarkItem>): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, turn: 'a1b2c3d4', ...rest })
const open = (words: Element) => act(async () => void words.dispatchEvent(new MouseEvent('click', { bubbles: true })))

test('a mark whose cited file changed after its check draws stale, and its label says stale, with Repair, and no file', async () => {
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
  // the head of its place: the place's chip, then at the right ↻ stale and Repair
  const head = document.querySelector('.mark-pop .refchip-pop-head')
  expect(head?.querySelector('.refchip-pop-chip')?.textContent).toContain('README.md · line 26')
  expect(head?.querySelector('.mark-pop-side')?.textContent).toBe('↻ staleRepair')
  expect(head?.querySelector('.mark-pop-status')?.className).toContain('is-warn')
  expect(document.querySelector('.mark-pop')?.textContent).not.toContain('changed after the check')
  // the evidence under it is what the check read
  expect(document.querySelector('.mark-pop .cite-cell')?.textContent).toBe('port 8000')
})

test("a card's value whose card changed after its check: its label shows the cell as the check read it, and no note", async () => {
  // the card now shows 15 where the check read 12: its input changed, and the card ran again
  const now = '<table><tr><th>agent</th><th>merged</th></tr><tr><th>agent-1</th><td>15</td></tr><tr><th>agent-2</th><td>7</td></tr></table>'
  vi.stubGlobal('fetch', async (url: string) => {
    const body = String(url).includes('/ref?') ? { ref: 'card:abcd1234#merged/agent-1', kind: 'cell', excerpt: '', meta: { title: 'Merged by agent', table_html: now } } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const table = { corner: 'agent', cols: ['merged'], rows: [{ label: 'agent-1', values: ['12'] }, { label: 'agent-2', values: ['7'] }], at: { r: 0, c: 0 } }
  const evidence = { kind: 'card' as const, card: 'abcd1234', title: 'Merged by agent', ref: 'card:abcd1234#merged/agent-1', value: '12', table }
  const runs = { file: 'runs.csv', path: '/made-up/data/runs.csv', size: 410, mtime: 1, sha256: 'b2', changed: true }
  const el = await mount(<ChatMarkdown text="agent-1 merged [12](#) pull requests." checks={[item(0, '12', { evidence, sources: [runs] })]} />)
  expect(el.querySelector('.mark')?.getAttribute('data-mark-look')).toBe('stale')
  await open(el.querySelector<HTMLElement>('.mark .mark-words')!)
  await settle()
  await settle()
  const pop = document.querySelector('.mark-pop')
  expect(pop?.querySelector('.refchip-pop-head .mark-pop-side')?.textContent).toBe('↻ staleRepair')
  expect(pop?.querySelector('.cite-cell')?.textContent).toBe('12')
  expect(pop?.textContent).not.toContain('changed after the check')
})
