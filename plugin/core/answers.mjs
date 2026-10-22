// answers.mjs: the pure part of the answer records (core/answers.ts). No `$`, no Node, no DOM: the hooks module and
// the node tests import it.
//
//   labelCommands(command)        -> the labels a Bash command runs `thimble label` on: [{name, args}], in order
//   isPersonPrompt(by)            -> whether a turn's prompt came from the person (typed, the phone, the SDK, a key
//                                    of thimble's that asked as the person), not a task's report or an agent's message
//   sinceLastPrompt(turns)        -> since the person's last prompt: that prompt, the text rows after it in order, and
//                                    the answers among them (each turn's last text row; a turn that ended in an error
//                                    answered nothing)
//   stepFrom(list, at, dir)       -> the row `dir` steps from `at` in `list`, or null past either end
//   oneLine(text, n)              -> text on one line, cut to n characters

/** A word that names a label in a command: what `thimble label` takes (engine/kernel/labels.py names). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/

/** Shell words of one command segment, with quotes taken off (no expansion: a name is plain letters). */
function words(segment) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * The labels a Bash command runs `thimble label` on, in the order they run: [{name, args}], where `args` are the words
 * after the name. A heredoc's body, a comment and a quoted string that only mentions `thimble label` are not commands.
 * `thimble label` with no name (the list) and `--json` alone name no label.
 */
export function labelCommands(command) {
  const text = String(command || '')
  // the heredoc bodies go: `<<'PY' … PY` is data for the command, never a command of its own
  const lines = text.split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i])
    const here = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i])
    if (!here) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== here[2]) j++
    i = j
  }
  const out = []
  for (const line of kept) {
    for (const segment of line.replace(/(^|\s)#.*$/, '').split(/&&|\|\||[;|&]/)) {
      const w = words(segment)
      const at = w.findIndex((x, k) => /(^|\/)thimble$/.test(x) && w[k + 1] === 'label')
      if (at < 0) continue
      const rest = w.slice(at + 2)
      const name = rest.find(x => !x.startsWith('-'))
      if (!name || !NAME.test(name) || rest.indexOf(name) !== 0) continue
      out.push({ name, args: rest.slice(1) })
    }
  }
  return out
}

/** Who sent a turn's prompt, as `prompt.submit`'s origin kind: the person, or a key of thimble's that asks as the
 *  person. A task's notification, a peer's message and a hand-back are not the person's. */
export function isPersonPrompt(by) {
  return /^(composer|bridge|sdk|plugin|auto-continuation)$/.test(String(by || ''))
}

/**
 * Since the person's last prompt, from the turns oldest first ({prompt: {text, by, row}, rows: [row], answer: row |
 * null}): that prompt ({row, text}, or null when the person has asked nothing yet), every text row of Claude's after
 * it in order (`rows`), and the turns' answers among them (`replies`).
 */
export function sinceLastPrompt(turns) {
  const list = Array.isArray(turns) ? turns : []
  let last = -1
  for (let i = list.length - 1; i >= 0; i--) if (isPersonPrompt(list[i]?.prompt?.by)) { last = i; break }
  const after = last < 0 ? list : list.slice(last)
  const rows = after.flatMap(t => (Array.isArray(t?.rows) ? t.rows : []))
  const replies = after.map(t => t?.answer).filter(r => typeof r === 'string' && r)
  const p = last >= 0 ? list[last].prompt : null
  return { prompt: p ? { row: p.row ?? null, text: String(p.text || '') } : null, rows, replies }
}

/** The item `dir` (1 or -1) steps from `at` in `list`; from an item not in the list, the last (-1) or nothing (1). */
export function stepFrom(list, at, dir) {
  const xs = Array.isArray(list) ? list : []
  const i = at == null ? -1 : xs.indexOf(at)
  const to = i < 0 ? (dir < 0 ? xs.length - 1 : -1) : i + dir
  return to >= 0 && to < xs.length ? xs[to] : null
}

/** Text on one line, each run of white space one space, cut to `n` characters with `…`. */
export function oneLine(text, n = Infinity) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`
}
