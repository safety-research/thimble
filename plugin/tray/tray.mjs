// tray.mjs: the tray's state and words, as pure functions. No `$`, no Node, no DOM (0.10: shell/tray.js, and the pure
// parts of panes/tray.js, panes/mark.js, shell.tsx stepWords/replyPlace/trayScope and shell/cards.js drawsHyperlinks).
//
// The tray is one small panel above the prompt. It shows one mark at a time: a citation with its evidence, or an
// explainer or an important detail (a heads-up). What it shows is the top of a stack, so a citation inside an explainer
// opens over it, and 0 returns to the one under it; 0 on the first closes the tray.
//
//   a frame   a MarkRef ({row, kind: 'citation', n} | {row, kind: 'explain' | 'heads', id}), with `open: 'code'` while
//             a citation's whole code and output show in place of its one line of evidence
//   a tray    {stack: [frame, ...]} or null
//   a stop    what ] and [ move through, in reading order: a mark of a row ({row, kind, n | id, at}) or a card ({row,
//             card}): drawn under a row (v's), or drawn inline at a call of Claude's, with the row next to it
//
//   sameRef(a, b), open(f), push(tray, f), back(tray), top(tray), base(tray)
//   stopsOfRow(row, cites, spans, cards)   one row's stops: its citations and spans by where they stand, then its cards
//   stopsOfTurn(rows, stopsOf, inline)     a turn's stops: its rows' and the cards Claude drew between them
//   pageOf(heights, room, from), rowsOf(line, width)   what of a tall tray body fits above the bar, and `m` for more
//   indexOf(list, at), stepFrom(list, k, dir)
//   stopWhat(stop), stepWords(ends), cutTitle(s, n)
//   aboutOf(frame, info)                   the words a side thread and the person read for a mark
//   scopeText(frame, info)                 what a question asked with the tray open carries for Claude
//   saidOf(gloss)                          what an explainer or an important detail says, in words for an agent
//   explainerText(gloss)                   an explainer's or a heads-up's words as the tray draws them (markdown)
//   drawsHyperlinks(env), fileHref(abs, line)
//   firstSentence(s)                       a check's reason cut to its first sentence, for a citation's card
//   evidenceLine(ev)                       the one line of a citation's evidence that holds the cited value
//   lineWindow(line, room)                 that line cut to `room` characters around the value

export const sameRef = (a, b) => !!a && !!b && a.row === b.row && a.kind === b.kind && (a.kind === 'citation' ? a.n === b.n : a.id === b.id)

/** A frame without what the tray adds to it (the section open). */
export const refOf = f => (!f ? null : f.kind === 'citation' ? { row: f.row, kind: 'citation', n: f.n } : { row: f.row, kind: f.kind, id: f.id })

export const open = f => (f ? { stack: [refOf(f)] } : null)

export function push(tray, f) {
  if (!f) return tray
  if (!tray || !Array.isArray(tray.stack) || !tray.stack.length) return open(f)
  if (sameRef(tray.stack[tray.stack.length - 1], f)) return tray
  return { ...tray, stack: [...tray.stack, refOf(f)].slice(-12) }
}

export function back(tray) {
  if (!tray || !Array.isArray(tray.stack) || tray.stack.length <= 1) return null
  return { ...tray, stack: tray.stack.slice(0, -1) }
}

export const top = tray => (tray && Array.isArray(tray.stack) && tray.stack.length ? tray.stack[tray.stack.length - 1] : null)

/** The place ] moves on from: the first frame's mark. */
export const base = tray => (tray && Array.isArray(tray.stack) && tray.stack.length ? tray.stack[0] : null)

/**
 * One row's stops in reading order: its citations (`cites`: [{n, start, words}], n > 0, a citation the check knows) and
 * the features' spans on its words (`spans`: [{id, kind, start, end}], an explainer or a heads-up), by where each
 * starts, then the cards drawn under it (`cards`: their ids, oldest first). A heads-up on a citation's words stops
 * before that citation, so one ] opens it; an explainer there stops after it (the citation's tray offers it with h).
 */
export function stopsOfRow(row, cites, spans, cards) {
  const known = (cites || []).filter(c => c && c.n > 0)
  const on = s => known.find(c => typeof c.words === 'string' && s.start >= c.start + 1 && s.end <= c.start + 1 + c.words.length)
  const marks = [
    ...known.map(c => ({ row, kind: 'citation', n: c.n, at: c.start })),
    ...(spans || []).filter(s => s && s.id).map(s => {
      const kind = s.kind === 'heads' ? 'heads' : 'explain'
      const c = kind === 'heads' ? on(s) : null
      return { row, kind, id: s.id, at: c ? c.start - 0.5 : s.start }
    }),
  ].sort((a, b) => a.at - b.at || (a.kind === 'citation' ? -1 : 1))
    .map(m => ({ ...m, at: Math.ceil(m.at) }))
  return [...marks, ...(cards || []).map(id => ({ row, card: id }))]
}

/**
 * A turn's stops in reading order: each text row's stops (`stopsOf(row)`: its marks, then the cards drawn under it),
 * with the cards Claude drew inline between them (`inline`: [{id, after}], `after` the number of the turn's text rows
 * above the card's call). A card drawn before the first text row goes with that row, one after a row with that row.
 */
export function stopsOfTurn(rows, stopsOf, inline) {
  const out = []
  const cards = (inline || []).filter(c => c && c.id)
  const last = (rows || []).length - 1
  ;(rows || []).forEach((row, i) => {
    if (i === 0) for (const c of cards) if (!(c.after > 0)) out.push({ row, card: c.id })
    const own = stopsOf(row) || []
    const mine = own.filter(p => !p.card)
    const under = own.filter(p => p.card)
    out.push(...mine)
    for (const c of cards) if (c.after > 0 && (c.after === i + 1 || (i === last && c.after > last + 1))) out.push({ row, card: c.id })
    out.push(...under)
  })
  return out
}

/**
 * Which units of a body fit in `room` rows (`heights`: each unit's rows), from unit `from`: {start, end, more} where
 * units start..end-1 show and `more` is how many are left out. When all fit, all show. Else one row is kept for the
 * line that says there is more, and at least one unit shows. `next`: where `m` goes, the start again after the end.
 */
export function pageOf(heights, room, from = 0) {
  const hs = (heights || []).map(h => Math.max(1, h | 0))
  const total = hs.reduce((a, b) => a + b, 0)
  if (!(room > 0) || total <= room) return { start: 0, end: hs.length, more: 0, next: null }
  const start = from > 0 && from < hs.length ? from : 0
  let end = start
  let used = 0
  while (end < hs.length && (end === start || used + hs[end] <= room - 1)) { used += hs[end]; end++ }
  return { start, end, more: hs.length - end + start, next: end < hs.length ? end : 0 }
}

/** The rows a line of `width` cells takes when it wraps at words (a line is at least one row). */
export function rowsOf(line, width) {
  const w = Math.max(8, width | 0)
  let rows = 1
  let at = 0
  for (const word of String(line ?? '').split(' ')) {
    const n = word.length
    if (at && at + 1 + n > w) { rows++; at = 0 }
    if (n > w) { rows += Math.floor((n - 1) / w); at = n % w || w } else at += (at ? 1 : 0) + n
  }
  return rows
}

/** The index of `at` (a frame, or a card stand {row, card}) in a list of stops; -1 when it is not there. */
export function indexOf(list, at) {
  if (!at || !Array.isArray(list)) return -1
  if (at.card) return list.findIndex(p => p.card === at.card && p.row === at.row)
  return list.findIndex(p => !p.card && sameRef(p, at))
}

// The steps stop at the ends: ] on the newest reply's last stop stays there. Going on into the oldest reply would open
// a mark far above the screen, and the keys would then act on that reply, out of sight.
export function stepFrom(list, k, dir = 1) {
  const j = k + (dir > 0 ? 1 : -1)
  return list && j >= 0 && j < list.length ? list[j] : null
}

/** What a stop is, in the bar's words. */
export function stopWhat(p) {
  if (!p) return undefined
  if (p.card) return 'card'
  return p.kind === 'heads' ? 'heads up' : p.kind === 'explain' ? 'explainer' : 'citation'
}

/** The bar's words for ] and [: `] next citation` while there is a next, else `[ previous card` where there is one
 *  before. */
export function stepWords(ends) {
  const what = w => (w ? ` ${w}` : '')
  if (!ends) return []
  return ends.next ? [{ key: ']', words: `next${what(ends.nextWhat)}` }] : ends.prev ? [{ key: '[', words: `previous${what(ends.prevWhat)}` }] : []
}

/** A title cut to `n` characters: a place (`engine/lineage.py:463`) loses the start of its path first, so its line
 *  stays whole; other words are cut at the end. */
export function cutTitle(s, n) {
  const t = String(s)
  if (t.length <= n) return t
  if (/^\S+(?::\d+(?:-\d+)?|#\S+)$/.test(t) && n > 4) return `…${t.slice(t.length - n + 1)}`
  return `${t.slice(0, Math.max(1, n - 1))}…`
}

const plain = s => String(s || '').replace(/\[([^\]]*)\]\(#\)/g, '$1').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** What a side thread is about, in words: the citation, explainer or important detail, by the words the person read.
 *  `info`: {words} for a citation, {gloss} for an explainer or a heads-up. */
export function aboutOf(f, info = {}) {
  if (!f) return 'this mark'
  if (f.kind === 'citation') return `the citation "${cut(plain(info.words) || `citation ${f.n}`, 80)}"`
  const g = info.gloss || {}
  if (f.kind === 'heads') return `the important detail "${cut(plain(g.title || g.term), 80)}"`
  return `the explainer of "${cut(plain(g.term), 80)}"`
}

/** What an explainer or an important detail says, in words for a side thread's agent. */
export function saidOf(g) {
  if (!g) return ''
  if (g.kind === 'heads') return `thimble marked them as an important detail, "${plain(g.title || g.term)}": ${(g.bullets || []).map(plain).join(' ')}${g.todo ? ` What to do: ${plain(g.todo)}` : ''}`
  return `thimble's explainer of them says: ${plain(g.body || g.title)}${g.here ? ` ${plain(g.here)}` : ''}`
}

/** Where a citation's evidence is, in words for Claude: the cited place, or the code that computed it. */
function evidenceWords(ev) {
  if (!ev) return ''
  if (ev.kind === 'computed') return ` Its evidence is the output of code ${ev.by === 'main' ? 'you' : 'the check'} ran.`
  return ` Its evidence is ${ev.file}:${ev.line}.`
}

/**
 * What a question the person asks with the tray open carries for Claude: which mark was open, where it stands, and
 * what it said, so "this" can mean it. `info`: {begins (the reply's first words), words, status, evidence} for a
 * citation, {begins, gloss} for an explainer or a heads-up.
 */
export function scopeText(f, info = {}) {
  if (!f) return ''
  const begins = cut(String(info.begins || '').replace(/\s+/g, ' ').trim(), 80)
  const where = begins ? ` in your reply that begins "${begins}"` : ''
  if (f.kind === 'citation') {
    const st = info.status === 'corrected' ? ' The check corrected it.' : info.status === 'failed' ? ' The check flagged it.' : info.status === 'verified' ? ' The check verified it.' : ''
    return `The analyst asked this with a citation of your reply open in the tray: "${plain(info.words)}"${where}. "This" may mean that value.${st}${evidenceWords(info.evidence)}`
  }
  const g = info.gloss || {}
  if (f.kind === 'heads') {
    return `The analyst asked this with an important detail of your reply open in the tray: "${plain(g.title || g.term)}", on the words "${plain(g.term)}"${where}. It said: ${(g.bullets || []).map(plain).join(' ')}${g.todo ? ` What to do: ${plain(g.todo)}` : ''} "This" or "it" may mean that detail.`
  }
  return `The analyst asked this with an explainer of your reply open in the tray: the term "${plain(g.term)}"${where}. The explainer said: ${plain(g.body || g.title)}${g.here ? ` ${plain(g.here)}` : ''} "This" or "it" may mean that term.`
}

/** An explainer's words as the tray draws them, as markdown whose citations stay `[words](#)`: what it is, then where
 *  it mattered here. A heads-up: its title in bold, two to four bullets, and one line on what to do. */
export function explainerText(g) {
  if (!g) return ''
  if (g.kind === 'heads') {
    const bullets = (Array.isArray(g.bullets) ? g.bullets : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 4)
    return [g.title ? `**${String(g.title).replace(/\*/g, '')}**` : '', bullets.map(x => `- ${x}`).join('\n'), g.todo ? `→ ${g.todo}` : ''].filter(Boolean).join('\n\n')
  }
  return [g.body || g.title || '', g.here || ''].filter(Boolean).join('\n\n')
}

// terminals Claude Code takes to draw an OSC 8 hyperlink by their name, as it names them (2.1.301)
const LINK_TERMS = ['ghostty', 'Hyper', 'kitty', 'alacritty', 'iTerm.app', 'iTerm2', 'WarpTerminal']
const version = v => String(v || '').split('.').map(x => parseInt(x, 10) || 0)

/**
 * Whether Claude Code draws a link as an OSC 8 hyperlink in this terminal, by the test it applies to the environment
 * (`env`: the variables it reads). Where it does not, it draws the link's words, then the address in brackets. Only
 * the cases where it surely draws one say yes, so a surface that asks never shows that address.
 */
export function drawsHyperlinks(env = {}) {
  const e = env || {}
  if (typeof e.FORCE_HYPERLINK === 'string' && e.FORCE_HYPERLINK) return parseInt(e.FORCE_HYPERLINK, 10) !== 0
  if (typeof e.FORCE_HYPERLINK === 'string') return false
  const p = e.TERM_PROGRAM || ''
  if (LINK_TERMS.includes(p) || LINK_TERMS.includes(e.LC_TERMINAL || '')) return true
  if (e.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return true
  if (e.WT_SESSION && p !== 'tmux' && !e.TMUX) return true
  if (p === 'tmux') { const [a, b] = version(e.TERM_PROGRAM_VERSION); return a > 3 || (a === 3 && b >= 4) }
  if (String(e.TERM || '').includes('kitty')) return true
  if (e.CI || e.TEAMCITY_VERSION) return false
  if (p === 'WezTerm') return version(e.TERM_PROGRAM_VERSION)[0] >= 20200620
  if (p === 'vscode') { const [a, b] = version(e.TERM_PROGRAM_VERSION); return a > 1 || (a === 1 && b >= 72) }
  if (e.VTE_VERSION && e.VTE_VERSION !== '0.50.0') {
    const v = /^\d{3,4}$/.test(e.VTE_VERSION) ? [0, parseInt(e.VTE_VERSION.slice(0, -2), 10), 0] : version(e.VTE_VERSION)
    return v[0] > 0 || v[1] >= 50
  }
  return e.TERM === 'alacritty'
}

/** A file's address, `file:///…/runs.jsonl#L41`, which a ctrl or cmd click opens on this machine. */
export function fileHref(abs, line) {
  const n = /^(\d+)/.exec(String(line || ''))
  return `file://${encodeURI(String(abs)).replace(/#/g, '%23').replace(/\?/g, '%3F')}${n ? `#L${n[1]}` : ''}`
}

/** A check's reason, its first sentence only: a citation's card says why in one sentence (a decimal point or an
 *  abbreviation inside it does not end it). */
export function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  const m = /^.*?[.!?](?=\s+[A-Z0-9"“(']|$)/.exec(t)
  return m ? m[0] : t
}

/** Whether line n is one of the cited lines (`12` or `8-11`). */
function inRange(n, line) {
  const [a, b] = String(line ?? '').split('-').map(Number)
  return n >= a && n <= (Number.isNaN(b) || b === undefined ? a : b)
}

/**
 * The one line of a citation's evidence that holds the cited value, with the value's spans in it: for code that
 * computed it, the output line where the first highlight starts (else its first line with words); for a file, the
 * cited line that holds the highlight (else the first cited line). `n`: the file's line number. Null without one.
 */
export function evidenceLine(ev) {
  if (!ev) return null
  if (ev.kind === 'computed') {
    const out = String(ev.output || '')
    const lines = out.split('\n')
    const spans = Array.isArray(ev.highlight) ? ev.highlight.filter(h => Array.isArray(h) && h[1] > h[0]) : []
    let at = 0
    for (const text of lines) {
      const end = at + text.length
      if (spans.length ? spans[0][0] >= at && spans[0][0] <= end : text.trim()) {
        const mine = spans.map(([a, b]) => [Math.max(a, at) - at, Math.min(b, end) - at]).filter(([a, b]) => b > a)
        return { text, spans: mine }
      }
      at = end + 1
    }
    return lines.length && out ? { text: lines[0], spans: [] } : null
  }
  const lines = Array.isArray(ev.lines) ? ev.lines : []
  const l = lines.find(x => x && x.highlight && inRange(x.n, ev.line)) || lines.find(x => x && x.highlight) || lines.find(x => x && inRange(x.n, ev.line)) || lines[0]
  return l ? { n: l.n, text: String(l.text ?? ''), spans: l.highlight ? [l.highlight] : [] } : null
}

/** A line cut to `room` characters, around its first span when it is longer, with … where it was cut; its spans moved
 *  with it. */
export function lineWindow(line, room) {
  if (!line) return line
  const { text, spans } = line
  if (!(room > 8) || text.length <= room) return line
  const [a, b] = spans[0] || [0, 0]
  let from = Math.max(0, Math.min(a - Math.floor((room - (b - a)) / 2), text.length - room + 1))
  if (from > 0) from = Math.min(from + 1, a)
  const head = from > 0 ? '…' : ''
  const left = room - head.length
  const to = from + left < text.length ? from + left - 1 : text.length
  const tail = to < text.length ? '…' : ''
  const moved = spans.map(([x, y]) => [Math.max(x, from) - from + head.length, Math.min(y, to) - from + head.length]).filter(([x, y]) => y > x)
  return { ...line, text: head + text.slice(from, to) + tail, spans: moved }
}
