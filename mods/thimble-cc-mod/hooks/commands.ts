// One interface for the orientation and labels, the same for the analyst and for main: /thimble-orient and
// /thimble-label take the arguments the `orient` and `label` tools take, under the same names, and the guidance names
// them too (prompt/chat.md). The names follow thimble's start_orientation and apply_label; thimble's own spellings
// (final_notebook, propose_views, generate_report, files, trial ...) are read as aliases.
//
// A command's arguments are read forgivingly: words, `key=value` (quoted when the value has spaces), `--flag`,
// `--no-flag` and `--key=value`. The command answers with one line of what it understood, or rejects an option it does
// not know with the list of those it takes.
//
// Why not /thimble:orient: Claude Code names a plugin's skills and markdown commands `/<plugin>:<name>`, so this mod's
// would be /thimble-cc-mod:orient, and `$.command.register` takes letters, digits, `_` and `-` only (checked live on
// 2.1.289: "thimble:orient" is refused, and a typed /thimble:orient that no plugin serves is "Unknown command" before
// any hook sees it). A plugin named `thimble` would collide with thimble's own. So the mod's commands are /thimble-*.

/** The orientation's switches, as thimble's Start gate offers them, and the analyst's focus. */
export type OrientOpts = { brief: string; deck: boolean; views: boolean; critique: boolean; report: boolean }

/** thimble's Start gate opens with every switch on (frontend StartGate ALL_ON). */
export const ORIENT_DEFAULTS: Omit<OrientOpts, 'brief'> = { deck: true, views: true, critique: true, report: true }

export const ORIENT_SWITCHES = ['deck', 'views', 'critique', 'report'] as const
type Switch = (typeof ORIENT_SWITCHES)[number]

/** Each switch's other spellings: thimble's start_orientation names, and words an analyst might type. */
const SWITCH_ALIASES: Record<string, Switch> = {
  deck: 'deck',
  cards: 'deck',
  final_notebook: 'deck',
  'final-notebook': 'deck',
  notebook: 'deck',
  analyze_data: 'deck',
  views: 'views',
  view: 'views',
  propose_views: 'views',
  'propose-views': 'views',
  critique: 'critique',
  critic: 'critique',
  review: 'critique',
  report: 'report',
  generate_report: 'report',
  'generate-report': 'report',
}
const BRIEF_KEYS = new Set(['brief', 'focus', 'about'])

export const ORIENT_USAGE = 'brief (or plain words: what to focus on), deck, views, critique, report (each on or off: deck=off, --no-deck, --report)'

/** A word read as on or off, or undefined. */
export function boolOf(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().toLowerCase()
  if (['on', 'true', 'yes', 'y', '1'].includes(s)) return true
  if (['off', 'false', 'no', 'n', '0', 'none'].includes(s)) return false
  return undefined
}

/** The words of a command's arguments: whitespace splits them except inside "…", '…' or “…”, and a `key="a b"`
 *  stays one word with its quotes taken off. */
export function tokenize(args: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  let had = false // a quoted empty value still makes a word
  const close: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' }
  for (const ch of args) {
    if (quote) {
      if (ch === close[quote]) quote = ''
      else cur += ch
      continue
    }
    if (ch in close && (cur === '' || cur.endsWith('='))) {
      quote = ch
      had = true
      continue
    }
    if (/\s/.test(ch)) {
      if (cur || had) out.push(cur)
      cur = ''
      had = false
      continue
    }
    cur += ch
  }
  if (cur || had) out.push(cur)
  return out
}

type Token = { kind: 'word'; text: string } | { kind: 'opt'; key: string; value?: string; raw: string }

/** A word as an option (`key=value`, `--flag`, `--no-flag`, `--key=value`) or a plain word. A word with `=` whose key
 *  is not a name (`a=b=c` is still key a) stays a word. */
function tokenOf(w: string): Token {
  const dash = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/s.exec(w)
  if (dash) return { kind: 'opt', key: dash[1]!.toLowerCase(), ...(dash[2] !== undefined ? { value: dash[2] } : {}), raw: w }
  const kv = /^([A-Za-z][\w-]*)=(.*)$/s.exec(w)
  if (kv) return { kind: 'opt', key: kv[1]!.toLowerCase(), value: kv[2]!, raw: w }
  return { kind: 'word', text: w }
}

/** /thimble-orient's arguments: plain words are the brief; a switch is `deck=off`, `--no-deck`, `--report` or
 *  `report=on`; `brief="…"` (or focus=) gives the brief whole. Switches left out keep the Start gate's defaults. */
export function parseOrientArgs(args: string): { opts: OrientOpts } | { error: string } {
  const words: string[] = []
  let brief: string | undefined
  const set: Partial<Record<Switch, boolean>> = {}
  for (const w of tokenize(args)) {
    const t = tokenOf(w)
    if (t.kind === 'word') {
      words.push(t.text)
      continue
    }
    if (BRIEF_KEYS.has(t.key)) {
      if (t.value === undefined) return { error: `give ${t.key} a value, as ${t.key}="the moderators". /thimble-orient takes ${ORIENT_USAGE}` }
      brief = t.value
      continue
    }
    const neg = t.key.startsWith('no-') || t.key.startsWith('no_') ? t.key.slice(3) : ''
    const sw = SWITCH_ALIASES[neg || t.key]
    if (!sw) return { error: `unknown option ${t.raw}. /thimble-orient takes ${ORIENT_USAGE}` }
    if (neg) {
      if (t.value !== undefined) return { error: `${t.raw}: write --no-${sw} or ${sw}=off. /thimble-orient takes ${ORIENT_USAGE}` }
      set[sw] = false
      continue
    }
    const on = t.value === undefined ? true : boolOf(t.value)
    if (on === undefined) return { error: `${t.raw}: ${sw} is on or off. /thimble-orient takes ${ORIENT_USAGE}` }
    set[sw] = on
  }
  const text = [brief ?? '', ...words].join(' ').replace(/\s+/g, ' ').trim()
  return { opts: { brief: text, ...ORIENT_DEFAULTS, ...set } }
}

/** The keys tool.call's input carries beside the tool's own arguments (claude-code ToolCallReserved, AgentLoop). */
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])

/** The `orient` tool's input as the options: the same names as the command, thimble's start_orientation names read as
 *  aliases; a switch left out keeps its default. An unknown key or a switch that is not on or off is refused. */
export function orientOptsOf(input: Record<string, unknown>): { opts: OrientOpts } | { error: string } {
  const set: Partial<Record<Switch, boolean>> = {}
  let brief = ''
  for (const [k, v] of Object.entries(input)) {
    if (RESERVED.has(k) || v === undefined || v === null) continue
    const key = k.toLowerCase()
    if (BRIEF_KEYS.has(key)) {
      brief = typeof v === 'string' ? v : String(v)
      continue
    }
    const sw = SWITCH_ALIASES[key]
    if (!sw) return { error: `unknown argument ${k}; the orient tool takes brief, deck, views, critique and report` }
    const on = boolOf(v)
    if (on === undefined) return { error: `${k} is true or false` }
    set[sw] = on
  }
  return { opts: { brief: brief.replace(/\s+/g, ' ').trim(), ...ORIENT_DEFAULTS, ...set } }
}

/** One line of what an orientation was asked for: `brief "…" · deck on · views on · critique on · report off`. */
export function orientLine(o: OrientOpts): string {
  const about = o.brief ? `brief "${o.brief.length > 60 ? `${o.brief.slice(0, 59)}…` : o.brief}"` : 'the whole corpus'
  return [about, ...ORIENT_SWITCHES.map(s => `${s} ${o[s] ? 'on' : 'off'}`)].join(' · ')
}

// ------------------------------------------------------------------------------------------------ labels

/** The label tool's input (harness.tsx LABEL_SCHEMA), canonical names: name, kind, definition, values, paths, field,
 *  within, limit. */
export type LabelInput = { name?: string; kind?: string; definition?: string; values?: string[]; paths?: string[]; field?: string; within?: { label: string; value?: string }; limit?: number }

export const LABEL_USAGE = 'a name, kind (prompt, regex or code), definition, values, paths, field, within (label=value), limit or --all; or list, open <name>'

const LABEL_ALIASES: Record<string, keyof LabelInput | 'all' | 'trial'> = {
  name: 'name',
  label: 'name',
  kind: 'kind',
  type: 'kind',
  definition: 'definition',
  def: 'definition',
  predicate: 'definition',
  text: 'definition',
  values: 'values',
  value: 'values',
  paths: 'paths',
  path: 'paths',
  files: 'paths',
  file: 'paths',
  glob: 'paths',
  globs: 'paths',
  field: 'field',
  column: 'field',
  within: 'within',
  limit: 'limit',
  sample: 'limit',
  n: 'limit',
  trial: 'trial',
  all: 'all',
}
const KINDS = ['prompt', 'regex', 'code'] as const
const TRIAL = 30 // --trial with no size: the guidance's "about 30 records"

/** A list of values or globs: split at commas, or at `|` when there is no comma. */
function listOf(raw: string, spaces = false): string[] {
  const parts = raw.includes(',') ? raw.split(',') : raw.includes('|') ? raw.split('|') : spaces ? raw.split(/\s+/) : [raw]
  return parts.map(s => s.trim()).filter(Boolean)
}

/** `within`: `label=value`, `label:value` or just the label (its first value). */
export function withinOf(raw: string): { label: string; value?: string } | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const at = s.lastIndexOf('=') > 0 ? s.lastIndexOf('=') : s.lastIndexOf(':')
  if (at > 0 && at < s.length - 1) return { label: s.slice(0, at).trim(), value: s.slice(at + 1).trim() }
  return { label: s.replace(/[=:]$/, '').trim() }
}

export type LabelCommand =
  | { op: 'list' }
  | { op: 'open'; name: string }
  /** define a label, or run one of this folder again (`input` holds only its name and maybe a limit) */
  | { op: 'run'; input: LabelInput; all: boolean }
  | { error: string }

/** /thimble-label's arguments: nothing or `list` lists the labels, `open <name>` opens one, anything else defines (or
 *  runs again) a label: plain words are its name, options its parts. */
export function parseLabelArgs(args: string): LabelCommand {
  const words = tokenize(args)
  if (!words.length || (words.length === 1 && /^(list|ls)$/i.test(words[0]!))) return { op: 'list' }
  if (/^(open|show)$/i.test(words[0]!)) {
    const name = words.slice(1).join(' ').trim()
    return name ? { op: 'open', name } : { error: `open which label? /thimble-label open <name>` }
  }
  const input: LabelInput = {}
  const names: string[] = []
  let all = false
  for (const w of words) {
    const t = tokenOf(w)
    if (t.kind === 'word') {
      names.push(t.text)
      continue
    }
    // --prompt / regex="…": the kind, and with a value the definition too
    if ((KINDS as readonly string[]).includes(t.key)) {
      input.kind = t.key
      if (t.value !== undefined) input.definition = t.value
      continue
    }
    const key = LABEL_ALIASES[t.key]
    if (!key) return { error: `unknown option ${t.raw}. /thimble-label takes ${LABEL_USAGE}` }
    if (key === 'all') {
      if (t.value !== undefined && boolOf(t.value) === false) continue
      all = true
      continue
    }
    if (key === 'trial') {
      if (t.value !== undefined && boolOf(t.value) === false) {
        all = true
        continue
      }
      const n = t.value === undefined || boolOf(t.value) === true ? TRIAL : Number(t.value)
      if (!Number.isInteger(n) || n <= 0) return { error: `${t.raw}: a trial is a number of records, such as trial=30` }
      input.limit = n
      continue
    }
    if (t.value === undefined) return { error: `give ${t.key} a value, as ${t.key}=…. /thimble-label takes ${LABEL_USAGE}` }
    const v = t.value
    if (key === 'limit') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0) return { error: `${t.raw}: limit is a number of records, such as limit=30` }
      if (n === 0) all = true
      else input.limit = n
    } else if (key === 'kind') {
      const k = v.toLowerCase()
      if (!(KINDS as readonly string[]).includes(k)) return { error: `${t.raw}: kind is prompt, regex or code` }
      input.kind = k
    } else if (key === 'values') input.values = listOf(v)
    else if (key === 'paths') input.paths = [...(input.paths ?? []), ...listOf(v, true)]
    else if (key === 'within') {
      const wi = withinOf(v)
      if (wi) input.within = wi
    } else if (key === 'name') input.name = v.trim()
    else if (key === 'definition') input.definition = v
    else if (key === 'field') input.field = v.trim()
  }
  const name = names.join(' ').trim()
  if (name && input.name) return { error: `the label's name twice: "${name}" and name="${input.name}"` }
  if (name) input.name = name
  if (!input.name) return { error: `name the label: /thimble-label <name> kind=… definition=… paths=…. /thimble-label takes ${LABEL_USAGE}` }
  if (all && input.limit) return { error: 'both a trial size and --all: give one' }
  return { op: 'run', input, all }
}

/** Whether a label command only names a label (and maybe a trial size or --all): one of this folder, opened or run again. */
export function namesOnly(x: LabelInput): boolean {
  return x.kind === undefined && x.definition === undefined && x.values === undefined && x.paths === undefined && x.field === undefined && x.within === undefined
}

/** The label tool's input with the command's other spellings read as its names (files → paths, trial → limit, …). */
export function labelInputOf(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    const key = LABEL_ALIASES[k.toLowerCase()]
    if (key === 'trial') {
      if (out.limit === undefined) out.limit = typeof v === 'number' ? v : v === true ? TRIAL : Number(v)
    } else if (key === 'all') continue
    else if (key === 'paths' && typeof v === 'string') out.paths = listOf(v, true)
    else if (key === 'values' && typeof v === 'string') out.values = listOf(v)
    else if (key === 'within' && typeof v === 'string') out.within = withinOf(v)
    else if (key) out[key] = v
    else out[k] = v
  }
  return out
}

/** One line of what a label command was understood as: `label "…" · prompt · tickets/*.jsonl · values yes, no · trial
 *  of 30 records`. */
export function labelLine(x: LabelInput, all = false): string {
  const parts = [`label "${x.name ?? ''}"`]
  if (x.kind) parts.push(x.kind)
  if (x.definition) parts.push(`"${x.definition.length > 50 ? `${x.definition.slice(0, 49)}…` : x.definition}"`)
  if (x.paths?.length) parts.push(x.paths.join(', '))
  if (x.field) parts.push(`field ${x.field}`)
  if (x.values?.length) parts.push(`values ${x.values.join(', ')}`)
  if (x.within) parts.push(`within "${x.within.label}"${x.within.value ? ` = ${x.within.value}` : ''}`)
  parts.push(x.limit ? `trial of ${x.limit} records` : all || !namesOnly(x) ? 'every record' : '')
  return parts.filter(Boolean).join(' · ')
}
