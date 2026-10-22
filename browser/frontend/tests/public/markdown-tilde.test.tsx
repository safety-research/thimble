// @vitest-environment jsdom
// A single tilde in an agent's text is a character, not strikethrough (src/chat/markdown.tsx, the files' text view and
// a card's markdown output): wiki page names hold it, and "dse~Agent… and pec~Other" read struck through in a thread
// (live check L21). A pair of tildes still strikes through, as GitHub's markdown does.
import { afterEach, expect, test } from 'vitest'
import { Output } from '../../src/components/Outputs.tsx'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

test('one tilde stays a character in the chat and in a markdown output; two still strike through', async () => {
  for (const node of [<ChatMarkdown text={'Pages dse~Agent and pec~Other, then ~~gone~~.'} />, <Output bundle={{ 'text/markdown': 'Pages dse~Agent and pec~Other, then ~~gone~~.' }} />]) {
    const el = await mount(node)
    expect(el.textContent).toContain('dse~Agent and pec~Other')
    expect([...el.querySelectorAll('del')].map((d) => d.textContent)).toEqual(['gone'])
    unmountAll()
  }
})
