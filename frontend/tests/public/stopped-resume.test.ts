// The stopped notice an earlier version left on a background session's chat offers Resume, which the server allows
// only for the orientation and a writer (backend agent_session.resume_chat): another chat's notice is not shown.
import { describe, expect, test } from 'vitest'
import { stoppedAlert } from '../../src/chat/AgentCard.tsx'
import type { ChatMeta } from '../../src/lib/types.ts'

const meta = (role: string, status = 'stopped') =>
  ({ id: 'c1', role, status, alert: { kind: 'stopped', text: 'The session stopped.' } }) as unknown as ChatMeta

describe('stoppedAlert', () => {
  test('the orientation and a writer show their stopped notice, a critique and a finished chat do not', () => {
    expect(stoppedAlert(meta('orient'))?.text).toBe('The session stopped.')
    expect(stoppedAlert(meta('writer'))?.text).toBe('The session stopped.')
    expect(stoppedAlert(meta('step'))).toBeNull()
    expect(stoppedAlert(meta('orient', 'done'))).toBeNull()
  })
})
