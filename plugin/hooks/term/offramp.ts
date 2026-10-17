// The press: thimble's page opened in the browser on one object, signed in, on this session (SPEC-v2 3.15, C12).
// `thimble open --session <sid> --cwd <dir> --ref <ref> --json` starts the page when it is not running and opens the
// person's browser through a redirect file only they can read; it prints status alone, never a sign-in code. This file
// shows what happens: the toast `starting thimble's page…` at once; then, on this machine, a watch of the claim file for
// 12 s, which ends in the toast `opened in the browser · 127.0.0.1:<port>` or the notice `open:not-claimed`; over SSH
// or with no display, where no browser opens, the one row above the prompt that says so in plain words (remoteWords:
// run the tunnel command on your own computer, then copy link), whose `copy link` copies a one-time link that the open
// wrote to a file only the person can read; the row goes once a browser claims the link (watchLink). On Claude Code's
// main screen, which takes no clicks, the panel also opens on that row with its acts on keys (waitview.tsx).
// `/thimble browser` says which of these happened (openInBrowser's answer, register.tsx). A failure posts its notice
// (notices.tsx) with the acts that fix it. Where a signed-in tab of thimble's page is open and live, the open hands the
// object to it and opens no other tab (`reused`; bug hunt round 9, J8): the toast says the open tab shows it.
//
// Callers: `/thimble browser`, `o` and the title row's `↗` in every panel view (panel.tsx wayRow), a card's `↗`, the
// checks' `open in the browser`, a notice's `open ›` for a code ticket.
import type { Ctx } from './ctx'
import type { Links } from './types'
import { noControls } from './lib'
import { dismissModNotice, onNoticeAct, postNotice } from './notices'
import { classicScreen, openPanel, rt } from './term'

/** The key of the SSH row as home and the panel's `waiting` view name it (band.tsx waitItems, waitview.tsx). */
export const BROWSER_ITEM = 'browser'

/** How long the claim of a sign-in is watched for, and how often. */
export const CLAIM_MS = 12_000
const CLAIM_STEP_MS = 500
/** How long the SSH row waits for a browser to claim its one-time link (the link works for 5 minutes), and how often it
 *  looks. */
export const LINK_MS = 5 * 60_000
const LINK_STEP_MS = 1000
/** A second press on the same object this soon after the first runs no second open. */
const AGAIN_MS = 5_000

/** What `thimble open --json` prints (C12). */
export type OpenResult =
  | { ok: true; port: number; url: string; opened: boolean; remote: boolean; tunnel: string | null; et: string | null; link_file: string | null; claim_file: string; proxy: boolean; reused?: boolean }
  | { ok: false; error: { code: string; message: string; fix: string } }

// the one-time link's file of the last remote open (the SSH row's `copy link`), never shown
let linkFile = ''
// a browser claimed a sign-in of this session's: thimble's page shows there
let claimed = false

/** Whether a browser opened thimble's page from this session (a press's sign-in was claimed). */
export function browserShown(): boolean {
  return claimed
}
// the ref of the last open, for a notice's `try again` and `copy link`
let lastRef = 'home'
// the claim file of the SSH row's latest one-time link and until when it is watched (watchLink), and whether a watch runs
let remoteClaim: { file: string; until: number } | null = null
let watchingLink = false

/** What happened on a press: the page opens in a browser here (`opening`), the tab of the page already open shows it
 *  (`shown`), no browser opens here and the SSH row says what to do (`remote`), it failed and a notice says why
 *  (`failed`), or a press on the same object a moment ago still runs (`again`). */
export type OpenOutcome = 'opening' | 'shown' | 'remote' | 'failed' | 'again'

/** The toast once a press is in the browser: a new tab, or the tab already open (`reused`). */
export function openedWords(port: number, reused = false): string {
  return reused ? `shown in the thimble tab already open in your browser · 127.0.0.1:${port}` : `opened in the browser · 127.0.0.1:${port}`
}

/** The SSH row's words (bug hunt F11: `opening thimble's page in the browser` said nothing of what to do): no browser
 *  opens here, the tunnel command to run on your own computer, then copy link. */
export function remoteWords(l: Pick<Links, 'tunnel' | 'et'>): string {
  return `No browser here. On your own computer, run ${l.et ?? l.tunnel}, then press copy link and open the link there.`
}

/** What `/thimble browser` says after a press that opened no browser here: the command to run on your own computer, and
 *  where the one-time link is copied from: `copy link` above the prompt, or on Claude Code's main screen, which takes
 *  no clicks, `2` in the panel (waitview.tsx). */
export function remoteReply(l: Pick<Links, 'tunnel' | 'et'>, classic: boolean): string {
  const host = /<your ssh host>/.test(l.et ?? l.tunnel) ? ' Put the host you reach this machine by in place of <your ssh host> (THIMBLE_SSH_HOST fills it in).' : ''
  const copy = classic ? "press 2 in thimble's panel to copy a one-time link" : 'press copy link above the prompt to copy a one-time link'
  return `thimble: no browser opens here (a remote terminal, or no display). On your own computer, run ${l.et ?? l.tunnel}, then ${copy} and open it in your browser there; it works once, for 5 minutes.${host}`
}

/** The SSH row's one-time link in `file` watched until a browser claims it, from timers: then the row goes, since the
 *  browser is signed in (bug hunt F11). A newer link's file takes the place of an older one's; the watch ends with the
 *  row, or LINK_MS after the newest link. */
async function watchLink(cx: Ctx, file: string | null | undefined): Promise<void> {
  if (!file) return
  remoteClaim = { file, until: (await cx.now()) + LINK_MS }
  if (watchingLink) return
  watchingLink = true
  const look = (): void => {
    cx.later(LINK_STEP_MS, () => {
      void (async () => {
        const w = remoteClaim
        if (!w || !(await cx.links())) return void (watchingLink = false)
        if (await cx.stat(w.file).then(() => true, () => false)) {
          watchingLink = false
          remoteClaim = null
          claimed = true
          linkFile = ''
          await cx.setLinks(null)
          return
        }
        if ((await cx.now()) > w.until) return void (watchingLink = false)
        look()
      })().catch(() => void (watchingLink = false))
    })
  }
  look()
}

/** What a run of `thimble open` printed, as C12's answer; a run that printed no JSON is an error of its own. */
export function openResult(r: { exitCode: number; stdout: string; stderr: string }): OpenResult {
  try {
    const v = JSON.parse(r.stdout.trim()) as OpenResult
    if (v && typeof v === 'object' && typeof (v as { ok?: unknown }).ok === 'boolean') return v
  } catch {
    // not JSON
  }
  const why = r.stderr.trim().split('\n').filter(Boolean).at(-1) || (r.stdout.trim() ? 'it printed no JSON' : 'it printed nothing')
  return { ok: false, error: { code: 'START', message: noControls(why).slice(0, 300), fix: '' } }
}

async function runOpen(cx: Ctx, ref: string, more: string[] = []): Promise<OpenResult> {
  const sc = rt.sc
  if (!sc) return { ok: false, error: { code: 'NO_SESSION', message: 'thimble is not on in this session', fix: 'type /thimble' } }
  const sid = await cx.sessionId()
  try {
    const r = await cx.run([sc.bin, 'open', ...(sid ? ['--session', sid] : []), '--cwd', sc.cwd, '--ref', ref, ...more, '--json'], { cwd: sc.cwd, env: sc.env, timeoutMs: 60_000 })
    return openResult(r)
  } catch (err) {
    return { ok: false, error: { code: 'START', message: noControls(String(err)).slice(0, 300), fix: '' } }
  }
}

/** The one-time link a file holds (the open's `link_file`): its `url` or `link`, or its first line that is an address. */
export function linkIn(text: string): string {
  try {
    const v = JSON.parse(text) as { url?: unknown; link?: unknown }
    const u = typeof v?.url === 'string' ? v.url : typeof v?.link === 'string' ? v.link : ''
    if (/^https?:\/\//.test(u)) return u
  } catch {
    // a plain file
  }
  return text.split('\n').map(l => l.trim()).find(l => /^https?:\/\//.test(l)) ?? ''
}

/** A one-time link to thimble's page copied (it works once, for 5 minutes): the remote open's link file, else a link a
 *  new open writes (`--link`). The link is never drawn, logged or said. */
export async function copyLink(cx: Ctx, ref = lastRef): Promise<void> {
  let file = linkFile
  if (!file) {
    const got = await runOpen(cx, ref, ['--link'])
    if (!got.ok) return postFailed(cx, ref, got.error)
    file = got.link_file ?? ''
    // the SSH row goes once a browser claims this new link
    if (await cx.links()) await watchLink(cx, got.claim_file)
  }
  const link = file ? linkIn(await cx.read(file).catch(() => '')) : ''
  // a link works once: the next copy needs a new one
  linkFile = ''
  if (!link) return cx.toast('no link to copy: press o in the panel to open the page again')
  const r = await cx.copy(link)
  cx.toast(r.isCopied ? 'copied a link to thimble\'s page: it works once, for 5 minutes' : `could not copy the link: ${r.reason ?? 'no clipboard'}`)
}

function postFailed(cx: Ctx, ref: string, error: { code: string; message: string; fix: string }): void {
  if (error.code === 'NO_OPENER') {
    onNoticeAct('open:no-opener', 'copy link', () => copyLink(cx, ref))
    postNotice(cx, 'open:no-opener', 'No browser opener found. Use copy link, then paste the link into a browser on this machine.', ['copy link'])
    return
  }
  onNoticeAct('open:failed', 'try again', async () => {
    await dismissModNotice(cx, 'open:failed')
    await openInBrowser(cx, ref)
  })
  const why = [error.message, error.fix].filter(Boolean).join(' · ')
  postNotice(cx, 'open:failed', `thimble's page did not start: ${why || error.code}`, ['try again', 'doctor'])
}

/** The claim file watched every CLAIM_STEP_MS until it is there or CLAIM_MS pass (from timers, outside any hook); a tab
 *  already open that took the press (`reused`) wrote it at once. */
function watchClaim(cx: Ctx, file: string, port: number, ref: string, left = CLAIM_MS, reused = false): void {
  cx.later(CLAIM_STEP_MS, () => {
    void (async () => {
      const there = await cx.stat(file).then(() => true, () => false)
      if (there) {
        claimed = true
        await cx.setPressing(null)
        cx.toast(openedWords(port, reused))
        return
      }
      if (left - CLAIM_STEP_MS > 0) return watchClaim(cx, file, port, ref, left - CLAIM_STEP_MS, reused)
      await cx.setPressing(null)
      onNoticeAct('open:not-claimed', 'copy link', () => copyLink(cx, ref))
      postNotice(cx, 'open:not-claimed', "The browser did not open thimble's page.", ['copy link'])
    })()
  })
}

/** thimble's page opened in the browser on `ref` (SPEC-v2 C13): see the file's head. Never a code in a row, a toast or
 *  a log; the SSH row shows the tunnel command alone. */
export async function openInBrowser(cx: Ctx, ref: string): Promise<OpenOutcome> {
  if (!rt.sc) return 'failed'
  const now = await cx.now()
  const pressing = await cx.pressing()
  if (pressing && pressing.ref === ref && now - pressing.at < AGAIN_MS) return 'again'
  lastRef = ref
  await cx.setPressing({ at: now, ref })
  cx.toast("starting thimble's page…")
  const got = await runOpen(cx, ref)
  if (!got.ok) {
    await cx.setPressing(null)
    postFailed(cx, ref, got.error)
    return 'failed'
  }
  if (got.proxy) postNotice(cx, 'open:proxy', 'A proxy is set for this session; the browser link may not reach thimble. Set NO_PROXY=127.0.0.1,localhost.', [])
  if (got.remote) {
    await cx.setPressing(null)
    linkFile = got.link_file ?? ''
    const tunnel = noControls(got.tunnel ?? `ssh -N -L ${got.port}:127.0.0.1:${got.port} <your ssh host>`)
    await cx.setLinks({ tunnel, et: got.et ? noControls(got.et) : null, url: noControls(got.url) })
    await watchLink(cx, got.claim_file)
    // Claude Code's main screen takes no clicks, so the SSH row's `copy link` cannot be pressed there: the panel shows
    // the row with its acts on keys (waitview.tsx; bug hunt F1)
    if (classicScreen()) await openPanel(cx, { view: 'waiting', title: 'browser', slug: BROWSER_ITEM })
    return 'remote'
  }
  if (!got.opened) {
    await cx.setPressing(null)
    postFailed(cx, ref, { code: 'NO_OPENER', message: '', fix: '' })
    return 'failed'
  }
  watchClaim(cx, got.claim_file, got.port, ref, CLAIM_MS, !!got.reused)
  return got.reused ? 'shown' : 'opening'
}

/** The SSH row's `copy`: the tunnel command (its Eternal Terminal form when the open gave one). */
export async function copyTunnel(cx: Ctx): Promise<void> {
  const l = await cx.links()
  if (!l) return
  const r = await cx.copy(l.et ?? l.tunnel)
  cx.toast(r.isCopied ? 'copied the tunnel command: run it on your own computer, then open the link' : `could not copy: ${r.reason ?? 'no clipboard'}`)
}

/** The SSH row's `copy link`: the one-time link of the remote open. */
export async function copyRemoteLink(cx: Ctx): Promise<void> {
  await copyLink(cx)
}

/** The SSH row gone. */
export async function dismissLinks(cx: Ctx): Promise<void> {
  linkFile = ''
  remoteClaim = null
  await cx.setLinks(null)
}
