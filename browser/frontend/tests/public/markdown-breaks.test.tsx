// @vitest-environment jsdom
// A line break in markdown (src/chat/markdown.tsx ChatMarkdown, which every .chat-text surface draws with: a reply, a
// card's takeaway, a comment card, a plan's details): a paragraph there shows the line endings it holds (white-space:
// pre-line, styles/chat.css), so a hard break (two spaces or a backslash at the line's end) is its <br> alone, with no
// line ending after it that would break the line a second time; a soft break stays its line ending, one break too.
import { afterEach, expect, test } from 'vitest'
import type { AnswerMark } from '../../src/chat/answerComments.ts'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

/** The paragraph ChatMarkdown draws for `text`, as HTML. */
const para = async (text: string, marks?: readonly AnswerMark[]) => (await mount(<ChatMarkdown text={text} marks={marks} />)).querySelector('p')!.innerHTML

test('a hard break is one line break, as a soft break is', async () => {
  expect(await para('line one  \nline two')).toBe('line one<br>line two')
  expect(await para('line one\\\nline two')).toBe('line one<br>line two')
  expect(await para('line one\nline two')).toBe('line one\nline two')
})

test("a check's tint over a hard break leaves one line break too", async () => {
  const mark: AnswerMark = { id: 'c1', quote: 'line one line two', colour: 'red', ref: 'answer:t1#c1', active: false }
  const html = await para('line one  \nline two', [mark])
  expect(html).toMatch(/<mark[^>]*>line one<\/mark><br>/)
  expect(html).not.toMatch(/<br>(<mark[^>]*>)?\n/)
})
