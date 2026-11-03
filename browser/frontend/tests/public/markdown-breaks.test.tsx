// @vitest-environment jsdom
// A line break in markdown (src/chat/markdown.tsx ChatMarkdown, which every .chat-text surface draws with: a reply, a
// card's takeaway, a comment card, a plan's details): a paragraph there shows the line endings it holds (white-space:
// pre-line, styles/chat.css), so a hard break (two spaces or a backslash at the line's end) is its <br> with a space
// after it in place of its line ending, which would break the line a second time; a soft break stays its line ending,
// one break too. The space, which does not show at the start of a line, keeps the two lines' words apart for code that
// reads the text alone: a click on the paragraph with the ask key takes its words for the new thread (src/pointer/
// anchors.ts chunkAt, whose text CmdPointer posts as the thread's anchor_text).
import { afterEach, expect, test } from 'vitest'
import type { AnswerMark } from '../../src/chat/answerComments.ts'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { chunkAt, type TextHit } from '../../src/pointer/anchors.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

/** The paragraph ChatMarkdown draws for `text`, as HTML. */
const para = async (text: string, marks?: readonly AnswerMark[]) => (await mount(<ChatMarkdown text={text} marks={marks} />)).querySelector('p')!.innerHTML

const TINT: AnswerMark = { id: 'c1', quote: 'line one line two', colour: 'red', ref: 'answer:t1#c1', active: false }

/** The words a click with the ask key on the word "one" takes from a reply that holds `text`: the chunk around the
 * word, as CmdPointer.pick reads it once textHitAt has found the word. */
async function chunkOf(text: string, marks?: readonly AnswerMark[]): Promise<string> {
  const el = await mount(
    <div className="chat-text" data-anchor="chat:main#3">
      <ChatMarkdown text={text} marks={marks} />
    </div>,
  )
  const reply = el.querySelector<HTMLElement>('[data-anchor]')!
  const walk = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT)
  let node = walk.nextNode() as Text | null
  while (node && !node.data.includes('one')) node = walk.nextNode() as Text | null
  const at = node!.data.indexOf('one')
  const range = document.createRange()
  range.setStart(node!, at)
  range.setEnd(node!, at + 3)
  const hit: TextHit = { el: node!.parentElement!, range, word: 'one', pieces: [], rect: new DOMRect() }
  return chunkAt(hit, reply).text
}

test('a hard break is one line break, as a soft break is', async () => {
  expect(await para('line one  \nline two')).toBe('line one<br> line two')
  expect(await para('line one\\\nline two')).toBe('line one<br> line two')
  expect(await para('line one\nline two')).toBe('line one\nline two')
})

test("a check's tint over a hard break leaves one line break too", async () => {
  const html = await para('line one  \nline two', [TINT])
  expect(html).toMatch(/<mark[^>]*>line one<\/mark><br><mark[^>]*> <\/mark><mark[^>]*>line two<\/mark>/)
  expect(html).not.toMatch(/<br>(<mark[^>]*>)?\n/)
})

test.each<[string, string, AnswerMark[] | undefined, string]>([
  ['a hard break made with two spaces', 'line one  \nline two', undefined, 'line one line two'],
  ['a hard break made with a backslash', 'line one\\\nline two', undefined, 'line one line two'],
  ["a hard break under a check's tint", 'line one  \nline two', [TINT], 'line one line two'],
  ['a soft break', 'line one\nline two', undefined, 'line one\nline two'],
])('a click with the ask key on a paragraph with %s takes its two lines with their words apart', async (_how, text, marks, chunk) => {
  expect(await chunkOf(text, marks)).toBe(chunk)
})
