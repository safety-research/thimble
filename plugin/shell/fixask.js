// fixask.js: what the fix keys ask Claude for. f and F on a failure line, and p on a fix that is in the person's
// thimble, send a turn of the main conversation, as v does (visualize.js). This module writes no code and calls no
// model; the skill (skills/thimble/SKILL.md, "The thimble command") says how `thimble fix` works. Pure: the shell and
// the tests import it.
//
//   fixRequest({failure, kind})   f (kind 'fix') or F (kind 'report') on a failure line
//   shareRequest({slug, title})   p on a fix with no draft yet
//   lineKey(line, k)              what a key does to the line the bar names: fix, report, share, undo, or null

/** The keys a failure line carries, and the keys of a fix now in the person's thimble. */
export const FAIL_KEYS = 'f fix this · F report only'
export const USE_KEYS = 'p share it · u undo'

/** What key `k` does to the line the bar names (a failure, or a fix in use), or null: it types. */
export function lineKey(line, k) {
  if (line?.kind === 'failed') return k === 'f' ? 'fix' : k === 'F' ? 'report' : null
  if (line?.kind === 'applied') return k === 'p' ? 'share' : k === 'u' ? 'undo' : null
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
