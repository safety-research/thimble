// @vitest-environment jsdom
// A workspace `thimble demo` installed from a pre-cache (src/chat/Precached.tsx): while no session is attached, the
// orientation's thread says it is a frozen demo session and gives the command that starts a live one, with a Copy button,
// and nothing else, as the bar in place of the composer does. From a full export whose session was kept it says the
// orientation ran in advance and offers "Attach a fresh session", which shows what a fresh session is, the command and
// a Copy button. The page stays readable without a session until the first one attaches (isGone), as a worked example's
// workspace does. Under the frozen card, the bar gives the card's title alone, so the sentence and the command show once.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ATTACH_EXPLAINER, ATTACH_LABEL, AttachBar, FROZEN_TEXT, FROZEN_TITLE, PRECACHED_TITLE, PrecachedCard, attachCommand, attachInstead, isFrozen, precachedMark, precachedText, takesFollowUps } from '../../src/chat/Precached.tsx'
import type { ChatMeta, PrecachedMark } from '../../src/lib/types.ts'
import { isExample, isGone } from '../../src/shell/SessionGone.tsx'
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
  expect(takesFollowUps(MARK)).toBe(false)
  // from a full export the orientation's session came with it
  expect(precachedText({ ...MARK, format: 'full', kept: true })).toContain('a message here continues it')
  expect(takesFollowUps({ ...MARK, kept: true })).toBe(true)
  expect(attachCommand(MARK)).toBe('cd /srv/thimble-demo/collusion-wiki && thimble')
  expect(attachCommand({ ...MARK, folder: '/srv/a b' })).toBe("cd '/srv/a b' && thimble")
  expect(attachCommand({ ...MARK, folder: '/home/ana/.thimble/demo/collusion-wiki' })).toBe('cd ~/.thimble/demo/collusion-wiki && thimble')
  // frozen while its session was not kept and none is attached
  expect(isFrozen(MARK, false)).toBe(true)
  expect(isFrozen(MARK, true)).toBe(false)
  expect(isFrozen({ ...MARK, kept: true }, false)).toBe(false)
})

test('a pre-cached workspace is read without a session until one attached and ended', () => {
  expect(isGone(MAIN, true, true)).toBe(false)
  expect(isGone({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, true, true)).toBe(true)
  expect(isGone(MAIN, true, false)).toBe(true)
  // the stream down: a restart shows no card, but a session that ended before the server stopped itself does (L10)
  expect(isGone(MAIN, false, false)).toBe(false)
  expect(isGone({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, false, false)).toBe(true)
  expect(isGone({ ...MAIN, attached: { session: 's' } } as unknown as ChatMeta, true, true)).toBe(false)
})

test("a worked example's workspace is read without a session too, until one attached and ended", () => {
  const rows = [
    { name: 'example-timeline', kind: 'example', folder: 'example-timeline', path: '/h/examples/example-timeline' },
    { name: 'example-notes', kind: 'folder', folder: 'example-notes', path: '/h/example-notes' },
  ] as const
  expect(isExample(rows, 'example-timeline')).toBe(true)
  // a folder whose name only starts like an example's is no example
  expect(isExample(rows, 'example-notes')).toBe(false)
  expect(isExample(rows, 'elsewhere')).toBe(false)
  expect(isGone(MAIN, true, isExample(rows, 'example-timeline'))).toBe(false)
  expect(isGone({ ...MAIN, ended: { session: 's', cwd: '/srv' } } as unknown as ChatMeta, true, true)).toBe(true)
})

test('the attach steps stand in for the composer only where it would reach main', () => {
  expect(attachInstead(MARK, true, 'here')).toBe(true)
  expect(attachInstead(MARK, true, 'main')).toBe(true)
  expect(attachInstead(MARK, true, 'orient')).toBe(false) // a later orientation, with a session of its own
  expect(attachInstead(MARK, true, 'view')).toBe(false)
  expect(attachInstead(MARK, false, 'here')).toBe(false)
  expect(attachInstead(null, true, 'here')).toBe(false)
})

test('a frozen demo session\'s card says so, with the command that starts a live session and a Copy button, and nothing else', async () => {
  const copied: string[] = []
  vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } })
  const el = await mount(<PrecachedCard mark={MARK} attached={false} />)
  expect(el.querySelector('.card-title')?.textContent).toBe(FROZEN_TITLE)
  expect(FROZEN_TITLE).toBe('This is a frozen demo session')
  expect([...el.querySelectorAll('p')].map((x) => x.textContent)).toEqual([FROZEN_TEXT])
  expect(FROZEN_TEXT).toBe('To start a live session from scratch with this dataset, run')
  expect(el.querySelector('.precached-command code')?.textContent).toBe('cd /srv/thimble-demo/collusion-wiki && thimble')
  // no run date or model, no attach button, no explainer, no `thimble -c` note
  expect(el.textContent).not.toContain('2026-10-05')
  expect(el.textContent).not.toContain('claude-opus')
  expect(el.textContent).not.toContain(ATTACH_EXPLAINER)
  expect(el.textContent).not.toContain('thimble -c')
  expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy'])
  const copy = el.querySelector('.precached-command button') as HTMLButtonElement
  await act(async () => copy.click())
  await settle()
  expect(copied).toEqual(['cd /srv/thimble-demo/collusion-wiki && thimble'])
  expect(copy.textContent).toBe('Copied')
})

test('from a full export whose session was kept, the card says the orientation ran in advance and the button shows the command with a Copy button', async () => {
  const copied: string[] = []
  vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } })
  const el = await mount(<PrecachedCard mark={{ ...MARK, format: 'full', kept: true }} attached={false} />)
  expect(el.querySelector('.card-title')?.textContent).toBe(PRECACHED_TITLE)
  expect(el.textContent).toContain('a message here continues it')
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
  expect(el.querySelector('.card-title')?.textContent).toBe(PRECACHED_TITLE)
  expect(el.textContent).toContain('A Claude Code session is attached')
  expect(el.querySelector('.precached-command')).toBeNull()
  expect([...el.querySelectorAll('button')].some((b) => b.textContent === ATTACH_LABEL)).toBe(false)
})

test('the bar in place of the composer gives the same sentence and command', async () => {
  const el = await mount(<AttachBar mark={MARK} />)
  expect([...el.querySelectorAll('p')].map((x) => x.textContent)).toEqual([FROZEN_TEXT])
  expect(el.querySelector('.precached-command code')?.textContent).toBe('cd /srv/thimble-demo/collusion-wiki && thimble')
  expect(el.textContent).not.toContain('No Claude Code session is attached')
  expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy'])
})

test("under the frozen card the bar gives the card's title alone, so the sentence and the command show once", async () => {
  const el = await mount(
    <>
      <PrecachedCard mark={MARK} attached={false} />
      <AttachBar mark={MARK} card />
    </>,
  )
  expect(el.querySelector('[data-precached-bar]')?.textContent).toBe(FROZEN_TITLE)
  expect(el.querySelectorAll('.precached-command').length).toBe(1)
  expect([...el.querySelectorAll('p')].filter((p) => p.textContent === FROZEN_TEXT).length).toBe(1)
  expect(el.textContent?.split(FROZEN_TEXT).length).toBe(2)
})

test('from a full export whose session was kept, the bar offers the attach steps as before', async () => {
  const el = await mount(<AttachBar mark={{ ...MARK, format: 'full', kept: true }} />)
  expect(el.textContent).toContain('No Claude Code session is attached')
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === ATTACH_LABEL) as HTMLButtonElement
  await act(async () => button.click())
  expect(el.querySelector('.precached-command code')?.textContent).toBe('cd /srv/thimble-demo/collusion-wiki && thimble')
})
