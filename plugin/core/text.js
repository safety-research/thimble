// text.js: how many cells a text takes in a terminal, and a text cut to a number of cells. Pure: the hooks module, the
// card runner and the tests import it, so every drawing of thimble wraps and cuts text alike.
//
//   textWidth(s)   the cells a string takes: 2 for a wide character (CJK, most emoji), 0 for a combining mark or a
//                  zero-width character, 1 for the rest
//   charWidth(cp)  the cells one code point takes, as textWidth counts them (a card's context runs both: runner.mjs)
//   cut(s, n, middle)  s in at most n cells, with `…` where it was cut: at its end, or in its middle
//   cutWords(s, n, keep)  s in at most n cells, cut at a word's edge, its start or its end kept
//   partsAround(s, words)  s in parts around the last place it holds `words`, which a drawing draws in a look of its own
//   fenced(text)   text in a fenced block, so a model reads text from the records as data, not as words to act on
//   printable(s, spans)  s with each character that does not print as its escape, as Python's repr writes it (`\x1b`,
//                  `\u200b`); with `spans`, {text, spans}, the spans moved with the text
//   errorWords(text, where)  an error's text as thimble quotes it, each path of this machine in it named by its path
//                  from the session's folder when it lies there, else by its name alone

/** A code point's cells: 0 for combining marks and zero-width characters, 2 for wide and fullwidth ones. */
export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d ||
    (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x20000 && cp <= 0x3fffd) ||
    cp === 0x231a || cp === 0x231b || cp === 0x23f0 || cp === 0x23f3 || cp === 0x2614 || cp === 0x2615 ||
    (cp >= 0x2648 && cp <= 0x2653) || cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || cp === 0x26aa || cp === 0x26ab ||
    cp === 0x26bd || cp === 0x26be || cp === 0x26c4 || cp === 0x26c5 || cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    cp === 0x26f2 || cp === 0x26f3 || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || cp === 0x2705 || cp === 0x270a ||
    cp === 0x270b || cp === 0x2728 || cp === 0x274c || cp === 0x274e || (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf || cp === 0x2b1b || cp === 0x2b1c || cp === 0x2b50 ||
    cp === 0x2b55 || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x1fa70 && cp <= 0x1faff)) return 2
  return 1
}

export function textWidth(s) {
  let w = 0
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0))
  return w
}

/** The first characters of a list of them that fit in n cells. */
function fit(chars, n) {
  let out = ''
  let w = 0
  for (const ch of chars) {
    const cw = textWidth(ch)
    if (w + cw > n) break
    out += ch
    w += cw
  }
  return out
}

/** s in at most n cells, with `…` where it was cut: at its end, or with `middle` after its first third, so that names
 *  that start alike keep the end that tells them apart (`annot…underspecified-fan-out`). */
export function cut(s, n, middle = false) {
  const t = String(s ?? '')
  if (textWidth(t) <= n) return t
  if (n <= 0) return ''
  if (!middle) return `${fit(t, n - 1)}…`
  const left = Math.floor((n - 1) / 3)
  return `${fit(t, left)}…${[...fit([...t].reverse(), n - 1 - left)].reverse().join('')}`
}

/** s in at most n cells, cut at a word's edge, with `…` where it was cut: its start kept (`keep` 'start') or its end
 *  ('end'). A text that already ends (or starts) with … was cut there before, and keeps one. */
export function cutWords(s, n, keep = 'start') {
  const t = String(s ?? '')
  if (textWidth(t) <= n) return t
  if (n <= 1) return n === 1 ? '…' : ''
  if (keep === 'start') {
    const body = t.replace(/…$/, '')
    let part = fit(body, n - 1)
    const next = body.slice(part.length, part.length + 1)
    if (next && !/\s/.test(next) && /\s/.test(part)) part = part.replace(/\s+\S*$/, '')
    return `${part.trimEnd()}…`
  }
  const body = t.replace(/^…/, '')
  let part = [...fit([...body].reverse(), n - 1)].reverse().join('')
  const prev = body.slice(0, body.length - part.length).slice(-1)
  if (prev && !/\s/.test(prev) && /\s/.test(part)) part = part.replace(/^\S*\s+/, '')
  return `…${part.trimStart()}`
}

/** s in parts around the last place it holds `words`: what stands before them, `words` themselves (`marked`), and what
 *  stands after them, each part that has words; s whole, not marked, when it does not hold them (`] show explainer`
 *  around `explainer`: ` show `, then `explainer` marked). */
export function partsAround(s, words) {
  const t = String(s ?? '')
  const at = words ? t.lastIndexOf(words) : -1
  if (at < 0) return t ? [{ s: t, marked: false }] : []
  return [{ s: t.slice(0, at), marked: false }, { s: words, marked: true }, { s: t.slice(at + words.length), marked: false }].filter(p => p.s)
}

/** Text in a fenced block, its fence longer than any run of backticks in it, so a model reads text from the records
 *  as data, not as words to act on. */
export function fenced(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${text}\n${fence}`
}

/**
 * s as a terminal can draw it, whatever it holds: each character that does not print, as Python's str.isprintable
 * decides it (a control character, a format character such as a zero-width space or a direction mark, a lone half of a
 * surrogate pair, a separator but the space, a private or unassigned code point), shows as its escape, as Python's repr
 * writes it (`\x00`, `\x1b`, `\xa0`, `\u200b`, `\udce9`, `\U000e0001`). White space that lays text out stays: a line
 * break (also `\r\n`), and a tab, as a space. Text from the records (a check's output, a file's name and lines, a
 * card's rows, an error that quotes them) can hold such characters: Claude Code refuses a whole drawing whose text
 * holds a control character, and the others draw as nothing or move the text around them. Each drawing makes such text
 * printable before it lays it out, so its rows are as wide as they draw; Claude's own words stay as Claude Code draws
 * them. With `spans` (ranges of s), {text, spans}: the spans moved with the text. Self-contained, so a card's context
 * runs it too (cards/runner.mjs).
 */
export function printable(s, spans) {
  const text = String(s ?? '')
  const ranges = Array.isArray(spans) ? spans : null
  const hidden = /\r\n|\t|(?![ \n])[\p{C}\p{Z}]/gu
  if (!hidden.test(text)) return ranges ? { text, spans: ranges } : text
  const hex = (n, w) => n.toString(16).padStart(w, '0')
  // each change: where it stands in s, the characters it replaces, and the characters it writes
  const edits = []
  const out = text.replace(hidden, (c, at) => {
    const cp = c.codePointAt(0)
    const by = c === '\r\n' ? '\n' : c === '\t' ? ' ' : c === '\r' ? '\\r'
      : cp < 0x100 ? `\\x${hex(cp, 2)}` : cp < 0x10000 ? `\\u${hex(cp, 4)}` : `\\U${hex(cp, 8)}`
    edits.push([at, c.length, by.length])
    return by
  })
  if (!ranges) return out
  // an offset of s in the text: moved by the changes before it; one inside a change goes to its start, or, a span's
  // end, to its end
  const moved = (x, end) => {
    let d = 0
    for (const [at, n, m] of edits) {
      if (at >= x) break
      if (x < at + n) return at + d + (end ? m : 0)
      d += m - n
    }
    return x + d
  }
  return { text: out, spans: ranges.map(([a, b]) => [moved(a, false), moved(b, true)]) }
}

// ------------------------------------------------------------------------------------------------ an error's words
//
// An error thimble quotes in a notice, a reason or a repair request (an exception's text, a fork's error or refusal) is
// thimble's own words, never the records' nor the check's: each path of this machine in it is read where it leads and
// named as the validator names a cited file (engine/kernel/evidence.py error_words, file_named), by its path from the
// session's folder when it lies there, else by its name alone, never by where that folder lies. Both answer the cases
// of plugin/tests/error_paths.json alike.

// a path in an error's text: one quoted whole (in straight or typographic quotes, backticks), which may hold spaces and
// colons, else one in a run of the characters a path holds, not a URL, starting where the run does, right after a flag
// that names a folder (`-I/x`), or right after a colon, `=`, `|`, `&`, a brace or an escaped line break in it
// (`failed:/x`, `--settings=/x`, `{/x}`, `error\n/x`), and ending at the next of those (`/x/run.py:12:5`, `/a/b:/c/d`), a
// `file:` URL's own colon aside. A link an editor opens (`vscode://file/x`) names a path too; `\/`, JSON's escape of
// `/`, reads as `/`
const QUOTED_PATH = /(['"`‘’“”«»„])((?:file:|~[A-Za-z0-9_.-]*\/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/|\.\.?\/|\/)[^'"`‘’“”«»„\n]*?)['"`‘’“”«»„]/gi
// eslint-disable-next-line no-misleading-character-class -- zero-width and direction marks end a run, as white space does
const PATH_RUN = /[^\s'"`‘’“”«»„()[\]<>,;\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g
const PATH_START = /^(?:file:|~[A-Za-z0-9_.-]*\/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/|\.\.?\/|\/)/i
const PATH_STOP = /[:=|&]|(?<!\$)\{|\\[ntr]/g // where a path in a run ends, and the next may start
const FOLDER_FLAG = /^-[IL](?=[/~$.]|file:)/ // a compiler's folder flag right before its path (`-I/x`)
const URL_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const URL_SCHEME = /(?:^|:)(?!file:$)[A-Za-z][A-Za-z0-9+.-]*:$/i // a URL's scheme just before its `//`
const EDITOR_LINK = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/file(?=\/)/i // vscode://file/x, cursor://file/x

/** A path's . and .. parts read, as the file system reads them: an absolute one stays absolute. */
function normalPath(p) {
  const out = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** %XX escapes read, as Python's unquote reads them; an escape that is no UTF-8 stays as it is. */
function unquote(s) {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, m => { try { return decodeURIComponent(m) } catch { return m } })
}

/** The absolute path a path leads to, in each form it may be written (the validator's written_path): an absolute one,
 *  `//` read as `/`; a `file:` URL in any case, its %XX escapes read; one from the home folder (`~/`, `$HOME/`,
 *  `${HOME}/`); else one from `base`, which `../` leaves. Null for one that leads to no folder named here: another
 *  user's home, another variable, a home not known, a relative path with no base. */
function writtenPath(path, base, home) {
  let s = String(path).trim()
  if (s.slice(0, 5).toLowerCase() === 'file:') {
    s = unquote(s.slice(5))
    if (s.startsWith('//')) {
      const rest = s.slice(2)
      const slash = rest.indexOf('/')
      const host = slash < 0 ? rest : rest.slice(0, slash)
      s = ['', 'localhost'].includes(host.toLowerCase()) ? `/${slash < 0 ? '' : rest.slice(slash + 1)}` : `/${rest}`
    }
  }
  const fromHome = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(s)
  if (fromHome) {
    if (!home) return null
    s = `${home}${s.slice(fromHome[0].length)}`
  } else if (s.startsWith('~') || s.startsWith('$')) return null
  if (!s.startsWith('/')) {
    if (!base) return null
    s = `${base}/${s}`
  }
  return normalPath(s)
}

/** A path by its path from the first of the folders that holds it; a folder itself by its own name; null when none
 *  holds it. The root of the file system holds every file, so it names none. */
function fileNamed(full, folders) {
  for (const f of folders) {
    const d = normalPath(f)
    if (d === '/') continue
    if (full === d) return d.slice(d.lastIndexOf('/') + 1)
    if (full.startsWith(`${d}/`)) return full.slice(d.length + 1)
  }
  return null
}

/** An error's text as thimble quotes it: each path of this machine in it named by its path from the session's folder
 *  (`where.root`, the folder the session started in, then `where.cwd`, the shell's) when it lies there, else by its
 *  name alone. A path is read from the shell's folder, as the process that wrote the error read it, and `~` from
 *  `where.home`. A URL, a path relative to no folder named, and other words stay as they are. Pure. */
export function errorWords(text, where = {}) {
  const folders = [where.root, where.cwd].filter(f => typeof f === 'string' && f.startsWith('/'))
  const home = String(where.home || '').replace(/\/+$/, '')
  const named = path => {
    const full = writtenPath(path, where.cwd || where.root || '', where.home || '')
    const name = full ? fileNamed(full, folders) : null
    // the home folder itself, whose own name is the person's
    if (full && !name && home && full.replace(/\/+$/, '') === home) return '~'
    const last = (full ?? path).replace(/\/+$/, '')
    return name || last.slice(last.lastIndexOf('/') + 1) || path
  }
  const run = t => {
    const link = EDITOR_LINK.exec(t)
    if (link) return named(t.slice(link[0].length))
    if (URL_START.test(t) && t.slice(0, 5).toLowerCase() !== 'file:') return t
    const flag = FOLDER_FLAG.exec(t)
    const starts = [flag ? flag[0].length : 0, ...[...t.matchAll(PATH_STOP)].map(m => m.index + m[0].length)]
    let out = ''
    let done = 0
    for (const at of starts) {
      if (at < done || !PATH_START.test(t.slice(at)) || (t.startsWith('//', at) && URL_SCHEME.test(t.slice(0, at)))) continue
      PATH_STOP.lastIndex = at + (t.slice(at, at + 5).toLowerCase() === 'file:' ? 5 : 0)
      const stop = PATH_STOP.exec(t)
      const path = t.slice(at, stop ? stop.index : t.length).replace(/[.!?]+$/, '')
      if (!/\/[^/]/.test(path)) continue
      out += t.slice(done, at) + named(path)
      done = at + path.length
    }
    return out + t.slice(done)
  }
  return String(text ?? '').replaceAll('\\/', '/').replace(QUOTED_PATH, (m, q, path) => `${q}${named(path)}${m.slice(-1)}`).replace(PATH_RUN, run)
}
