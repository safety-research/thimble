// watch.ts: what Claude's own calls touched, for `thimble coverage`. It only watches. After each Read, Grep or Bash call
// of the session (or of a subagent, the v designer fork included) it keeps which file was touched and which lines, so
// `thimble coverage` can say what Claude read and what it did not. The checker fork's calls are not kept: it reads
// files to check a reply, not to answer the analyst. It never answers, allows or refuses a call, never shows anything, and starts no process. What it keeps:
// one JSON line per call in $THIMBLE_HOME/lean/seen/<session>.jsonl (default ~/.thimble), never the file's content:
//
//   Read  {tool, file, from, to, pages?}  the first and last line the result showed (none for a picture or a PDF), and
//                                       the pages it asked for of a PDF (`1-5`)
//   Grep  {tool, path, glob, mode, files, lines}  the search's scope, its output mode, the files it matched, and the
//                                       lines it showed
//   Bash  {tool, command, out_lines, refs}  the command, how many lines its output had as Claude read it, and the
//                                       row refs the output named (`revisions.jsonl#L4111`), a row's identity and not
//                                       its content (coverage leaves out a `thimble` command: a label keeps what it went over)
//
// It also sets THIMBLE_SESSION for the session's commands, so `thimble` files its records under the same session, and
// THIMBLE_START, the folder the session started in ($.session.root(), which a shell `cd` does not move), so a command
// run after `cd src` keeps its records in the start folder's thimble/ (kernel/store.py find_root). At the
// conversation's first turn it notes the conversation's key (conversation.ts), so a continuation keeps its records.
import type { EngineInterface, Register } from 'claude-code'

import { noteConversation, sessionKey } from './conversation'
import { forkOf } from '../core/forks'

type Row = Record<string, unknown>
type Engine = EngineInterface

const PART_MAX = 3_500_000 // characters of one seen file ($.fs.write takes up to 4 MiB)
const LINES_MAX = 400 // line numbers kept of one file's Grep hits
const FILES_MAX = 500
const REFS_MAX = 2000 // row refs kept of one Bash output

const S = { session: '', file: '', part: 1, rows: [] as string[], size: 0, loaded: false, home: '' }

/** A Read result's first and last line numbers (`   12\t…` or `12→…`), or null when it shows none. */
export function readRange(text: string): { from: number; to: number } | null {
  const nums: number[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)(?:\t|→)/.exec(line)
    if (m) nums.push(Number(m[1]))
  }
  if (!nums.length) return null
  return { from: Math.min(...nums), to: Math.max(...nums) }
}

/** The files a Grep result names and the line numbers it shows per file, from any of its output modes. */
export function grepHits(text: string): { files: string[]; lines: Record<string, number[]> } {
  const files: string[] = []
  const lines: Record<string, number[]> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line.startsWith('/')) continue
    const m = /^(\/[^:\n]*?)(?:[:-](\d+)[:-]|:(\d+)$|$)/.exec(line)
    if (!m || !m[1]) continue
    const file = m[1]
    if (!files.includes(file) && files.length < FILES_MAX) files.push(file)
    const n = m[2] ? Number(m[2]) : undefined
    if (n !== undefined) {
      const xs = (lines[file] ??= [])
      if (xs.length < LINES_MAX) xs.push(n)
    }
  }
  return { files, lines }
}

/** The row refs a command's output names, once each, in order: a path, `#` and the row's place in its file
 *  (`revisions.jsonl#L4111`, `runs.csv#row=3`, `forge.db#prs/12`). Coverage counts the files they name as touched; a
 *  ref is a row's name, not its content, so no row of them is read. A ref cut short (`…`) names no row. */
export function rowRefs(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[^\s'"`()[\]<>{}|#=:,]+#[^\s'"`()[\]<>{}|#]+/g)) {
    const t = m[0]
    if (t.endsWith('…') || t.endsWith('...')) continue
    out.add(t.replace(/[.,;:]+$/, ''))
    if (out.size >= REFS_MAX) break
  }
  return [...out]
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'

async function bind($: Engine): Promise<void> {
  const id = await sessionKey($)
  if (id === S.session && S.file) return
  S.session = id
  S.part = 1
  S.rows = []
  S.size = 0
  S.loaded = false
  if (!S.home) S.home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  S.file = `${S.home}/lean/seen/${safe(id)}.jsonl`
  await $.env.set('THIMBLE_SESSION', id)
}

async function keep($: Engine, row: Row): Promise<void> {
  await bind($)
  if (!S.loaded) {
    S.loaded = true
    // a reload of this module mid-session: go on after what the earlier load kept
    while (await $.fs.exists(S.file)) {
      const text = String(await $.fs.read(S.file))
      if (text.length < PART_MAX) {
        S.rows = text.split('\n').filter(Boolean)
        S.size = text.length
        break
      }
      S.part += 1
      S.file = `${S.home}/lean/seen/${safe(S.session)}.${S.part}.jsonl`
    }
  }
  const line = JSON.stringify({ t: Date.now() / 1000, session: S.session, cwd: await $.session.cwd(), ...row })
  if (S.size + line.length + 1 > PART_MAX) {
    S.part += 1
    S.file = `${S.home}/lean/seen/${safe(S.session)}.${S.part}.jsonl`
    S.rows = []
    S.size = 0
  }
  S.rows.push(line)
  S.size += line.length + 1
  await $.fs.write(S.file, S.rows.join('\n') + '\n')
}

function resultText(r: { text?: unknown; result?: unknown }): string {
  if (typeof r.text === 'string') return r.text
  return typeof r.result === 'string' ? r.result : ''
}

/** Sets THIMBLE_START to the folder the session started in: its project root, else the cwd it started with. */
async function anchor($: Engine, cwd: unknown): Promise<void> {
  let root = ''
  try {
    root = String((await $.session.root()) || '')
  } catch {
    // an engine with no project root: the folder the session started in
  }
  if (!root && typeof cwd === 'string') root = cwd
  if (root.startsWith('/')) await $.env.set('THIMBLE_START', root)
}

export const registerWatch: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await bind($)
    } catch {
      // the module only watches; a session it cannot bind is left as it is
    }
    try {
      await anchor($, (e as { cwd?: unknown }).cwd)
    } catch {
      // the records then follow the working folder, as outside a session
    }
    return r
  })

  // the conversation's first turn: a later session that continues it finds its records under the same key
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try { await noteConversation($) } catch { /* a continuation then starts its own records */ }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const tool = String(e.tool)
    if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Bash') return r
    if (forkOf(e.agentId)?.kind === 'checker') return r
    try {
      if (r.deny !== undefined) return r
      const input = e as unknown as Record<string, unknown>
      const agent = typeof input.agentId === 'string' ? { agent: input.agentId } : {}
      if (tool === 'Read' && !r.isError) {
        const range = readRange(resultText(r))
        const pages = typeof input.pages === 'string' && input.pages ? { pages: input.pages } : {}
        await keep($, { tool, file: input.file_path, ...(range ?? { from: null, to: null }), ...pages, ...agent })
      } else if (tool === 'Grep' && !r.isError) {
        const hits = grepHits(resultText(r))
        await keep($, { tool, path: input.path ?? null, glob: input.glob ?? input.type ?? null, mode: input.output_mode ?? 'files_with_matches', ...hits, ...agent })
      } else if (tool === 'Bash') {
        // a file the command printed counts as read for no more lines than reached Claude (a long output is cut)
        const res = r.result as { stdout?: unknown; stderr?: unknown } | undefined
        const out = resultText(r) || (res && typeof res === 'object' ? [res.stdout, res.stderr].filter(x => typeof x === 'string' && x).join('\n') : '')
        const refs = out ? rowRefs(out) : []
        await keep($, { tool, command: String(input.command ?? '').slice(0, 2000), out_lines: out ? out.replace(/\n+$/, '').split('\n').length : 0, ...(refs.length ? { refs } : {}), ...agent })
      }
    } catch {
      // never let watching change a call's result
    }
    return r
  }).catch(($, e, next) => next(e)) // it never gates: if it fails, the call goes on (or keeps the result it had)
}
