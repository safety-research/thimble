// The tip of a running check's spinner says what a run with no agent yet waits for (src/report/Checks.tsx checkRunLabel).
import { describe, expect, test } from 'vitest'
import { checkRunLabel } from '../../src/report/Checks.tsx'

describe("a running check's tip", () => {
  test('names what a run with no chat waits for: a free session, the writer, or plan mode to end', () => {
    expect(checkRunLabel('Unverified', { chat: 'c1' })).toBe('Unverified is running: open its run')
    expect(checkRunLabel('Unverified', { waiting: 'queued' })).toBe('Unverified waits for a free session')
    expect(checkRunLabel('Unverified', { waiting: 'writer' })).toBe('Unverified runs once the writer has finished')
    // live check L21: a run a writer's end started while main was in plan mode said it waited for a free session
    expect(checkRunLabel('Unverified', { waiting: 'plan' })).toBe('Unverified runs once your session leaves plan mode (shift+tab in your terminal)')
  })
})
