// @vitest-environment jsdom
// A workspace `thimble demo` installed from a pre-cache (src/chat/Precached.tsx): the orientation's thread says it ran in
// advance and, while no session is attached, offers "Attach a fresh session", which shows what a fresh session is, the
// command and a Copy button. The page stays readable without a session until the first one attaches (isGone).
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ATTACH_EXPLAINER, ATTACH_LABEL, AttachBar, PRECACHED_TITLE, PrecachedCard, attachCommand, precachedMark, precachedText } from '../../src/chat/Precached.tsx'
import type { ChatMeta, PrecachedMark } from '../../src/lib/types.ts'
import { isGone } from '../../src/shell/SessionGone.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-06T00:00:00+00:00'
const MARK: PrecachedMark = { dataset: 'collusion-wiki', created: '2026-10-06T01:00:00+00:00', ran: '2026-10-05T22:30:00+00:00', folder: '/srv/thimble-demo/collusion-wiki', orientation: 'o1', model: 'claude-opus-5-5[1m]' }
const MAIN = { id: 'main', kind: 'main', role: 'main', title: '', created_at: T, parent: null } as unknown as ChatMeta
const ORIENT = { id: 'o1', kind: 'agent', role: 'orient', title: 'Orientation', created_at: T, parent: 'main', status: 'done', precached: MARK } as unknown as ChatMeta

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('the mark is read from the orientation that carries one', () => {
  expect(precachedMark([MAIN, ORIENT])?.folder).toBe('/srv/thimble-demo/collusion-wiki')
  expect(precachedMark([MAIN, { ...ORIENT, precached: null }])).toBeNull()
  expect(precachedText(MARK)).toContain('ran on 2026-10-05 with claude-opus-5-5,')
  expect(precachedText(MARK)).toContain('takes no follow-ups')
  expect(attachCommand(MARK)).toBe('cd /srv/thimble-demo/collusion-wiki && thimble')
  expect(attachCommand({ ...MARK, folder: '/srv/a b' })).toBe("cd '/srv/a b' && thimble")
})

test('a pre-cached workspace is read without a session until one attached and ended', () => {
  expect(isGone(MAIN, true, true)).toBe(false)
  expect(isGone({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, true, true)).toBe(true)
  expect(isGone(MAIN, true, false)).toBe(true)
  expect(isGone({ ...MAIN, attached: { session: 's' } } as unknown as ChatMeta, true, true)).toBe(false)
})

test('the card says the orientation ran in advance and the button shows the command with a Copy button', async () => {
  const copied: string[] = []
  vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } })
  const el = await mount(<PrecachedCard mark={MARK} attached={false} />)
  expect(el.querySelector('.card-title')?.textContent).toBe(PRECACHED_TITLE)
  expect(el.textContent).toContain('Its Claude Code session is not')
  expect(el.querySelector('.precached-command')).toBeNull()
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === ATTACH_LABEL) as HTMLButtonElement
  await act(async () => button.click())
  expect(el.querySelector('.precached-steps')?.textContent).toContain(ATTACH_EXPLAINER)
  expect(el.querySelector('.precached-command code')?.textContent).toBe('cd /srv/thimble-demo/collusion-wiki && thimble')
  expect(el.querySelector('.precached-steps .precached-note')?.textContent).toBe('thimble -c in that folder continues the same session later.')
  const copy = [...el.querySelectorAll('.precached-command button')][0] as HTMLButtonElement
  await act(async () => copy.click())
  await settle()
  expect(copied).toEqual(['cd /srv/thimble-demo/collusion-wiki && thimble'])
  expect(copy.textContent).toBe('Copied')
})

test('once a session is attached the card says so and offers no command', async () => {
  const el = await mount(<PrecachedCard mark={MARK} attached />)
  expect(el.textContent).toContain('A Claude Code session is attached')
  expect([...el.querySelectorAll('button')].some((b) => b.textContent === ATTACH_LABEL)).toBe(false)
})

test('the bar in place of the composer offers the same steps', async () => {
  const el = await mount(<AttachBar mark={MARK} />)
  expect(el.textContent).toContain('No Claude Code session is attached')
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === ATTACH_LABEL) as HTMLButtonElement
  await act(async () => button.click())
  expect(el.querySelector('.precached-command code')?.textContent).toBe('cd /srv/thimble-demo/collusion-wiki && thimble')
})
