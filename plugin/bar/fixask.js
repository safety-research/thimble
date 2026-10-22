// fixask.js: what the fix keys ask Claude for. f and F on a failure line, and p on a fix that is in the person's
// thimble, send a turn of the main conversation. This module writes no code and calls no model; `thimble fix --help`
// says how `thimble fix` works. Pure: the hooks module and the tests import it.
//
//   fixRequest({failure, kind})   f (kind 'fix') or F (kind 'report') on a failure line
//   shareRequest({slug, title})   p on a fix with no draft yet
//   lineKey(lines, k)             what a key does to the lines the bar names: fix, report, share, undo, or null
//   fixVerb(args)                 what /thimble:fix's words ask for: the fixes, submit, undo, try, remove, or a change

/** The keys a failure line carries, and the keys of a fix now in the person's thimble. */
export const FAIL_KEYS = 'f fix this · F report only'
export const USE_KEYS = 'p submit · u undo'
/** Every key the two lines can carry (a card never gets them). */
export const FIX_KEYS = ['f', 'F', 'p', 'u']

/** What key `k` does to the lines the bar names (`fail`: a failure or a notice; `fix`: a fix in use), or null: it
 *  types. */
export function lineKey({ fail = null, fix = null } = {}, k) {
  if (fail?.kind === 'failed' && (k === 'f' || k === 'F')) return k === 'f' ? 'fix' : 'report'
  if (fix && (k === 'p' || k === 'u')) return k === 'p' ? 'share' : 'undo'
  return null
}

const one = s => String(s || '').replace(/\s+/g, ' ').trim()

/** The request f or F sends: the failure, the kind, and where to work. */
export function fixRequest({ failure = '', kind = 'fix' } = {}) {
  const what = one(failure).replace(/^[×!]\s*/, '')
  const lines = [`The analyst pressed ${kind === 'report' ? 'F (report only)' : 'f (fix this)'} on a thimble failure: "${what}".`]
  if (kind === 'report') {
    lines.push('They want to report it, with no fix. Start with `thimble fix new "<a short title>" --kind report`, write the issue with a reproduction on made-up data, and give it to `thimble fix draft <slug> --from FILE`. The analyst then reviews the exact text.')
  } else {
    lines.push('Fix it in a copy of thimble: start with `thimble fix new "<a short title>"` and work in the worktree it prints, never in the data folder. Do the work in a background subagent, so the analyst can keep working, and say so in one line. When the plugin\'s tests pass, run `thimble fix use <slug>`.')
  }
  return lines.join(' ')
}

/** The request p sends when the fix has no draft yet: Claude writes it, and the preview opens on it. */
export function shareRequest({ slug = '', title = '' } = {}) {
  return `The analyst pressed p (share it) on the fix ${slug}${title ? ` "${one(title)}"` : ''}. Write the draft and give it to \`thimble fix draft ${slug} --from FILE\`. The analyst reviews the exact text before anything is sent.`
}

/** What `/thimble:fix <words>` asks for: nothing (the fixes and what to do), `submit` (the review of the fix, as p),
 *  `undo` (back to the release, as u), `try [fix]` (turn a fix on again), or any other words: the change the person
 *  wants, which the command's own text asks Claude for (commands/fix.md). */
export function fixVerb(args) {
  const w = one(args)
  const m = /^(status|submit|share|undo|try|use|remove)(?:\s+([a-z0-9][a-z0-9-]{0,79}))?$/i.exec(w)
  if (!w || /^status$/i.test(w)) return { verb: 'status' }
  if (!m) return { verb: 'change', text: w }
  const v = m[1].toLowerCase()
  return { verb: v === 'share' ? 'submit' : v === 'use' ? 'try' : v, slug: m[2] ? m[2].toLowerCase() : '' }
}
