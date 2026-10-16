// thimble's activation in the terminal UI (term-transcript lane, build spec 3.3 and 3.4): the data rule, one
// activation per session, the push to the shim, bridgeActivated and the guide's delivery.
//
// SCAFFOLD STUB (C13): isActive is false until activateNow resolves; activateNow runs `thimble activate` (the backend's
// stub of C2) and keeps nothing else; isDataFile is the activation rule of 3.3 without its size test. Nothing here runs
// at import: the top level holds only imports, constants and functions (plugin/hooks/register.ts).
import type { Ctx } from './ctx'
import type { Via } from './contracts'
import { cliOf, parsePrinted } from './data'

const ACTIVATE_TIMEOUT_MS = 20_000
// 3.3: the segments, names and extensions of the data rule
const NEVER_SEGMENTS = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.claude', 'tests', 'test', 'fixtures', 'testdata', '__snapshots__', 'sample', 'samples', 'examples'])
const NEVER_NAMES = [/^package.*\.json$/, /^tsconfig.*\.json$/, /\.lock$/, /^composer\.json$/, /^\.eslintrc/]
const DATA_SEGMENTS = new Set(['data', 'datasets', 'runs', 'transcripts', 'traces', 'corpus', 'corpora'])
const DATA_EXTS = new Set(['csv', 'tsv', 'jsonl', 'ndjson', 'parquet', 'arrow', 'feather', 'xlsx', 'sqlite', 'db', 'duckdb', 'json', 'log'])
const CODE_TREE_EXTS = new Set(['csv', 'tsv', 'jsonl', 'ndjson', 'parquet', 'arrow', 'feather', 'xlsx', 'log'])

/** What this module knows of the session (module memory; a reload starts it over). */
const st = { active: false }

/** Whether thimble is on in this session (activateNow resolved with ok). */
export function isActive(): boolean {
  return st.active
}

/** Turn thimble on in this session: `thimble activate --cwd <folder> --via <via> --mod --json` (C2). */
export async function activateNow(cx: Ctx, via: Via): Promise<{ ok: boolean; error?: string }> {
  try {
    const bin = cliOf(cx.pluginRoot, (await cx.env('THIMBLE_TERM_CLI').catch(() => undefined)) || undefined)
    const cwd = await cx.root()
    const r = await cx.run([bin, 'activate', '--cwd', cwd, '--via', via, '--mod', '--json'], { cwd, timeoutMs: ACTIVATE_TIMEOUT_MS })
    const got = parsePrinted(r)
    if (!got.ok) return { ok: false, error: got.error }
    const v = got.value as { ok?: unknown; error?: { message?: unknown } }
    if (v.ok === true) {
      st.active = true
      return { ok: true }
    }
    return { ok: false, error: String(v.error?.message ?? 'thimble activate did not say ok').slice(0, 300) }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) }
  }
}

/** Whether `path` is a data file of the folder `cwd` (the twin of backend coverage.is_data). The stub is the activation
 *  rule of 3.3 without its size test: inside `cwd`, under no never-segment, no never-name; outside a code tree an
 *  extension of the data list; inside one, a data segment and a data extension other than `log`, or an extension of the
 *  code-tree list. */
export function isDataFile(cwd: string, path: string, codeTree: boolean): boolean {
  const root = cwd.replace(/\/+$/, '')
  const rel = path.startsWith('/') ? (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : '') : path.replace(/^\.\//, '')
  if (!rel || rel.split('/').includes('..')) return false
  const parts = rel.split('/')
  const name = parts.at(-1) ?? ''
  if (parts.slice(0, -1).some(p => NEVER_SEGMENTS.has(p))) return false
  if (NEVER_NAMES.some(re => re.test(name))) return false
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (!codeTree) return DATA_EXTS.has(ext)
  if (parts.slice(0, -1).some(p => DATA_SEGMENTS.has(p)) && DATA_EXTS.has(ext) && ext !== 'log') return true
  return CODE_TREE_EXTS.has(ext)
}
