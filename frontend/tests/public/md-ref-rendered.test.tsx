// @vitest-environment jsdom
// A Markdown file opened at a ref (a line or a quoted span of it) under the Rendered tab is the rendered document, not its
// source with line numbers, which the Raw tab shows: the block that holds the line has the target's edge and the words
// the span quotes in it are highlighted (.hl), also where the quote crosses the bold speaker name (bug hunt L11: the
// Rendered tab showed `**P6:**` and line numbers, the same screen as Raw, and the quote was not shown in its place).
import { afterEach, beforeAll, expect, test } from 'vitest'
import TextDef from '../../src/files/views/text.tsx'
import type { SourcePage } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const LINES = ['# Session 3', '', '**00:01:10**', '', '**Q2:** How did the lantern list read to you?', '', '**R7:** Mostly fine. I was a little lost in the second column of lanterns until the colors came back.', '', '**Q2:** Mhm.']
const page: SourcePage = {
  path: 'S3/notes.md',
  kind: 'text',
  total_lines: LINES.length,
  start: 1,
  records: LINES.map((text, i) => ({ line: i + 1, record: { text }, blocks: [{ kind: 'text', text }], meta: {} })),
} as unknown as SourcePage
const quoteAt = (line: number, words: string): string => {
  const text = LINES[line - 1]
  const a = text.indexOf(words)
  return `S3/notes.md#L${line}.b0:c${a}-${a + words.length}`
}
const View = TextDef.component

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
})
afterEach(() => unmountAll())

test('a quoted span of a Markdown file opens the rendered document at its block, the words highlighted', async () => {
  const el = await mount(<View workspace="w" path="S3/notes.md" kind="text" page={page} loadMore={() => undefined} targetRef={quoteAt(7, 'a little lost in the second column')} />)
  await settle()
  expect(el.querySelector('.reader-md-file')).not.toBeNull()
  expect(el.querySelector('.reader-lineno, .reader-textline')).toBeNull()
  expect(el.textContent).not.toContain('**')
  const target = el.querySelector('.reader-md-target')!
  expect(target.textContent).toContain('R7: Mostly fine.')
  expect([...target.querySelectorAll('.hl')].map((h) => h.textContent).join('')).toBe('a little lost in the second column')
})

test('a quote that crosses the bold speaker name is highlighted across it', async () => {
  const el = await mount(<View workspace="w" path="S3/notes.md" kind="text" page={page} loadMore={() => undefined} targetRef={quoteAt(5, '**Q2:** How did')} />)
  await settle()
  expect([...el.querySelectorAll('.reader-md-target .hl')].map((h) => h.textContent).join('')).toBe('Q2: How did')
})
