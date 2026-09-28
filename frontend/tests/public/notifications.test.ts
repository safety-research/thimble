// A Claude Code task notification that a model copied into its reply is not shown as text (src/chat/model.ts).
import { expect, test } from 'vitest'
import { withoutNotifications } from '../../src/chat/model.ts'

test('a copied <task-notification> block goes, the words around it stay', () => {
  const said = '↳ orient: finished its light pass with 9 cards\n\n<task-notification>\n<task-id>a8</task-id>\n<status>completed</status>\n</task-notification>'
  expect(withoutNotifications(said)).toBe('↳ orient: finished its light pass with 9 cards')
  expect(withoutNotifications('<task-notification><task-id>a</task-id></task-notification>')).toBe('')
  const plain = 'no tags here'
  expect(withoutNotifications(plain)).toBe(plain)
})
