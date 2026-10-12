// The tip of a running check's spinner says what a run with no agent yet waits for (src/report/Checks.tsx checkRunLabel).
import { describe, expect, test } from 'vitest'
import { checkRunLabel } from '../../src/report/Checks.tsx'

describe("a running check's tip", () => {
  test('names what a run with no chat waits for: a free session, the writer, or plan mode to end', () => {
    expect(checkRunLabel('Unverifiable', { chat: 'c1' })).toBe('Unverifiable is running: open its run')
    expect(checkRunLabel('Unverifiable', { waiting: 'queued' })).toBe('Unverifiable waits for a free session')
    expect(checkRunLabel('Unverifiable', { waiting: 'writer' })).toBe('Unverifiable runs once the writer has finished')
    // live check L21: a run a writer's end started while main was in plan mode said it waited for a free session
    expect(checkRunLabel('Unverifiable', { waiting: 'plan' })).toBe('Unverifiable runs once your session leaves plan mode (shift+tab in your terminal)')
  })
})
