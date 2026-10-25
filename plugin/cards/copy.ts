// copy.ts: the cards an answer places on lines of their own, as text in what leaves the terminal. Claude Code's /copy
// and /export write the answer's words as they are stored, where a placed card is only its link; no hook sees their
// text on its way. So once the command ran, each file it wrote is read and written again with every placed card as
// its title and text copy (copy.mjs cardsAsText, draw.ts cardText): /copy's response.md, which is copied again, and
// /export's file. An export to the clipboard keeps the links, since nothing of it can be read back.
import type { EngineInterface, Register } from 'claude-code'

import { startDir } from '../core/env'
import { featureOn } from '../settings/features.mjs'
import { cardIdsIn, cardsAsText } from './copy.mjs'
import { cardText } from './draw'
import { metaOf } from './store'

type Engine = EngineInterface

/** The width /export draws the conversation at, so a card's lines fit beside its indent. */
const EXPORT_COLUMNS = 80

/** The cards a text names that have drawn: their titles and text copies. */
async function cardsIn($: Engine, text: string, width?: (indent: number) => number): Promise<Record<string, { title: string; text: string }>> {
  const out: Record<string, { title: string; text: string }> = {}
  for (const id of cardIdsIn(text)) {
    const meta = await metaOf($, id)
    if (!meta || meta.version < 1) continue
    const drawn = await cardText($, id, width?.(2)).catch(() => '')
    out[id] = { title: meta.title, text: drawn.startsWith('(the card did not draw') ? '' : drawn }
  }
  return out
}

/** A file the command wrote since `since`, read, its cards written in as text, and written again. The new text, or
 *  null when it holds no card. */
async function rewrite($: Engine, path: string, form: 'markdown' | 'export'): Promise<string | null> {
  const text = await $.fs.read(path)
  if (!cardIdsIn(text).length) return null
  const cards = await cardsIn($, text, form === 'export' ? indent => EXPORT_COLUMNS - indent - 2 : undefined)
  const next = cardsAsText(text, cards, form)
  if (next === text) return null
  await $.fs.write(path, next)
  return next
}

/** The newest file in `dir` named by `pick` and written since `since`. */
async function newest($: Engine, dir: string, since: number, pick: (name: string) => boolean): Promise<string | null> {
  const hits = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && f.mtimeMs >= since && pick(f.name))
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return hits[0] ? `${dir}/${hits[0].name}` : null
}

/** /copy's file: response.md in Claude Code's temp folder (`claude-<uid>/` in its TMPDIR). */
async function copied($: Engine, since: number): Promise<string | null> {
  const tmp = String((await $.env.get('CLAUDE_CODE_TMPDIR')) || (await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  for (const d of (await $.fs.list(tmp).catch(() => [])).filter(f => f.kind === 'dir' && f.name.startsWith('claude-'))) {
    const hit = await newest($, `${tmp}/${d.name}`, since, n => n === 'response.md')
    if (hit) return hit
  }
  return null
}

/** /export's file: the one its argument names (with .txt, as Claude Code adds it), else the newest .txt in the folder
 *  the session started in. */
async function exported($: Engine, args: string, since: number): Promise<string | null> {
  const root = await startDir($)
  const named = args.trim()
  if (named) {
    const path = named.startsWith('/') ? named : `${root}/${named}`
    for (const p of [path, `${path}.txt`]) if (await $.fs.exists(p)) return p
    return null
  }
  return newest($, root, since, n => n.endsWith('.txt'))
}

export const registerCardCopy: Register = on => {
  on('command.run', { command: 'copy' }, async ($, e, next) => {
    const since = Date.now() - 1000
    const r = await next(e)
    if (!featureOn('cards')) return r
    try {
      const path = await copied($, since)
      const text = path ? await rewrite($, path, 'markdown') : null
      if (text) await $.ui.copy({ text })
    } catch {
      // the copy stays as Claude Code made it
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'export' }, async ($, e, next) => {
    const since = Date.now() - 1000
    const r = await next(e)
    if (!featureOn('cards')) return r
    try {
      const path = await exported($, String(e.args ?? ''), since)
      if (path) await rewrite($, path, 'export')
    } catch {
      // the export stays as Claude Code wrote it
    }
    return r
  }).catch(($, e, next) => next(e))
}
