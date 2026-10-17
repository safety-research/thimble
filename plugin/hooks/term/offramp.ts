// The press: thimble's page opened in the browser on one object, signed in, on this session (SPEC-v2 3.15, C12).
// `thimble open --session <sid> --cwd <dir> --ref <ref> --json` starts the page when it is not running and opens the
// person's browser through a redirect file only they can read; it prints status alone, never a sign-in code. This file
// shows what happens: the toast `starting thimble's page…` at once; then, on this machine, a watch of the claim file for
// 12 s, which ends in the toast `opened in the browser · 127.0.0.1:<port>` or the notice `open:not-claimed`; over SSH
// the one row above the prompt with the tunnel command (band.tsx), whose `copy link` copies a one-time link that the
// open wrote to a file only the person can read; on Claude Code's main screen, which takes no clicks, the panel also
// opens on that row with its acts on keys (waitview.tsx). A failure posts its notice (notices.tsx) with the acts that
// fix it.
//
// Callers: `/thimble browser`, `o` and the title row's `↗` in every panel view (panel.tsx wayRow), a card's `↗`, the
// checks' `open in the browser`, a notice's `open ›` for a code ticket.
import type { Ctx } from './ctx'
import { noControls } from './lib'
import { dismissModNotice, onNoticeAct, postNotice } from './notices'
import { classicScreen, openPanel, rt } from './term'

/** The key of the SSH row as home and the panel's `waiting` view name it (band.tsx waitItems, waitview.tsx). */
export const BROWSER_ITEM = 'browser'

/** How long the claim of a sign-in is watched for, and how often. */
export const CLAIM_MS = 12_000
const CLAIM_STEP_MS = 500
/** A second press on the same object this soon after the first runs no second open. */
const AGAIN_MS = 5_000

/** What `thimble open --json` prints (C12). */
export type OpenResult =
  | { ok: true; port: number; url: string; opened: boolean; remote: boolean; tunnel: string | null; et: string | null; link_file: string | null; claim_file: string; proxy: boolean }
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
  }
  const link = file ? linkIn(await cx.read(file).catch(() => '')) : ''
  // a link works once: the next copy needs a new one
  linkFile = ''
  if (!link) return cx.toast('thimble: no link to copy: press o in the panel to open the page again')
  const r = await cx.copy(link)
  cx.toast(r.isCopied ? 'thimble: copied a link to thimble\'s page: it works once, for 5 minutes' : `thimble: could not copy the link: ${r.reason ?? 'no clipboard'}`)
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

/** The claim file watched every CLAIM_STEP_MS until it is there or CLAIM_MS pass (from timers, outside any hook). */
function watchClaim(cx: Ctx, file: string, port: number, ref: string, left = CLAIM_MS): void {
  cx.later(CLAIM_STEP_MS, () => {
    void (async () => {
      const there = await cx.stat(file).then(() => true, () => false)
      if (there) {
        claimed = true
        await cx.setPressing(null)
        cx.toast(`opened in the browser · 127.0.0.1:${port}`)
        return
      }
      if (left - CLAIM_STEP_MS > 0) return watchClaim(cx, file, port, ref, left - CLAIM_STEP_MS)
      await cx.setPressing(null)
      onNoticeAct('open:not-claimed', 'copy link', () => copyLink(cx, ref))
      postNotice(cx, 'open:not-claimed', "The browser did not open thimble's page.", ['copy link'])
    })()
  })
}

/** thimble's page opened in the browser on `ref` (SPEC-v2 C13): see the file's head. Never a code in a row, a toast or
 *  a log; the SSH row shows the tunnel command alone. */
export async function openInBrowser(cx: Ctx, ref: string): Promise<void> {
  if (!rt.sc) return
  const now = await cx.now()
  const pressing = await cx.pressing()
  if (pressing && pressing.ref === ref && now - pressing.at < AGAIN_MS) return
  lastRef = ref
  await cx.setPressing({ at: now, ref })
  cx.toast("starting thimble's page…")
  const got = await runOpen(cx, ref)
  if (!got.ok) {
    await cx.setPressing(null)
    return postFailed(cx, ref, got.error)
  }
  if (got.proxy) postNotice(cx, 'open:proxy', 'A proxy is set for this session; the browser link may not reach thimble. Set NO_PROXY=127.0.0.1,localhost.', [])
  if (got.remote) {
    await cx.setPressing(null)
    linkFile = got.link_file ?? ''
    const tunnel = noControls(got.tunnel ?? `ssh -N -L ${got.port}:127.0.0.1:${got.port} <your ssh host>`)
    await cx.setLinks({ tunnel, et: got.et ? noControls(got.et) : null, url: noControls(got.url) })
    // Claude Code's main screen takes no clicks, so the SSH row's `copy link` cannot be pressed there: the panel shows
    // the row with its acts on keys (waitview.tsx; bug hunt F1)
    if (classicScreen()) await openPanel(cx, { view: 'waiting', title: 'browser', slug: BROWSER_ITEM })
    return
  }
  if (!got.opened) {
    await cx.setPressing(null)
    return postFailed(cx, ref, { code: 'NO_OPENER', message: '', fix: '' })
  }
  watchClaim(cx, got.claim_file, got.port, ref)
}

/** The SSH row's `copy`: the tunnel command (its Eternal Terminal form when the open gave one). */
export async function copyTunnel(cx: Ctx): Promise<void> {
  const l = await cx.links()
  if (!l) return
  const r = await cx.copy(l.et ?? l.tunnel)
  cx.toast(r.isCopied ? 'thimble: copied the tunnel command: run it on your own computer, then open the link' : `thimble: could not copy: ${r.reason ?? 'no clipboard'}`)
}

/** The SSH row's `copy link`: the one-time link of the remote open. */
export async function copyRemoteLink(cx: Ctx): Promise<void> {
  await copyLink(cx)
}

/** The SSH row gone. */
export async function dismissLinks(cx: Ctx): Promise<void> {
  linkFile = ''
  await cx.setLinks(null)
}
