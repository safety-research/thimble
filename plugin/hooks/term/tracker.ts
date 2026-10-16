// What Claude's tool calls read of the data files (SPEC-v2 3.9, coverage): facts from the calls of main and its
// subagents, sent once per turn to `thimble act coverage --stdin` (C7), whose answer is the session's coverage summary
// and the line under the turn's answer. Programmatic only: a fact is what a call did to a file, never what a model wrote.
//
// A fact: a file seen whole or in part (its lines, or a PDF's pages), or searched (its contents touched by a search or a
// program without being shown: grep, rg, wc, awk, a script, a database shell, a binary Read), or a folder searched by a
// recursive grep or rg. Listing names (ls, find, fd) reads no contents and gives none; neither does an output argument.
// Only data files count (activate.ts isDataFile, the twin of the backend's rule), only paths inside the session folder,
// stored relative to it, and never the command's text. A refused or failed call gives none.
//
// Before thimble is on the facts stay in memory (a coding session keeps none: its files are not data); they go with
// the first turn end after it is on.
import type { CoverageSummary } from './contracts'
import type { Ctx } from './ctx'
import { actStdin } from './data'
import type { Pre } from './activate'
import { absolute, isDataFile, relInside } from './activate'
import { rt } from './term'

export type Fact = { path: string; how: 'whole' | 'part' | 'searched'; lines?: [number, number]; pages?: [number, number]; total?: number; folder?: true; by: 'Read' | 'Bash' | 'search' | 'agent'; at: number }

/** A file a Bash command reads, by the reader that names it: how (whole, part with lines, searched), and for grep and
 *  rg whether the search recurses (a folder there means every data file under it) or prints file names. */
export type BashRead = { reader: string; path: string; how: Fact['how']; lines?: [number, number]; recursive?: boolean }

/** The readers whose file arguments the tracker counts, and how each reads. */
const WHOLE = new Set(['cat', 'less', 'jq'])
const PART = new Set(['head', 'tail', 'sed'])
const SEARCH = new Set(['wc', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk'])
const PROGRAMS = new Set(['python', 'python3', 'duckdb', 'sqlite3', 'csvcut', 'mlr'])
/** Words before a command that run it (`sudo cat x`), skipped. */
const PREFIXES = new Set(['sudo', 'time', 'command', 'nice', 'nohup', 'env', 'exec'])
/** Extensions a path inside a program's code is taken for (`pd.read_csv('events.csv')`). */
const QUOTED_DATA = /['"]([^'"\s]+\.(?:csv|tsv|jsonl|ndjson|parquet|arrow|feather|xlsx|sqlite|db|duckdb|json|log|txt|md|pdf|xml|html?|vtt|srt|eml))['"]/g
const BINARY = new Set(['db', 'sqlite', 'duckdb', 'parquet', 'arrow', 'feather', 'xlsx'])

/** A shell command as words, cut into its simple commands at `|`, `;`, `&&`, `||`, `&` and newlines; quotes and
 *  backslashes kept apart from the words they quote. A heredoc's body is one word of the command before it. */
export function shellWords(command: string): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let word = ''
  let has = false
  const end = () => {
    if (has) cur.push(word)
    word = ''
    has = false
  }
  const cut = () => {
    end()
    if (cur.length) out.push(cur)
    cur = []
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (ch === "'") {
      const j = command.indexOf("'", i + 1)
      word += command.slice(i + 1, j < 0 ? command.length : j)
      has = true
      i = j < 0 ? command.length : j
    } else if (ch === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') j += command[j] === '\\' ? 2 : 1
      word += command.slice(i + 1, j).replace(/\\(.)/g, '$1')
      has = true
      i = j
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[i + 1] === '\n' ? '' : command[i + 1]
      has = command[i + 1] !== '\n' || has
      i++
    } else if (ch === '<' && command.startsWith('<<', i)) {
      // a heredoc: its body, up to the line that ends it, is one word of this command
      end()
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(i))
      if (!m) {
        i++
        continue
      }
      const bodyAt = command.indexOf('\n', i)
      if (bodyAt < 0) {
        i += m[0].length - 1
        continue
      }
      const stop = new RegExp(`\\n[\\t ]*${m[2]}[\\t ]*(?:\\n|$)`).exec(command.slice(bodyAt))
      const bodyEnd = stop ? bodyAt + stop.index : command.length
      // the rest of the heredoc's first line belongs to the command (`python3 - <<'EOF' > out.txt`)
      const rest = command.slice(i + m[0].length, bodyAt)
      cur.push(...shellWords(rest).flat())
      cur.push(command.slice(bodyAt + 1, bodyEnd))
      i = stop ? bodyEnd + stop[0].length - 1 : command.length
      cut()
    } else if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      if (ch === '&' && command[i + 1] === '>') {
        word += ch
        has = true
        continue
      }
      cut()
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++
    } else if (/\s/.test(ch)) end()
    else {
      word += ch
      has = true
    }
  }
  cut()
  return out
}

/** The value a short or long option takes: the next word, or what follows `=` or the letter. */
function optionValue(words: readonly string[], i: number, short: string, long: string[]): { value: string; next: number } | null {
  const w = words[i]!
  for (const l of long) {
    if (w === l) return { value: words[i + 1] ?? '', next: i + 1 }
    if (w.startsWith(`${l}=`)) return { value: w.slice(l.length + 1), next: i }
  }
  if (short && w === short) return { value: words[i + 1] ?? '', next: i + 1 }
  if (short && w.startsWith(short) && w.length > short.length && !w.startsWith('--')) return { value: w.slice(short.length), next: i }
  return null
}

const OUTPUT_LONG = /^--(?:out|output)[\w-]*$/

/** The files a Bash command's readers name, never an output argument (after `>`, `>>`, `-o`, `--out*`, `--output*`, or
 *  a `tee`, which is no reader), never a glob the shell would expand. */
export function bashReads(command: string): BashRead[] {
  const out: BashRead[] = []
  for (const all of shellWords(command)) {
    const words = [...all]
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || PREFIXES.has(words[0]!))) words.shift()
    const name = (words[0] ?? '').split('/').pop() ?? ''
    if (!WHOLE.has(name) && !PART.has(name) && !SEARCH.has(name) && !PROGRAMS.has(name)) continue
    const args: string[] = []
    const opts: string[] = []
    let nArg: string | undefined
    let lines: [number, number] | undefined
    let scriptGiven = false
    let quiet = false
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!
      // redirections: what follows a `>` is written; what follows a `<` is read
      if (/^\d*>{1,2}$|^&>$/.test(w)) {
        i++
        continue
      }
      if (/^\d*>{1,2}\S|^&>\S/.test(w)) continue
      if (w === '<') {
        if (words[i + 1]) args.push(words[i + 1]!)
        i++
        continue
      }
      if (OUTPUT_LONG.test(w)) {
        i++
        continue
      }
      if (/^--(?:out|output)[\w-]*=/.test(w)) continue
      if (w === '-o' && name !== 'grep' && name !== 'rg' && name !== 'egrep' && name !== 'fgrep') {
        i++
        continue
      }
      if (name === 'head' || name === 'tail') {
        const n = optionValue(words, i, '-n', ['--lines'])
        if (n) {
          nArg = n.value
          i = n.next
          continue
        }
        if (/^-\d+$/.test(w)) {
          nArg = w.slice(1)
          continue
        }
        const c = optionValue(words, i, '-c', ['--bytes'])
        if (c) {
          i = c.next
          continue
        }
      }
      if (name === 'sed') {
        if (w === '-n' || w === '--quiet' || w === '--silent') {
          quiet = true
          continue
        }
        if (w === '-i' || w.startsWith('-i') || w === '--in-place') {
          // an edit, not a reading
          args.length = 0
          opts.push('-i')
          break
        }
        const e = optionValue(words, i, '-e', ['--expression'])
        if (e) {
          scriptGiven = true
          lines = sedLines(e.value) ?? lines
          i = e.next
          continue
        }
      }
      if (name === 'awk' || name === 'gawk' || name === 'jq') {
        const f = optionValue(words, i, '-f', ['--from-file'])
        if (f) {
          scriptGiven = true
          i = f.next
          continue
        }
      }
      if (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg') {
        const e = optionValue(words, i, '-e', ['--regexp'])
        const f = e ? null : optionValue(words, i, '-f', ['--file'])
        if (e || f) {
          scriptGiven = true
          i = (e ?? f)!.next
          continue
        }
        // options that take a value: their value is no path
        const takes = optionValue(words, i, '', ['--glob', '--type', '--type-not', '--max-count', '--context', '--after-context', '--before-context', '--max-depth', '--include', '--exclude', '--exclude-dir', '--color', '--colour', '--sort', '--threads'])
        if (takes) {
          i = takes.next
          continue
        }
        if (/^-[gtTmABCM]$/.test(w)) {
          i++
          continue
        }
      }
      if (w.startsWith('-') && w !== '-') {
        opts.push(w)
        continue
      }
      args.push(w)
    }
    if (opts.includes('-i') && name === 'sed') continue
    let files = args
    if (name === 'sed' || name === 'awk' || name === 'gawk' || name === 'jq' || name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg') {
      // the first plain word is the script, the filter or the pattern, unless an option gave it
      if (!scriptGiven && files.length) {
        if (name === 'sed') lines = sedLines(files[0]!) ?? lines
        files = files.slice(1)
      }
    }
    const isGrep = name === 'grep' || name === 'egrep' || name === 'fgrep'
    const recursive = name === 'rg' ? !opts.some(o => o === '--files') : isGrep && opts.some(o => /^-[A-Za-z]*[rR]/.test(o) || o === '--recursive' || o === '--dereference-recursive')
    if (name === 'rg' && opts.includes('--files')) continue
    if ((name === 'rg' || (isGrep && recursive)) && !files.length) files = ['.']
    const how: Fact['how'] = WHOLE.has(name) ? 'whole' : PART.has(name) ? (name === 'sed' && !quiet ? 'whole' : 'part') : 'searched'
    if (name === 'head') {
      const n = Number((nArg ?? '10').replace(/^\+/, ''))
      if (Number.isInteger(n) && n > 0) lines = [1, n]
    }
    if (name === 'tail' && nArg?.startsWith('+')) lines = undefined
    for (const f of files) {
      if (!f || f === '-' || /[*?[\]{}$`]/.test(f)) continue
      out.push({ reader: name, path: f, how, ...(how === 'part' && lines ? { lines } : {}), ...(recursive ? { recursive: true } : {}) })
    }
    // a program's code that names a data file (`python3 -c "…read_csv('x.csv')"`, a heredoc, a SQL string)
    if (PROGRAMS.has(name)) {
      for (const w of words.slice(1)) for (const m of w.matchAll(QUOTED_DATA)) if (!/[*?[\]{}$`]/.test(m[1]!)) out.push({ reader: name, path: m[1]!, how: 'searched' })
    }
  }
  return out
}

/** The lines a sed script prints (`A,Bp`, `Ap`, `A,B{p;…}`), or undefined. */
function sedLines(script: string): [number, number] | undefined {
  const m = /^\s*(\d+)(?:\s*,\s*(\d+))?\s*(?:p|\{\s*p)/.exec(script)
  if (!m) return undefined
  const a = Number(m[1])
  const b = Number(m[2] ?? m[1])
  return a > 0 && b >= a ? [a, b] : undefined
}

// ------------------------------------------------------------------------------------------------ facts of a call

/** A call's input and answer as `tool.call` sees them. */
type Call = { tool: string; input: Record<string, unknown>; agentId?: string; result?: unknown; text?: string; deny?: string; isError?: boolean }

/** The facts one call gives (data files inside the session folder only; none for a refused or failed call). */
export async function factsOf(cx: Ctx, pre: Pre, c: Call): Promise<Fact[]> {
  if (c.deny !== undefined || c.isError) return []
  const at = (await cx.now()) / 1000
  const by = (own: Fact['by']): Fact['by'] => (c.agentId !== undefined ? 'agent' : own)
  const out: Fact[] = []
  // a file's path inside the folder (by its realpath), when it is data; with its kind ('dir' for a folder)
  const placed = async (p: string): Promise<{ rel: string; kind: string } | null> => {
    const st = await cx.real(absolute(pre, p))
    const real = st?.realPath
    if (!real) return null
    const rel = real === pre.real ? '.' : relInside(pre.real, real)
    if (rel === null) return null
    return { rel, kind: st.kind }
  }
  if (c.tool === 'Read') {
    const path = typeof c.input.file_path === 'string' ? c.input.file_path : ''
    const where = path ? await placed(path) : null
    if (!where || where.kind !== 'file' || !isDataFile(pre.real, where.rel, pre.codeTree, pre.never)) return []
    const r = (c.result ?? {}) as { type?: unknown; file?: { numLines?: unknown; startLine?: unknown; totalLines?: unknown; truncatedByTokenCap?: unknown; count?: unknown }; firstPage?: unknown; totalPages?: unknown }
    const f = r.file ?? {}
    const ext = where.rel.split('.').pop()?.toLowerCase() ?? ''
    if (r.type === 'file_unchanged') return []
    if (r.type === 'text' && !BINARY.has(ext)) {
      const n = Number(f.numLines)
      const start = Number(f.startLine) || 1
      const total = Number(f.totalLines)
      if (Number.isFinite(n) && Number.isFinite(total) && n >= total && f.truncatedByTokenCap !== true && start <= 1) out.push({ path: where.rel, how: 'whole', by: by('Read'), at })
      else out.push({ path: where.rel, how: 'part', ...(Number.isFinite(n) && n > 0 ? { lines: [start, start + n - 1] as [number, number] } : {}), ...(Number.isFinite(total) ? { total } : {}), by: by('Read'), at })
    } else if (r.type === 'pdf') out.push({ path: where.rel, how: 'whole', by: by('Read'), at })
    else if (r.type === 'parts') {
      const first = Number(r.firstPage) || 1
      const count = Number(f.count)
      out.push({ path: where.rel, how: 'part', ...(Number.isFinite(count) && count > 0 ? { pages: [first, first + count - 1] as [number, number] } : {}), ...(typeof r.totalPages === 'number' ? { total: r.totalPages } : {}), by: by('Read'), at })
    } else out.push({ path: where.rel, how: 'searched', by: by('Read'), at })
    return out
  }
  if (c.tool === 'Bash' && typeof c.input.command === 'string') {
    const reads = bashReads(c.input.command)
    const named = new Set<string>()
    for (const r of reads) {
      const where = await placed(r.path)
      if (!where) continue
      if (where.kind === 'dir') {
        if (r.recursive) out.push({ path: where.rel, how: 'searched', folder: true, by: by('search'), at })
        continue
      }
      if (where.kind !== 'file' || !isDataFile(pre.real, where.rel, pre.codeTree, pre.never)) continue
      named.add(where.rel)
      out.push({ path: where.rel, how: r.how, ...(r.lines ? { lines: r.lines } : {}), by: by(r.how === 'searched' && (r.reader === 'grep' || r.reader === 'rg') ? 'search' : 'Bash'), at })
    }
    // the files a `grep -l` or `rg -l` printed: searched
    const lists = shellWords(c.input.command).some(w => /^(?:grep|egrep|fgrep|rg)$/.test((w[0] ?? '').split('/').pop() ?? '') && w.some(x => /^-[A-Za-z]*l[A-Za-z]*$|^--files-with-matches$/.test(x)))
    if (lists) {
      const printed = typeof (c.result as { stdout?: unknown } | undefined)?.stdout === 'string' ? (c.result as { stdout: string }).stdout : (c.text ?? '')
      for (const line of printed.split('\n').slice(0, 200_000)) {
        const p = line.trim()
        if (!p || named.has(p)) continue
        const rel = p.startsWith('/') ? relInside(pre.real, p) : p.replace(/^\.\/+/, '')
        if (!rel || !isDataFile(pre.real, rel, pre.codeTree, pre.never)) continue
        named.add(rel)
        out.push({ path: rel, how: 'searched', by: by('search'), at })
      }
    }
    return out
  }
  if (c.tool === 'Grep') {
    // Claude Code's search tool in builds that have one: searched; a folder means every data file under it
    const path = typeof c.input.path === 'string' && c.input.path ? c.input.path : '.'
    const where = await placed(path)
    if (!where) return []
    if (where.kind === 'dir') return [{ path: where.rel, how: 'searched', folder: true, by: by('search'), at }]
    return where.kind === 'file' && isDataFile(pre.real, where.rel, pre.codeTree, pre.never) ? [{ path: where.rel, how: 'searched', by: by('search'), at }] : []
  }
  return []
}

// ------------------------------------------------------------------------------------------------ the turn's facts

/** The facts since the last flush (one per path and kind, the latest), the turn they go with. */
const held = { facts: [] as Fact[] }

/** Facts of a call kept for the turn's end. */
export function keepFacts(facts: readonly Fact[]): void {
  for (const f of facts) held.facts.push(f)
  if (held.facts.length > 250_000) held.facts.splice(0, held.facts.length - 250_000)
}

/** Whether facts wait for the turn's end. */
export function factsHeld(): number {
  return held.facts.length
}

/** A fresh session: no facts. */
export function resetTracker(): void {
  held.facts = []
}

/** The turn's facts sent (`thimble act coverage --stdin`, once per turn that has any): the session's summary, or null
 *  when there were none or the act failed. `turn` is the row the coverage line stands under. */
export async function flushFacts(cx: Ctx, session: string, turn: string): Promise<CoverageSummary | null> {
  if (!rt.sc || !held.facts.length) return null
  const facts = held.facts
  held.facts = []
  const got = await actStdin<{ summary?: CoverageSummary }>(cx, rt.sc, 'coverage', { session, turn, facts })
  if (!got.ok) {
    cx.log(`thimble: the turn's coverage was not recorded: ${got.error}`)
    return null
  }
  return summaryOf(got.value.summary)
}

/** A summary as C7 prints it, or null. */
export function summaryOf(v: unknown): CoverageSummary | null {
  const s = v as Partial<CoverageSummary> | null | undefined
  if (!s || typeof s !== 'object' || typeof s.line !== 'string') return null
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const files = (s.files ?? {}) as Partial<CoverageSummary['files']>
  const records = (s.records ?? {}) as Partial<CoverageSummary['records']>
  return { files: { seen: n(files.seen), searched: n(files.searched), never: n(files.never), total: n(files.total) }, records: { seen: n(records.seen), total: n(records.total), counted: records.counted === true }, line: s.line }
}
