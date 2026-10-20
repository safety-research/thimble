// thimble's kernel: its one hooks module. It only watches. After each Read, Grep or Bash call of the session (or
// of a subagent) it keeps which file was touched and which lines, so `thimble coverage` can say what Claude read and what
// it did not. It never answers, allows or refuses a call, never shows anything, and starts no process. What it keeps:
// one JSON line per call in $THIMBLE_HOME/lean/seen/<session>.jsonl (default ~/.thimble), never the file's content:
//
//   Read  {tool, file, from, to}        the first and last line the result showed (none for a picture or a PDF)
//   Grep  {tool, path, glob, files, lines}  the search's scope, the files it matched, and the lines it showed
//   Bash  {tool, command}               the command (the `thimble` command keeps its own record)
//
// It also sets THIMBLE_SESSION for the session's commands, so `thimble` files its records under the same session.
import type { EngineInterface, Register } from 'claude-code'

import { sessionKey } from './conversation'

type Row = Record<string, unknown>
type Engine = EngineInterface

const PART_MAX = 3_500_000 // characters of one seen file ($.fs.write takes up to 4 MiB)
const LINES_MAX = 400 // line numbers kept of one file's Grep hits
const FILES_MAX = 500

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await bind($)
    } catch {
      // the module only watches; a session it cannot bind is left as it is
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const tool = String(e.tool)
    if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Bash') return r
    try {
      if (r.deny !== undefined) return r
      const input = e as unknown as Record<string, unknown>
      const agent = typeof input.agentId === 'string' ? { agent: input.agentId } : {}
      if (tool === 'Read' && !r.isError) {
        const range = readRange(resultText(r))
        await keep($, { tool, file: input.file_path, ...(range ?? { from: null, to: null }), ...agent })
      } else if (tool === 'Grep' && !r.isError) {
        const hits = grepHits(resultText(r))
        await keep($, { tool, path: input.path ?? null, glob: input.glob ?? input.type ?? null, ...hits, ...agent })
      } else if (tool === 'Bash') {
        await keep($, { tool, command: String(input.command ?? '').slice(0, 2000), ...agent })
      }
    } catch {
      // never let watching change a call's result
    }
    return r
  }).catch(($, e, next) => next(e)) // it never gates: if it fails, the call goes on (or keeps the result it had)
}
