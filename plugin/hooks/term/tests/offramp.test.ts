// The press (offramp.ts, SPEC-v2 3.15, C12): `thimble open --session <sid> --cwd <dir> --ref <ref> --json`, a toast at
// once, a watch of the claim file that ends in `opened in the browser` or the `open:not-claimed` notice with `copy link`;
// over SSH the one row with the tunnel command (its ET form when given), `copy`, `copy link` and `dismiss`; a failure's
// notice with the acts that fix it; no sign-in code in a row, a toast or a copy but the one `copy link` makes.
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
  expect(w.toasts).toContain("thimble: The browser did not open thimble's page.")
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

test('over SSH: one row with the tunnel command, `copy`, `copy link` and `dismiss`; the ET form in its place when given', T, async ($, on) => {
  const w = panelWorld(on)
  w.open = { ...w.open, remote: true, opened: false, tunnel: 'ssh -N -L 29321:127.0.0.1:29321 <your ssh host>', link_file: LINK_FILE }
  w.files.set(LINK_FILE, JSON.stringify({ url: LINK }))
  await start($, w)
  await press($, w)
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(words(await m.find({ type: 'Box', key: 'above-remote' }))).toBe('  browserssh -N -L 29321:127.0.0.1:29321 <your ssh host>copycopy linkdismiss')
  await m.press({ key: 'above-remote-copy' })
  await m.press({ key: 'above-remote-link' })
  await w.clock.settle()
  expect(w.copied).toEqual(['ssh -N -L 29321:127.0.0.1:29321 <your ssh host>', LINK])
  expect(JSON.stringify(await m.drawn())).not.toContain('one-time-code')
  await m.press({ key: 'above-remote-dismiss' })
  await w.clock.settle()
  expect(await m.find({ type: 'Box', key: 'above-remote' })).toBeUndefined()
  await m.unmount()
  // the Eternal Terminal form
  w.open = { ...w.open, et: 'et -t 29321:29321 <your ssh host>' }
  await w.clock.advance(6000)
  await press($, w, 'ff73e071')
  await pressBrowser($, w)
  const m2 = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(words(await m2.find({ type: 'Box', key: 'above-remote' }))).toBe('  browseret -t 29321:29321 <your ssh host>copycopy linkdismiss')
  await m2.unmount()
})

test("a failure posts its notice with the acts that fix it: the page did not start (try again, doctor), no browser opener (copy link), a proxy", T, async ($, on) => {
  const w = panelWorld(on)
  w.open = { ok: false, error: { code: 'START', message: 'the server did not answer on 127.0.0.1:29321', fix: 'run thimble doctor' } }
  await start($, w)
  await press($, w)
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(words(await m.find({ type: 'Box', key: 'above-mod-open-failed' }))).toBe("  noticethimble's page did not start: the server did not answer on 127.0.0.1:29321 · run thimble doctortry againdoctordismiss")
  // try again runs the open again
  w.open = { ok: false, error: { code: 'NO_OPENER', message: 'no opener', fix: '' } }
  await w.clock.advance(6000)
  await m.press({ key: 'above-mod-open-failed-act-0' })
  await w.clock.settle()
  expect(w.pressed.length).toBe(2)
  expect(await m.find({ type: 'Box', key: 'above-mod-open-failed' })).toBeUndefined()
  expect(words(await m.find({ type: 'Box', key: 'above-mod-open-no-opener' }))).toContain('No browser opener found.')
  await m.unmount()
  w.open = { ok: true, port: 29321, url: 'http://127.0.0.1:29321/', opened: true, remote: false, tunnel: null, et: null, link_file: null, claim_file: CLAIM, proxy: true }
  await w.clock.advance(6000)
  await press($, w, 'ff73e071')
  await pressBrowser($, w)
  const m2 = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(words(await m2.find({ type: 'Box', key: 'above-mod-open-proxy' }))).toContain('Set NO_PROXY=127.0.0.1,localhost.')
  await m2.unmount()
})

test("open's answer and a link file read as C12 writes them", () => {
  expect(openResult({ exitCode: 0, stdout: '{"ok": false, "error": {"code": "NOT_BUILT", "message": "thimble open is not built yet", "fix": "wait"}}', stderr: '' })).toEqual({ ok: false, error: { code: 'NOT_BUILT', message: 'thimble open is not built yet', fix: 'wait' } })
  expect(openResult({ exitCode: 1, stdout: '', stderr: 'Traceback\nOSError: no' })).toEqual({ ok: false, error: { code: 'START', message: 'OSError: no', fix: '' } })
  expect(linkIn(JSON.stringify({ url: LINK }))).toBe(LINK)
  expect(linkIn(`${LINK}\n`)).toBe(LINK)
  expect(linkIn('{"code": "x"}')).toBe('')
})
