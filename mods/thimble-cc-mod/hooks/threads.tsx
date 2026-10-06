// Side threads: a question about a card, a citation or the last answer, answered by a subagent the mod starts, so
// the exchange stays out of main's chat. register.tsx draws the pane (the exchange, its answers drawn like replies:
// links and cards). A thread about a card may change the card in place. When it answers, main gets one note it reads
// and the analyst does not see (threadNote), so main can speak of it later.
//
// This file holds the prompts and the record; the engine is in register.tsx (the validator follows `$` only into
// functions of the hooks module's own file). Every subagent of the mod (a side thread, a fix round, a verification, a
// report's writer, verifier or highlighter, a view's builder and reviewer) starts the same way: $.agent.spawn with the
// `fork` type, which inherits main's whole conversation, so it knows the cards, the replies and what the analyst asked
// before; a fork a plugin spawns ends without any notice to main. Where a fork is refused, a general-purpose subagent
// given the guidance and the context, named so (fallbackName). Each follow-up starts a new fork given the exchange so
// far (a resumed subagent's end would reach main as a task notification).
import type { ChatFixItem, ChatThread, ChatThreadTurn } from '../types'
import { plainCites } from './cite'
import { citations, citeSpans, valueIn } from './lib'

const RULES = [
  'Answer here, briefly, the way thimble-cc-mod answers in the main conversation: numbers from code (run Python with Bash; a card with the helper when a chart or table answers it), every number and record cited as [[value|ref]].',
  'Cite a line of your own Bash output as [[value|call:<id>#L<n>]] with the id thimble-cc-mod gives after the output, or as [[value|call:none#L<n>]] when it gives none; thimble-cc-mod then finds the output.',
  'Begin with the answer itself, not a line restating the task (this overrides the fork guideline to open with one): the panel shows your reply as you write it.',
  'Do not change the corpus, and write only under .thimble-cc-mod/.',
].join(' ')

// A fork is told to open with one line restating its task; a side thread's prompt asks it not to, and a line that
// still does is dropped from what the panel shows.
const TASK_LINE = /^\s*(?:\*\*)?(?:Task|Scope|Directive)(?:\*\*)?\s*:(?:\*\*)?[^\n]*(?:\n|$)/i
const RESULT_LABEL = /^\s*(?:\*\*)?Result(?:\*\*)?:(?:\*\*)?\s*/i

/** A fork's reply without its opening line restating the task (and the `Result:` label that may follow it). */
export function withoutTaskLine(text: string): string {
  if (!TASK_LINE.test(text)) return text
  return text.replace(TASK_LINE, '').replace(/^\s*\n/, '').replace(RESULT_LABEL, '').trimStart()
}

const CARD_REF = /^\[\[card:([A-Za-z0-9_-]+)\]\]$/

/** What a thread about a card may do besides answer: change the card where it stands in the reply. */
function cardRule(t: ChatThread): string {
  const id = CARD_REF.exec(t.ref)?.[1]
  return id
    ? [
        `The main reply cites values of this card, so change it in place only when every value it shows stays the same: another sort order, chart kind or wording of its labels. Then edit the script that made it and run it again with python3, keeping the card's question exactly as it is (the id comes from the question, so .thimble-cc-mod/cards/${id}.json is replaced and redrawn where it stands in the reply), and say in one sentence what changed.`,
        'For a view that changes its values (another grouping, cutoff, field or filter), make a new card with its own question and show it here, and leave this card as it is.',
      ].join(' ')
    : ''
}

function history(t: ChatThread): string {
  return t.turns
    .filter(x => x.state === 'done')
    .map(x => `Q: ${x.q}\nA: ${x.a}`)
    .join('\n\n')
}

export function forkPrompt(t: ChatThread, q: string): string {
  const past = history(t)
  return [
    'thimble-cc-mod side thread. The analyst reads this exchange in a pane beside the main conversation, which gets only a short note of your answer.',
    `It is about ${t.label}:`,
    t.context,
    '',
    ...(past ? ['', 'The exchange so far in this side thread:', past] : []),
    '',
    `The analyst asks: ${q}`,
    '',
    RULES,
    ...(cardRule(t) ? [cardRule(t)] : []),
  ].join('\n')
}

/** A subagent's prompt led by the notes main has not read yet (they go with its next prompt), which the conversation a
 *  fork inherits does not hold. */
export function withNotes(notes: readonly string[], prompt: string): string {
  return notes.length ? ['Notes thimble-cc-mod left for the main conversation since its last prompt:', ...notes, '', prompt].join('\n') : prompt
}

/** A prompt for a general-purpose subagent, which has neither main's conversation nor its guidance. */
export function withGuide(guide: string, prompt: string): string {
  return [guide, '', '---', prompt].join('\n')
}

export function freshPrompt(t: ChatThread, q: string, guide: string): string {
  return withGuide(guide, forkPrompt(t, q))
}

// How each subagent of the mod is named where Claude Code lists it and in its one dim row in main's chat; the names
// also tell the mod's rows from others.
export const MOD_AGENT = /(?:verification|side thread|report|view) · /

/** A subagent's name when its fork was refused and a general-purpose one, without main's conversation, stands in. */
export function fallbackName(desc: string): string {
  return `${desc} · general-purpose, fork refused`
}

/** The note main reads when a side thread answered in the panel: what it was about, the question, the answer's start,
 *  each on one line, and the file that holds the whole exchange. */
export function threadNote(t: ChatThread, q: string, answer: string): string {
  // a card's embed line names the card, which main can open or cite
  const flat = (s: string, n: number) => firstWords(plainCites(s.replace(/\[\[card:([A-Za-z0-9_-]+)\]\]/g, '(card:$1)')), n)
  return `thimble-cc-mod: side thread answered, in the panel (the analyst read it there). It was about ${flat(t.label, 100)}; the analyst asked "${flat(q, 200)}", and it answered: ${flat(withoutTaskLine(answer), 500)} The whole exchange is in ${t.file}.`
}

// Lines of a thread's context that say where it stands or how a thing was made (a report's place, a card's script and
// data, a verdict, a view's files, what the analyst points at), not what the thread is about.
const NOT_ABOUT = /^(?:In the report |Made by |Its data |Checked: |The cited place shows: |The view's files: |The analyst points at |One row of it is )/
// The lead-in of a quoted passage on its own line: the sentence of a citation, a passage, a card's takeaway.
const QUOTED = /^(?:The sentence|The passage of the reply|Its takeaway in the reply):\s*/
const ID = /\b(?:card|call):[A-Za-z0-9_-]+(?:#\S*)?|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g

/** A line of Markdown as the words it shows: citations as their shown words, no heading, list or quote marker, no
 *  emphasis, code ticks or ids. */
function shownWords(line: string): string {
  return plainCites(line.replace(/\[\[card:[A-Za-z0-9_-]+\]\]/g, ''))
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/\*\*|__|\*|`/g, '')
    .replace(ID, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The line under a side thread's title: the first heading or sentence of what it is about (the answer, section or
 *  sentence its context quotes), as shown words; '' when the context quotes nothing the title does not already say. */
export function aboutLine(label: string, context: string): string {
  const title = shownWords(label).replace(/…/g, '').toLowerCase()
  let body = false // past a lead-in ("The last answer in the main conversation:"): the lines after it are the passage
  for (const raw of context.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('```') || line.startsWith('|') || /^\[\[card:[A-Za-z0-9_-]+\]\]$/.test(line)) continue
    if (!body && line.endsWith(':')) {
      body = !NOT_ABOUT.test(line)
      continue
    }
    const lead = QUOTED.exec(line)
    if (!body && !lead) continue
    const words = shownWords(lead ? line.slice(lead[0].length) : line).replace(/^["“]/, '').replace(/["”]\.?$/, '')
    if (words.length < 3 || title.includes(words.toLowerCase().slice(0, 40))) continue
    const end = /[.!?](?=\s|$)/.exec(words)
    return end ? words.slice(0, end.index + 1) : words
  }
  return ''
}

/** A Bash output of a side thread's subagent, under the id its saved file has (.thimble-cc-mod/calls/<id>.json). */
export type ThreadCall = { id: string; output: string }

/** A thread's answer with each citation of a Bash output that names no saved output (the subagent was given no id, so
 *  it wrote call:none) pointed at the subagent's own output that holds the value: at the lines it cites, the latest
 *  output first, else at the one line of an output that holds it. A value no output holds keeps its citation, which
 *  the check then draws red. */
export function pinCalls(answer: string, calls: readonly ThreadCall[], saved: (id: string) => boolean): string {
  const latest = [...calls].reverse().map(c => ({ id: c.id, lines: c.output.split('\n') }))
  const pin = (raw: string): string => {
    const cite = citations(raw)[0]
    const m = /^call:([A-Za-z0-9_-]+)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(cite?.ref ?? '')
    const shown = cite?.display
    if (!m || !shown) return raw
    const [, id = '', a, b] = m
    if (saved(id) || !latest.length) return raw
    if (a) {
      const lo = Number(a)
      const hi = Number(b ?? a)
      const at = latest.find(c => lo >= 1 && hi >= lo && hi <= c.lines.length && valueIn(shown, c.lines.slice(lo - 1, hi).join('\n')))
      if (at) return `[[${shown}|call:${at.id}#L${a}${b ? `-L${b}` : ''}]]`
    }
    for (const c of latest) {
      const hits = c.lines.flatMap((l, i) => (valueIn(shown, l) ? [i + 1] : []))
      if (hits.length === 1) return `[[${shown}|call:${c.id}#L${hits[0]}]]`
      if (hits.length > 1) return raw
    }
    return raw
  }
  let out = ''
  let from = 0
  for (const sp of citeSpans(answer)) {
    out += answer.slice(from, sp.at) + pin(answer.slice(sp.at, sp.end))
    from = sp.end
  }
  return out + answer.slice(from)
}

/** A fix round's name, by what it corrects. */
export function fixName(items: ChatFixItem[]): string {
  const what = [items.some(it => !it.card) && 'citations', items.some(it => it.card) && 'cards'].filter(Boolean).join(' and ')
  return `verification · correcting ${what || 'citations'}`
}

/** A verification script's name, by the value it recomputes. */
export function verifyName(value: string): string {
  return `verification · checking ${value}`
}

/** A side thread's name, by the first words of its question. */
export function threadName(q: string): string {
  return `side thread · ${firstWords(plainCites(q), 40)}`
}

function firstWords(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  if (one.length <= n) return one
  const cut = one.slice(0, n + 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > n / 2 ? cut.slice(0, sp) : one.slice(0, n)).replace(/[\s,;:.]+$/, '')}…`
}

export function lastTurn(t: ChatThread, patch: Partial<ChatThreadTurn>): ChatThread {
  const turns = t.turns.slice()
  const i = turns.length - 1
  if (i >= 0) turns[i] = { ...turns[i]!, ...patch }
  return { ...t, turns }
}

/** A thread as the markdown file it is saved to. */
export function threadFile(t: ChatThread): string {
  return [`# Side thread: ${t.label}`, '', t.context, '', ...t.turns.flatMap(x => [`## ${x.q}`, '', x.a || `(${x.state})`, ''])].join('\n')
}

/** A thread as data, saved beside its markdown file so a later session can list and continue it. */
export function threadJson(t: ChatThread): string {
  return JSON.stringify({ ...t, agentId: '' }, null, 1)
}

/** A thread read back from its .json, or null when it is not one; a turn left running when its session ended is
 *  marked so. */
export function parseThread(raw: string): ChatThread | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const t = v as Partial<ChatThread> | null
  if (!t || typeof t.id !== 'string' || typeof t.label !== 'string' || !Array.isArray(t.turns)) return null
  const turns = t.turns
    .filter(x => x && typeof x.q === 'string')
    .map(x => (x.state === 'running' ? { ...x, state: 'error', a: x.a || '(the session ended before it answered)' } : x))
  return {
    id: t.id,
    label: t.label,
    ref: t.ref ?? '',
    context: t.context ?? '',
    agentId: '',
    engine: t.engine ?? '',
    turns,
    file: t.file ?? `.thimble-cc-mod/threads/${t.id}.md`,
    ...(typeof t.parent === 'string' && t.parent ? { parent: t.parent } : {}),
    ...(typeof t.at === 'number' ? { at: t.at } : {}),
    ...(typeof t.passage === 'string' && t.passage ? { passage: t.passage } : {}),
  }
}
