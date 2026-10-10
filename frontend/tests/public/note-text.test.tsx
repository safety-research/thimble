// @vitest-environment jsdom
// A comment's words in the margin and beside the cards (src/report/NoteText.tsx): a `code span` a check writes, such
// as a file name or a command, reads as code without its backticks; the rest is plain text. Live check plan-cards: the
// comments showed their backticks.
import { afterEach, expect, test } from 'vitest'
import { noteText } from '../../src/report/NoteText.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(unmountAll)

test('code spans read as code, without their backticks', async () => {
  const el = await mount(<div>{noteText('Fetch them as `refs/pull/<n>/head`, or the forge has PRs with no code; a lone ` stays.')}</div>)
  expect(el.textContent).toBe('Fetch them as refs/pull/<n>/head, or the forge has PRs with no code; a lone ` stays.')
  expect([...el.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['refs/pull/<n>/head'])
})
