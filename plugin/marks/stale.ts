// stale.ts: a citation whose source changed after its check. The validator keeps what each citation it verified or
// corrected rests on (store.ts Source, engine/kernel/evidence.py source): the cited lines of a quote or of code, and
// for computed evidence the files its code read when the check ran it again and the files its code names, each with
// its size, mtime and the hash of what the check read.
// Nothing watches the files. After each call of Claude's that can write a file (main's, a subagent's or a side
// thread's; never the checker's, which only reads), at the end of each of main's turns and at session start,
// examineSources makes one pass over the conversation's cited files (store.ts citedFiles: one entry a file, with the
// citations that rest on it): a stat of each file, once. Only a file whose stat changed since a pass last saw it is
// compared with what its citations rest on: by the stat alone when it tells (the file is gone, or a file cited whole
// has another size than its check read), else by the kernel (`thimble dev validate` with the citations that rest on
// it, kernel/evidence.py examine), which reads it once for all of them. A source whose lines or file no longer read as
// the check read them is `changed`, one whose file is not there `gone`, and its citation is stale (tray/tray.mjs
// staleOf). Cited lines that only moved (an edit above them) are no change: the citation takes their new numbers, in
// its sources and in the place its evidence shows. A source that reads as the check read it again (an edit undone) is
// no longer stale. Computed evidence whose code the check ran again (store.ts Rerun) is not stale for a change alone:
// the kernel runs its code again in thimble's sandbox, with no model, once for each code however many citations rest
// on it, and the citation goes stale only when that run no longer prints the output the check gave; when it does, the
// citation rests on what that run read (the kernel's `rests`). A citation stale already is not run again: x checks it.
// So a pass costs a stat for each cited file, however many files the folder holds and however many citations rest on
// each, and the replies it reads are only those whose citations rest on a file that changed.
//
// A stale citation draws as marks/view.ts says (its words in the warning color, ↻ after them); its card says stale and
// which file changed (tray/tray.mjs staleLine), with x, which checks it again against the files as they are now
// (checker.ts repairOf): the usual result, verified, corrected or failed, with sources of its own.
//
//   examineSources($)   one pass over the cited files; a pass asked for while one runs runs once after it
//   WRITES              the tools whose calls can write a file, after which a pass runs (marks/register.ts)
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { startDir } from '../core/env'
import { claudeTempDir, tempDir } from '../core/home'
import { staleOf } from '../tray/tray.mjs'
import { errorWordsOf, validateArgv } from './checker'
import { citedFiles, editReply, replyOf, sameSeen, sawFiles, type Evidence, type MarkItem, type Rerun, type Seen, type Source } from './store'

type Engine = EngineInterface

/** The tools whose calls can write a file. */
export const WRITES = /^(Bash|Edit|MultiEdit|Write|NotebookEdit)$/

/** A file as the hooks see it now: its size and mtime, or `gone` when it is not there or is no regular file. */
async function seenOf($: Engine, path: string): Promise<Seen> {
  const st = await $.fs.stat(path).catch(() => null)
  return st && st.kind === 'file' ? { size: Number(st.size), mtime: Number(st.mtimeMs) } : { gone: true }
}

/** Whether a citation rests on what its check read: verified or corrected (a citation checked now, failed or not
 *  checked yet has no sources that count). */
const confirmed = (m: MarkItem) => (m.status === 'verified' || m.status === 'corrected') && !!m.sources?.length

const sameSource = (a: Source | undefined, b: Source) => !!a && a.path === b.path && a.sha256 === b.sha256 && a.line === b.line

/** A citation's sources on the files a pass compares, its evidence and what runs its code again, as the kernel takes
 *  them (examine); the kernel answers `rests` for one whose code it ran again and that printed what its check gave:
 *  every source it rests on now. */
type Cited = { sources: Source[]; evidence?: Evidence; rerun?: Rerun; rests?: Source[] }

/** The failure lines a pass gave this load, each once. */
const said = new Set<string>()

/** The citations as they stand now (kernel/evidence.py examine), in order: their sources, and their evidence when
 *  lines they cite moved; null when the kernel could not answer (its failure line says so). The kernel gets the
 *  session's folders, which a run of computed evidence's code may read. */
async function examined($: Engine, cited: Cited[]): Promise<Cited[] | null> {
  try {
    const root = await startDir($)
    const tmp = [await tempDir($), await claudeTempDir($).catch(() => '')].filter(Boolean)
    const stdin = JSON.stringify({ cited, cwd: String(await $.session.cwd()), root, tmp })
    const ran = await $.process.run(validateArgv($), { cwd: root, timeoutMs: 120000, stdin })
    const out = JSON.parse(String(ran.stdout || '')) as { cited?: Cited[] }
    if (ran.exitCode !== 0 || !Array.isArray(out.cited) || out.cited.length !== cited.length) throw new Error(String(ran.stderr || 'no answer').trim().split('\n').pop())
    return out.cited
  } catch (err) {
    const line = `thimble could not compare the cited files with what its checks read (${await errorWordsOf($, err)}), so a citation does not show when its file changed. Reinstall thimble.`
    if (!said.has(line)) failNotice($, line, 'marks:stale')
    said.add(line)
    return null
  }
}

/** One pass: a stat of each cited file; the citations that rest on the files whose stat changed are compared with
 *  them (by the stat alone where it tells, else by the kernel), and each keeps its sources (and evidence) as they stand
 *  now. */
async function pass($: Engine): Promise<void> {
  const files = await citedFiles($)
  const now: Record<string, Seen> = {}
  for (const [path, f] of Object.entries(files)) {
    const seen = await seenOf($, path)
    if (!sameSeen(seen, f.seen)) now[path] = seen
  }
  const due = new Set(Object.keys(now))
  if (!due.size) return
  // the citations that rest on those files, from the replies that hold them: each with its sources there, and for
  // computed evidence that is not stale yet, what runs its code again
  const asked: { key: string; n: number; ks: number[]; sent: Source[]; evidence?: Evidence; rerun?: Rerun }[] = []
  for (const key of new Set([...due].flatMap(p => Object.keys(files[p]!.by)))) {
    for (const m of (await replyOf($, key))?.items ?? []) {
      const ks = confirmed(m) ? m.sources!.flatMap((s, k) => (due.has(s.path) ? [k] : [])) : []
      const rerun = m.rerun && !staleOf(m).length ? { rerun: m.rerun } : {}
      if (ks.length) asked.push({ key, n: m.n, ks, sent: ks.map(k => m.sources![k]!), ...(m.evidence ? { evidence: m.evidence } : {}), ...rerun })
    }
  }
  if (asked.length) {
    // what the stat alone says, as the kernel would say it (kernel/evidence.py examine_file): a file that is gone, and
    // a file cited whole whose size is not the one its check read, which has changed; the kernel reads the rest, and
    // decides each citation whose code it runs again. So a log cited whole that grows at each pass costs a stat, and
    // no process
    const known = (s: Source): Source | null => {
      const seen = now[s.path]
      const { changed: _c, gone: _g, ...base } = s
      if (seen && 'gone' in seen) return { ...base, gone: true }
      if (seen && !s.line && seen.size !== s.size) return { ...base, changed: true }
      return null
    }
    const read = asked.filter(a => a.rerun || a.sent.some(s => !known(s)))
    const got = read.length ? await examined($, read.map(a => ({ sources: a.sent, ...(a.evidence ? { evidence: a.evidence } : {}), ...(a.rerun ? { rerun: a.rerun } : {}) }))) : []
    if (!got) return
    const answers = new Map(read.map((a, i) => [a, got[i]!]))
    const changed = asked.map(a => ({ ...a, now: answers.get(a) ?? ({ sources: a.sent.map(s => known(s)!) } as Cited) }))
      .filter(a => a.now.evidence || a.now.rests || JSON.stringify(a.now.sources) !== JSON.stringify(a.sent))
    for (const key of new Set(changed.map(a => a.key))) {
      const mine = changed.filter(a => a.key === key)
      // a citation checked again meanwhile keeps the sources of its new check
      await editReply($, key, r => ({ ...r, items: r.items.map(m => {
        const a = mine.find(x => x.n === m.n)
        if (!a || !confirmed(m) || !a.ks.every((k, j) => sameSource(m.sources![k], a.sent[j]!))) return m
        // a citation whose code printed what its check gave rests on what that run read
        if (a.now.rests) return { ...m, sources: a.now.rests }
        const sources = [...m.sources!]
        a.ks.forEach((k, j) => { sources[k] = a.now.sources[j]! })
        return { ...m, sources, ...(a.now.evidence ? { evidence: a.now.evidence } : {}) }
      }) }))
    }
  }
  await sawFiles($, now)
}

let running: Promise<void> | null = null
let again = false

/** A pass over the cited files (pass); one asked for while a pass runs runs once after it. */
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
