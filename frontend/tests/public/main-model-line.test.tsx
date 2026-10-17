// @vitest-environment jsdom
// B30: main's composer shows the session's real model and effort, and nothing while they are not known: before main's
// first request it named no model and showed thimble's old default effort, "high", where the session ran at medium
// (src/chat/ModelLine.tsx mainEffort, src/chat/Composer.tsx).
import { afterEach, expect, test } from 'vitest'
import { Composer } from '../../src/chat/Composer.tsx'
import { mainEffort, mainFast } from '../../src/chat/ModelLine.tsx'
import type { Attached } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const line = async (a: Attached) => {
  const el = await mount(<Composer model={a.model} effort={mainEffort(a)} onEffort={() => undefined} fast={mainFast(a)} onFast={() => undefined} onSend={() => undefined} sending={false} />)
  return el.querySelector('.model-line')?.textContent ?? null
}

test("main's line shows nothing before the session's setting is known, then its real model and effort", async () => {
  const fresh: Attached = { session: 's1', cwd: '/corpus', since: '2026-10-17T03:04:25Z' }
  expect(mainEffort(fresh)).toBeNull()
  expect(await line(fresh)).toBeNull()
  expect(await line({ ...fresh, settings_effort: 'low' })).toBe('low')
  expect(await line({ ...fresh, model: 'claude-opus-5-5', effort: 'medium' })).toBe('Opus 5.5·medium')
})
