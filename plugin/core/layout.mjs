// layout.mjs: where thimble keeps its records, and the names it gives them. Pure: no `$`, no Node. The hooks module
// (core/home.ts), `thimble dev stats` (telemetry/stats.mjs) and the tests import it; engine/kernel/store.py writes the
// same layout with the same names (a test on each side checks one name).
//
// Under $THIMBLE_HOME (default ~/.thimble):
//
//   conversations/<conversation>/   what thimble keeps of one conversation, for a resumed session: a new conversation
//                                   shows nothing of another's, and a resumed one shows its own again
//       marks/<reply>.json            a reply's marks and their check (marks/store.ts)
//       cards/<card>/                 a card: meta.json, v<version>/{view.js, rows.json}, state.json (cards/store.ts)
//       tell.json                     what Claude reads with the person's next prompt (core/tell.ts)
//       answer.json                   the answer v draws under (designer/v.ts)
//       folders/<folder>/labels/      the labels it made in a folder (engine/kernel/store.py kept_dir)
//   starts/<first launch>.json      the conversation a first launch belongs to (hooks/conversation.ts)
//   events/<conversation>.jsonl     the kernel's change feed and the telemetry's lines (core/feed.ts, telemetry/)
//   seen/<conversation>.jsonl       what Claude's calls touched, for coverage (hooks/watch.ts)
//   cache/<folder>/                 a folder's row counts, and what coverage reads of the labels: speed only
//                                   (engine/kernel/store.py)
//   folders/<folder>/labels/        the labels of thimble 0.10 and before, one set per folder: kept, never shown
//   fixes/                          the fixes (engine/kernel/fix.py)
//   run/                            the card runner's socket (cards/ask.ts)
//   tmp/                            the temp folder of a session that has no TMPDIR (core/home.ts tempDir)
//
// <conversation> is safeName of the conversation's key; <folder> is folderName of the folder's real path.

/** A name for a file or a folder: letters, digits, - and _, at most 80 characters. */
export const safeName = s => String(s ?? '').replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 80) || 'none'

/** A short name made from any text: 12 hex digits (two FNV-1a hashes). Not for security: it only keeps names apart. */
export function shortHash(s) {
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0').slice(0, 4)}`
}

/** A folder's name under folders/ and cache/: the end of its path, to read, and a hash of the whole path, so two
 *  folders never share one (`/w/run.1` and `/w/run-1` differ). The kernel makes the same name (store.py folder_name). */
export function folderName(realPath) {
  const tail = String(realPath).replace(/[^A-Za-z0-9_-]/gu, '-').slice(-40).replace(/^-+/, '')
  return `${tail || 'root'}-${shortHash(realPath)}`
}

const at = home => String(home).replace(/\/+$/, '')

export const conversationDir = (home, key) => `${at(home)}/conversations/${safeName(key)}`
export const startsFile = (home, launch) => `${at(home)}/starts/${safeName(launch)}.json`
export const eventsFile = (home, key) => `${at(home)}/events/${safeName(key)}.jsonl`
export const seenFile = (home, key, part = 1) => `${at(home)}/seen/${safeName(key)}${part > 1 ? `.${part}` : ''}.jsonl`
/** The folder of the labels a conversation made in a folder (its real path). */
export const labelsDirOf = (home, key, realPath) => `${conversationDir(home, key)}/folders/${folderName(realPath)}/labels`
export const runDir = home => `${at(home)}/run`
export const tmpDir = home => `${at(home)}/tmp`
export const fixesDir = home => `${at(home)}/fixes`
