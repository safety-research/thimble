// What waits above the composer (holds, the permission card, the view proposal, label asks, notices) is one stack that
// takes at most 40% of the window's height and scrolls past that, so the transcript keeps its room
// (src/chat/ChatPanel.tsx, styles/chat.css .chat-foot-stack).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const css = readFileSync(path.resolve(__dirname, '../../src/styles/chat.css'), 'utf8')
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

test('the stack above the composer is capped and scrolls, and the notices in it do not scroll on their own', () => {
  expect(rule('.chat-foot-stack')).toMatch(/max-height: 40vh;[\s\S]*overflow-y: auto;/)
  expect(rule('.chat-foot-stack .chat-notices')).toMatch(/max-height: none;/)
  expect(rule('.chat-foot-stack[data-more]')).toMatch(/mask-image/)
})
