// The press that opens the browser (offramp.ts, SPEC-v2 3.15, C12): `thimble open --session <sid> --cwd <dir> --ref
// <ref> --json`, a toast at once, a watch of the claim file that ends in `opened in the browser` or the
// `open:not-claimed` notice with `copy link`; no sign-in code in a row, a toast or a copy but the one `copy link` makes.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { linkIn, openResult } from '../offramp'
import { CWD, aboveAt, panelWorld, pressBrowser, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const T = { timeoutMs: 30_000 }
const CLAIM = '/home/a/.thimble/open/x.claimed'
const LINK_FILE = '/home/a/.thimble/links/s1.json'
const LINK = 'http://127.0.0.1:29321/?ws=wiki#k=one-time-code'

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** A press on `ref`'s view: home, or a card by its id (its title row's `↗`). */
async function press($: E, w: PanelWorld, ref = 'home'): Promise<void> {
  await pressBrowser($, w, ref === 'home' ? '' : `card ${ref}`)
}

test('a press: the toast at once, `thimble open` with this session, the folder and the object, then `opened in the browser` once the page claims its sign-in', T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  await press($, w)
  expect(w.toasts).toContain("starting thimble's page…")
  expect(w.pressed.at(-1)).toEqual(['/tree/plugin/bin/thimble', 'open', '--session', 's1', '--cwd', CWD, '--ref', 'home', '--json'])
  // a second press on the same object while the first waits for its claim runs no second open
  await press($, w)
  expect(w.pressed.length).toBe(1)
  await w.clock.advance(1000)
  expect(w.toasts.some(t => t.startsWith('opened in the browser'))).toBe(false)
  w.exists.add(CLAIM)
  await w.clock.advance(600)
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('opened in the browser · 127.0.0.1:29321')
})

test('no claim in 12 s: the `open:not-claimed` notice with `copy link`, which copies a one-time link a new open wrote and never shows it', T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  await press($, w)
  await w.clock.advance(12_500)
  await w.clock.settle()
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  const row = words(await m.find({ type: 'Box', key: 'above-mod-open-not-claimed' }))
  expect(row).toBe("  noticeThe browser did not open thimble's page.copy linkdismiss")
  expect(w.toasts).toContain("The browser did not open thimble's page.")
  w.open = { ...w.open, link_file: LINK_FILE }
  w.files.set(LINK_FILE, JSON.stringify({ url: LINK }))
  await m.press({ key: 'above-mod-open-not-claimed-act-0' })
  await w.clock.settle()
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--link']))
  expect(w.copied).toEqual([LINK])
  expect(w.toasts.join('\n')).not.toContain('one-time-code')
  expect(JSON.stringify(await m.drawn())).not.toContain('one-time-code')
  await m.unmount()
})

test("open's answer and a link file read as C12 writes them", () => {
  expect(openResult({ exitCode: 0, stdout: '{"ok": false, "error": {"code": "NOT_BUILT", "message": "thimble open is not built yet", "fix": "wait"}}', stderr: '' })).toEqual({ ok: false, error: { code: 'NOT_BUILT', message: 'thimble open is not built yet', fix: 'wait' } })
  expect(openResult({ exitCode: 1, stdout: '', stderr: 'Traceback\nOSError: no' })).toEqual({ ok: false, error: { code: 'START', message: 'OSError: no', fix: '' } })
  expect(linkIn(JSON.stringify({ url: LINK }))).toBe(LINK)
  expect(linkIn(`${LINK}\n`)).toBe(LINK)
  expect(linkIn('{"code": "x"}')).toBe('')
})

test("bug hunt F11: `/thimble browser` where no browser opens says so in plain words, with the command to run on your own computer and copy link; the SSH row says it too, and goes once a browser claims the link", T, async ($, on) => {
  const w = panelWorld(on)
  const tunnel = 'ssh -N -L 29321:127.0.0.1:29321 <your ssh host>'
  w.open = { ...w.open, remote: true, opened: false, tunnel, link_file: LINK_FILE }
  w.files.set(LINK_FILE, JSON.stringify({ url: LINK }))
  await start($, w)
  const said = ((await $.command.run({ command: 'thimble:thimble', args: 'browser' } as never)) as { text?: string }).text ?? ''
  expect(said).not.toContain("opening thimble's page")
  expect(said).toContain(`no browser opens here (a remote terminal, or no display). On your own computer, run ${tunnel}, then press copy link above the prompt`)
  expect(said).toContain('in place of <your ssh host>')
  await w.clock.settle()
  let m = (await $.ui.mount(aboveAt(200))) as unknown as M
  expect(words(await m.find({ type: 'Box', key: 'above-remote' }))).toBe(`  browserNo browser here. On your own computer, run ${tunnel}, then press copy link and open the link there.copycopy linkdismiss`)
  await m.unmount()
  // the browser signs in with the link: the row goes
  w.exists.add(CLAIM)
  await w.clock.advance(1100)
  await w.clock.settle()
  m = (await $.ui.mount(aboveAt(200))) as unknown as M
  expect(await m.find({ type: 'Box', key: 'above-remote' })).toBeUndefined()
  await m.unmount()
})

test("bug hunt round 9, J8: a tab of the page already open takes the press: the toast says that tab shows it, and `/thimble browser` says the page is open", T, async ($, on) => {
  const w = panelWorld(on)
  w.open = { ...w.open, reused: true }
  w.exists.add(CLAIM) // the server writes the claim mark once the tab took the press
  await start($, w)
  await press($, w, 'abc')
  await w.clock.advance(600)
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('shown in the thimble tab already open in your browser · 127.0.0.1:29321')
  const said = ((await $.command.run({ command: 'thimble:thimble', args: 'browser' } as never)) as { text?: string }).text ?? ''
  expect(said).toBe("thimble: thimble's page is already open in a tab of your browser")
})
