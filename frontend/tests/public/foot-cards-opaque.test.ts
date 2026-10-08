// The cards in the chat's foot (src/styles/chat.css): the foot floats over the chat's rows (`.chat-foot` is absolute),
// so each card in it paints on a solid surface. A hold's alert on the warning's see-through wash let the rows under it
// show through its text (live check L3, "Claude Code is waiting in your terminal" over the refused start's card).
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const CSS = readFileSync(new URL('../../src/styles/chat.css', import.meta.url), 'utf8')

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return CSS.slice(at, CSS.indexOf('}', at))
}

test("the foot floats over the rows, and a hold's card in it mixes its wash into the card's own surface", () => {
  expect(rule('.chat-foot')).toMatch(/position:\s*absolute/)
  expect(rule('.chat-foot .chat-hold')).toMatch(/background:\s*color-mix\([^;]*var\(--surface-card\)\)/)
  expect(rule('.chat-perm')).toMatch(/background:\s*color-mix\([^;]*var\(--surface-card\)\)/)
})
