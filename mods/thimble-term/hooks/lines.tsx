// Parts of the panel and the chat drawn from styled lines by the Client homeview.tsx (no `$`): the home panel, the
// threads tree, the lists, a link (a citation's title, a record's place, a passage's ↳). A click on a hit runs its
// closure, kept here by the drawing's stamp; a key goes to the drawing's key handler once a click gave it the keyboard.
import type { RenderElement, ResolveInput } from 'claude-code'

import type { Ctx } from './ctx'
import type { Line } from './draw'

/** A region of a part drawn from lines (homeview.tsx) and what a click on it does. */
export type LineHit = { y: number; x0: number; x1: number; row: boolean; run: () => Promise<void> | void }
// what each drawing's hits and keys do, by its stamp; the oldest are let go
const lineStamps = new Map<string, { runs: (() => Promise<void> | void)[]; key?: (k: string) => Promise<void> | void }>()
const lineSeen = new Map<string, number>()

function stampOf(key: string, lines: readonly Line[], hits: readonly LineHit[]): string {
  let h = 0x811c9dc5
  const s = `${key}\u0000${JSON.stringify(lines)}\u0000${hits.map(x => `${x.y},${x.x0},${x.x1},${x.row ? 1 : 0}`).join(';')}`
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `${key}:${(h >>> 0).toString(36)}`
}

/** A part drawn from styled lines by the Client homeview.tsx, `cols` wide: a click (left or right) on a hit runs it; its
 *  keys go to `onKey` once a click gave it the keyboard. Its key starts with `m:` when its lines bring the margin. */
export function linesEl(cx: Ctx, e: ResolveInput, key: string, lines: Line[], hits: LineHit[], cols: number, onKey?: (k: string) => Promise<void> | void): RenderElement {
  if (e.surface !== 'terminal' && e.surface !== 'desktop') {
    const { Text } = cx.els(e)
    return <Text key={key}>{lines.map(l => l.map(x => x.s).join('')).join('\n')}</Text>
  }
  const { Client } = cx.els(e)
  const stamp = stampOf(key, lines, hits)
  lineStamps.delete(stamp)
  lineStamps.set(stamp, { runs: hits.map(h => h.run), ...(onKey ? { key: onKey } : {}) })
  for (const k of [...lineStamps.keys()].slice(0, Math.max(0, lineStamps.size - 400))) lineStamps.delete(k)
  const packed = hits.flatMap((h, i) => [h.y, h.x0, h.x1, h.row ? 1 : 0, i])
  return <Client key={key} module="./homeview.tsx" width={cols} height={Math.max(1, lines.length)} props={JSON.parse(JSON.stringify({ lines, hits: packed, stamp, cols, ...(onKey ? { keys: true } : {}) })) as never} />
}

/** A post of homeview.tsx: each click and key not seen yet, by the drawing it was made in. */
export async function linesMessage(cx: Ctx, origin: unknown, raw: unknown): Promise<void> {
  if (!Array.isArray(raw) || typeof origin !== 'string') return
  for (const a of raw as { seq?: unknown; i?: unknown; k?: unknown; s?: unknown }[]) {
    if (typeof a?.seq !== 'number' || a.seq <= (lineSeen.get(origin) ?? 0)) continue
    lineSeen.set(origin, a.seq)
    const got = lineStamps.get(String(a.s))
    if (!got) continue
    if (typeof a.k === 'string') await got.key?.(a.k)
    else await got.runs[Number(a.i)]?.()
    await cx.bumpPanel()
  }
}

