// Claude Code's main screen (the classic renderer, where a fresh config starts) takes no clicks (bug hunt F1): the rows
// above the prompt and the thimble line cannot be pressed there, so the line says where the keys are, home lists the
// rows that wait first, and each opens with its acts on digit keys (waitview.tsx); `/thimble browser` in a remote
// terminal opens the SSH row there, where a key copies the one-time link. Fullscreen shows none of it.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { RELAY } from '../panel'
import { CWD, aboveAt, panelWorld, shown, takesKeys, words } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const LINK_FILE = '/home/a/.thimble/links/s1.json'
const LINK = 'http://127.0.0.1:29321/?ws=wiki#k=one-time-code'
const TUNNEL = 'ssh -N -L 29321:127.0.0.1:29321 <your ssh host>'
const OFFER = { slug: 'edit-bursts', name: 'Edit Bursts', description: 'Each wiki page as a strip of its saves.', task: 'Find out when the agents edited together.', claims: ['revisions.jsonl'] }
const NOTICE = { id: 'n1', key: 'check:important-details', kind: 'check', text: 'The check Important details failed: its model call was refused.', agent: 'Important details', chat: '', at: '2026-10-16T16:10:00Z', acts: [] }

const above = (fullscreen: boolean) => ({ ...(aboveAt(200) as object), viewport: { columns: 200, rows: 58, isFullscreen: fullscreen } }) as never
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 58, isFullscreen: false }, props: { title: 'thimble', isFocused: true, bodyColumns: 196, placement: 'inline', scroll: { bodyRows: 40 }, view: {} } } as never
const CLASSIC = { isFullscreen: false, columns: 200 }

const mount = async ($: E): Promise<M> => (await $.ui.mount(PANE)) as unknown as M

test("bug hunt F1: on Claude Code's main screen, which takes no clicks, home lists the rows above the prompt with their acts on keys, and a key copies the one-time link", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.states.home = { ...w.states.home, offer: OFFER, notices: [NOTICE] } as never
  w.open = { ...w.open, remote: true, opened: false, tunnel: TUNNEL, link_file: LINK_FILE }
  w.files.set(LINK_FILE, JSON.stringify({ url: LINK }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  // fullscreen takes clicks: the thimble line names no keys
  let band = (await $.ui.mount(above(true))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-summary' }))).not.toContain('/thimble')
  await band.unmount()
  // the main screen: the line ends with where the keys are
  band = (await $.ui.mount(above(false))) as unknown as M
  expect(words(await band.find({ type: 'Box', key: 'above-summary' }))).toContain('/thimble to use these with keys')
  await band.unmount()

  // `/thimble browser` in a remote terminal opens the SSH row in the panel: 2 copies a one-time link, never drawn
  await $.command.run({ command: 'thimble:thimble', args: 'browser', presentation: CLASSIC } as never)
  await w.clock.settle()
  let m = await mount($)
  let text = shown(await m.drawn())
  expect(text).toContain('home › browser')
  expect(text).toContain(TUNNEL)
  expect(text).toMatch(/1 copy.*2 copy link.*3 dismiss/s)
  await m.press({ key: 'hk-wait-2' })
  await w.clock.settle()
  expect(w.copied).toEqual([LINK])
  expect(JSON.stringify(await m.drawn())).not.toContain('one-time-code')
  await m.unmount()

  // home lists what waits above the prompt first: the view proposal, the notice, the SSH row
  await $.command.run({ command: 'thimble:thimble', args: '', presentation: CLASSIC } as never)
  await w.clock.settle()
  await takesKeys($)
  m = await mount($)
  const rows = ((((await m.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r)))
  const at = rows.findIndex(r => r.includes('Above the prompt (3)'))
  expect(at).toBeGreaterThanOrEqual(0)
  expect(rows[at + 1]).toMatch(/❯.*Edit Bursts.*view proposal/)
  expect(rows[at + 2]).toMatch(/! The check Important details failed.*notice/)
  expect(rows[at + 3]).toMatch(/ssh -N -L.*browser/)
  // Enter opens the chosen row, the view proposal, with its acts on keys; 1 accepts it and goes back to home
  const relay = (await m.find({ type: 'Input', key: RELAY.pick })) as { props?: { value?: string } } | undefined
  await m.input({ key: RELAY.pick, text: relay?.props?.value ?? '' })
  await w.clock.settle()
  await m.unmount()
  m = await mount($)
  text = shown(await m.drawn())
  expect(text).toContain('home › view proposal')
  expect(text).toMatch(/1 accept.*2 reject.*3 don't ask again.*4 dismiss/s)
  expect(text).toContain('1–4 to press')
  await m.press({ key: 'hk-wait-1' })
  await w.clock.settle()
  expect(w.acts.at(-1)).toEqual({ kind: 'view-accept', payload: { slug: 'edit-bursts' } })
  await m.unmount()
  m = await mount($)
  const back = ((((await m.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r)))
  expect(back.some(r => r.includes('Above the prompt'))).toBe(true)
  await m.unmount()
})
