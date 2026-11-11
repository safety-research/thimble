// stale.ts: a citation whose source changed after its check. The validator keeps what each citation it verified or
// corrected rests on (store.ts Source, engine/kernel/evidence.py source): the cited lines of a quote or of code, and
// the files that the code of computed evidence names, each with its size, mtime and the hash of what the check read.
// Nothing watches the files all the time. After each call of Claude's that can write a file (main's, a subagent's or
// a side thread's; never the checker's, which only reads), at the end of each of main's turns and at session start,
// examineSources stats each source's file. Only a source whose stat changed since it last looked goes to the kernel
// (`thimble dev validate` with its sources, kernel/evidence.py examine), which hashes what it rests on again: a source
// whose lines or file no longer hash as the check read them is `changed`, one whose file is not there `gone`, and its
// citation is stale (tray/tray.mjs staleOf). A source that reads as the check read it again (an edit undone) is no
// longer stale.
//
// A stale citation draws as marks/view.ts says (its words in the warning color, ↻ after them); its card says stale and
// which file changed (tray/tray.mjs staleLine), with x, which checks it again against the files as they are now
// (checker.ts repairOf): the usual result, verified, corrected or failed, with sources of its own.
//
//   examineSources($)   one pass over the conversation's sourced replies (store.ts sourcedReplies); a pass asked for
//                       while one runs runs once after it
//   WRITES              the tools whose calls can write a file, after which a pass runs (marks/register.ts)
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { startDir } from '../core/env'
import { errorWordsOf, validateArgv } from './checker'
import { editReply, replyOf, sourcedReplies, type MarkItem, type Source } from './store'

type Engine = EngineInterface

/** The tools whose calls can write a file. */
export const WRITES = /^(Bash|Edit|MultiEdit|Write|NotebookEdit)$/

/** A file's stat as the hooks read it, or null when it is not there or is no regular file. */
type Stat = { size: number; mtimeMs: number } | null

async function statOf($: Engine, path: string): Promise<Stat> {
  const st = await $.fs.stat(path).catch(() => null)
  return st && st.kind === 'file' ? { size: Number(st.size), mtimeMs: Number(st.mtimeMs) } : null
}

/** Whether a source's file stands otherwise than it last saw it: gone now and not then, or back, or another size or
 *  mtime (to the millisecond, as the kernel and the hooks each read it). */
function moved(st: Stat, s: Source): boolean {
  if (!st) return !s.gone
  return !!s.gone || st.size !== s.size || Math.abs(st.mtimeMs - s.mtime) >= 1
}

/** Whether a citation rests on what its check read: verified or corrected (a citation checked now, failed or not
 *  checked yet has no sources that count). */
const confirmed = (m: MarkItem) => (m.status === 'verified' || m.status === 'corrected') && !!m.sources?.length

const sameSource = (a: Source | undefined, b: Source) => !!a && a.path === b.path && a.sha256 === b.sha256 && a.line === b.line

/** The failure lines a pass gave this load, each once. */
const said = new Set<string>()

/** The sources as they stand now (kernel/evidence.py examine), in order, or null when the kernel could not answer
 *  (its failure line says so). */
async function examined($: Engine, sources: Source[]): Promise<Source[] | null> {
  try {
    const ran = await $.process.run(validateArgv($), { cwd: await startDir($), timeoutMs: 120000, stdin: JSON.stringify({ sources }) })
    const out = JSON.parse(String(ran.stdout || '')) as { sources?: Source[] }
    if (ran.exitCode !== 0 || !Array.isArray(out.sources) || out.sources.length !== sources.length) throw new Error(String(ran.stderr || 'no answer').trim().split('\n').pop())
    return out.sources
  } catch (err) {
    const line = `thimble could not compare the cited files with what its checks read (${await errorWordsOf($, err)}), so a citation does not show when its file changed. Reinstall thimble.`
    if (!said.has(line)) failNotice($, line, 'marks:stale')
    said.add(line)
    return null
  }
}

/** One pass: each source of the sourced replies' confirmed citations whose file stands otherwise than it last saw it
 *  goes to the kernel, and its citation keeps the source as it stands now. */
async function pass($: Engine): Promise<void> {
  const due: { key: string; n: number; k: number; s: Source }[] = []
  const stats = new Map<string, Stat>()
  for (const key of await sourcedReplies($)) {
    for (const m of (await replyOf($, key))?.items ?? []) {
      if (!confirmed(m)) continue
      for (const [k, s] of m.sources!.entries()) {
        if (!stats.has(s.path)) stats.set(s.path, await statOf($, s.path))
        if (moved(stats.get(s.path)!, s)) due.push({ key, n: m.n, k, s })
      }
    }
  }
  if (!due.length) return
  const now = await examined($, due.map(d => d.s))
  if (!now) return
  for (const key of new Set(due.map(d => d.key))) {
    const mine = due.map((d, i) => ({ ...d, now: now[i]! })).filter(d => d.key === key)
    // a citation checked again meanwhile keeps the sources of its new check
    await editReply($, key, r => ({ ...r, items: r.items.map(m => {
      const ds = mine.filter(d => d.n === m.n && confirmed(m) && sameSource(m.sources![d.k], d.s))
      if (!ds.length) return m
      const sources = m.sources!.map((s, k) => ds.find(d => d.k === k)?.now ?? s)
      return { ...m, sources }
    }) }))
  }
}

let running: Promise<void> | null = null
let again = false

/** A pass over the sourced replies (pass); one asked for while a pass runs runs once after it. */
export function examineSources($: Engine): Promise<void> {
  if (running) {
    again = true
    return running
  }
  const p = (async () => {
    try {
      do {
        again = false
        await pass($)
      } while (again)
    } finally {
      running = null
    }
  })()
  running = p
  return p
}
