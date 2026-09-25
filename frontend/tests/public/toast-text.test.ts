// An error toast shows the server's words without the HTTP status before them (src/shell/Toasts.tsx toastText).
import { expect, test } from 'vitest'
import { toastText } from '../../src/shell/Toasts.tsx'

test('an error toast leaves out the HTTP status and keeps the server\'s words', () => {
  expect(toastText('409 no Claude Code session is listening in /data/x. Start thimble with `thimble` in that folder.')).toBe(
    'No Claude Code session is listening in /data/x. Start thimble with `thimble` in that folder.',
  )
  expect(toastText('Could not answer: 409 no such request')).toBe('Could not answer: no such request')
  expect(toastText('Could not export the report. 500 Internal Server Error')).toBe('Could not export the report. Internal Server Error')
  expect(toastText('Could not start. 404 no session runs for it')).toBe('Could not start. No session runs for it')
  expect(toastText('The card ran 400 times.')).toBe('The card ran 400 times.')
})
