// The press in the terminal UI (term-panel lane, build spec 3.15, C12): `thimble open` opens the browser on an object,
// signed in, with a toast at once, a watch of the claim file, the open:* notices and one SSH row when remote.
//
// SCAFFOLD STUB (C13): openInBrowser runs `thimble open --json` (the backend's stub answers NOT_BUILT) and shows its
// message as a toast. Nothing here runs at import.
import type { Ctx } from './ctx'
import { cliOf, parsePrinted } from './data'

const OPEN_TIMEOUT_MS = 60_000

/** Open the browser workbench on `ref` (C12 refs: card:<id>, view:<slug>, files:<folder>, checks, home, ...). */
export async function openInBrowser(cx: Ctx, ref: string): Promise<void> {
  try {
    const bin = cliOf(cx.pluginRoot, (await cx.env('THIMBLE_TERM_CLI').catch(() => undefined)) || undefined)
    const cwd = await cx.root()
    const got = parsePrinted(await cx.run([bin, 'open', '--cwd', cwd, '--ref', ref, '--json'], { cwd, timeoutMs: OPEN_TIMEOUT_MS }))
    const v = got.ok ? (got.value as { ok?: unknown; error?: { message?: unknown } }) : null
    if (v?.ok === true) return
    cx.toast(`thimble: ${String(v?.error?.message ?? (got.ok ? 'the browser did not open' : got.error)).slice(0, 200)}`)
  } catch (err) {
    cx.toast(`thimble: the browser did not open: ${String(err).slice(0, 200)}`)
  }
}
