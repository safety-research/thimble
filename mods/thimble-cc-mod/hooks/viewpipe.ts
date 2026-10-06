// The view pipeline (views/SPEC.md, "The pipeline"), thimble's for the terminal: a proposal, a builder subagent, the
// checks of helper/viewpipe.py, a reviewer subagent that reads the drawn view, then the view in the panel. Pure: the
// prompts filled in, the proposals and their states read, the reviewer's answer parsed. The engine is in register.tsx.

export const BUILD_ATTEMPTS = 3 // builder turns before a build fails, the checks' report sent back after each
export const REVIEW_ROUNDS = 2 // revisions an open review may ask for (thimble's view_review.ROUNDS)
// One more revision fixes what the last open review found, and a review then checks those problems alone, so a view
// is not left with problems no builder was asked to fix.
export const LAST_ROUND = REVIEW_ROUNDS + 1
const FIELDS = [['unit', 'Unit'], ['overview', 'Overview'], ['zoom', 'Zoom'], ['filter', 'Filter'], ['details', 'Details']] as const

/** A proposal as helper/viewpipe.py writes it (.thimble-cc-mod/views/<slug>/proposal.json): thimble's propose_view
 *  fields, who proposed it, whether to build it at once, and when, which tells a proposal made again from the last. */
export type Proposal = {
  slug: string
  name: string
  why: string
  claims: string[]
  unit: string
  overview: string
  zoom: string
  filter: string
  details: string
  proposed_by: string
  build: boolean
  files: number
  ts: string
}

export type BuildState = 'proposed' | 'building' | 'checking' | 'reviewing' | 'revising' | 'built' | 'failed' | 'stopped'
export const ACTIVE: BuildState[] = ['building', 'checking', 'reviewing', 'revising']

/** Where a proposal's build stands (status.json, written by the mod): `for` the proposal's ts it built, the attempt and
 *  review round, the subagent working on it now (`agent`), the last checks' lines, the review's problems being fixed
 *  (`asked`), fixed and left, and why it failed. */
export type BuildStatus = {
  for: string
  state: BuildState
  attempt: number
  round: number
  step?: string
  checks?: string[]
  agent?: string
  asked?: string[]
  fixed?: string[]
  left?: string[]
  error?: string
  at: number
}

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

export function parseProposal(raw: unknown): Proposal | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const p: Proposal = {
    slug: str(r.slug),
    name: str(r.name),
    why: str(r.why),
    claims: Array.isArray(r.claims) ? r.claims.map(str).filter(Boolean) : [],
    unit: str(r.unit),
    overview: str(r.overview),
    zoom: str(r.zoom),
    filter: str(r.filter),
    details: str(r.details),
    proposed_by: str(r.proposed_by) || 'main',
    build: r.build === true,
    files: typeof r.files === 'number' ? r.files : 0,
    ts: str(r.ts),
  }
  return p.slug && p.name ? p : null
}

/** A template with each {{key}} replaced by its value; an unknown key is left as written. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k]! : m))
}

/** The proposal's layout as a ticket's bullets, one per field, as thimble's spec_lines writes them. */
export function proposalBullets(p: Proposal): string {
  return FIELDS.filter(([k]) => p[k]).map(([k, label]) => `- ${label}: ${p[k]}`).join('\n')
}

export function buildName(name: string): string {
  return `view · building ${name}`
}

export function reviewName(name: string): string {
  return `view · reviewing ${name}`
}

/** The note main reads (and the analyst does not see) when a view's build ended with the view ready: its name, the
 *  command that opens it, its folder, and what its review left. */
export function viewReadyNote(p: { name: string; slug: string }, home: string, left = 0, why = ''): string {
  const rest = left ? ` Its review left ${left} problem${left === 1 ? '' : 's'} unfixed, listed in the views pane.` : ''
  return `thimble-cc-mod: view ready: ${p.name} (open with /thimble-view ${p.slug}), in ${home}/views/${p.slug}/.${rest}${why ? ` ${why}` : ''}`
}

/** The worked examples for the builder: each folder's reader and sample, the spec the panel draws for it and the rows
 *  its reader gave, and its terminal design. `own` says which example folders hold a terminal spec of their own
 *  (a view.json with collections); for the others the spec is the test fixture's. */
export function examplesText(examples: string, fixtures: string, own: Record<string, boolean>, rowsOp: Record<string, boolean>): string {
  const kinds: [string, string][] = [
    ['timeline', 'events over time from several sources'],
    ['linked-sessions', 'agent transcripts, sessions and subagents'],
    ['repository', 'work items across runs, such as pull requests and issues'],
  ]
  const lines = kinds.map(([name, what]) => {
    const spec = own[name] ? `${examples}/${name}/view.json` : `${fixtures}/${name}/view.json`
    const rows = own[name] ? `${examples}/${name}/rows.json` : `${fixtures}/${name}/rows.json`
    return `- \`${name}\` is for ${what}: its reader ${examples}/${name}/reader.py and files ${examples}/${name}/sample/, the spec the panel draws ${spec}, its rows ${rows}, and the terminal design ${examples}/${name}/design.md.`
  })
  const browser = kinds.filter(([n]) => !rowsOp[n]).map(([n]) => `\`${n}\``)
  return [
    'Three example views show the contract above on invented data, each with its files described at the top of its `reader.py`. They are examples only, never views of this folder. Each sample is several files with the mess a real corpus has, such as renamed fields, mixed time formats, duplicates and a torn last line, and the reader cleans it, lists what it derived and reports what it could not parse. Read the one closest to your task for how a reader and a spec meet the contract. Their layouts fit their invented data, so lay out yours for the data you counted.',
    '',
    ...lines,
    ...(browser.length
      ? ['', `The readers of ${browser.join(', ')} were written for thimble's browser page, so their records() answers the page's own queries; yours answers {"op": "rows"} with every row at once, as the rows file shows.`]
      : []),
  ].join('\n')
}

/** The builder's first message: prompt/view-build.md filled in for the proposal. */
export function buildPrompt(template: string, p: Proposal, v: { corpus: string; folder: string; specMd: string; examples: string; check: string; render: string; draft: boolean }): string {
  return fill(template, {
    corpus: v.corpus,
    folder: v.folder,
    name: p.name,
    slug: p.slug,
    why: p.why,
    claims: p.claims.join(', '),
    spec: proposalBullets(p),
    spec_md: v.specMd,
    examples: v.examples,
    check: v.check,
    render: v.render,
    draft: v.draft ? '\nThe folder already holds this view as an earlier build left it: start from its files and change what the proposal now asks for.\n' : '',
  })
}

/** The status a builder starts with: the first of a proposal, one after checks that failed (`gates`), or one that fixes
 *  what a review found (`review`, the next round). */
export function buildStart(prev: BuildStatus | undefined, ts: string, follow: { gates?: string[]; review?: string[] }): Partial<BuildStatus> {
  const round = follow.review ? (prev?.round ?? 0) + 1 : follow.gates ? (prev?.round ?? 0) : 0
  return {
    for: ts,
    state: round ? 'revising' : 'building',
    attempt: follow.gates ? (prev?.attempt ?? 1) + 1 : 1,
    round,
    step: '',
    error: undefined,
    ...(follow.review ? { asked: follow.review } : {}),
    ...(follow.gates || follow.review ? {} : { fixed: [], left: [], asked: [], checks: [] }),
  }
}

/** What follows a builder's end, by the checks the mod ran then: a review (after every build that passes, as thimble
 *  reviews after each revision), another builder given the checks' report, the view put back as the review found it
 *  when its fixes never passed, or the build failed. `open`: a first build passed, so the view opens in the panel. */
export function afterBuild(s: BuildStatus, ok: boolean, lines: string[], reason: string): { next: 'review' | 'gates' | 'restore' | 'failed'; patch: Partial<BuildStatus>; open: boolean } {
  // the last revision's problems stay asked until the review after it says which it fixed
  if (ok && s.round >= LAST_ROUND) return { next: 'review', patch: { checks: lines }, open: false }
  if (ok) return { next: 'review', patch: { checks: lines, fixed: [...(s.fixed ?? []), ...(s.round ? (s.asked ?? []) : [])], asked: [] }, open: !s.round }
  if (s.attempt < BUILD_ATTEMPTS) return { next: 'gates', patch: { checks: lines }, open: false }
  if (s.round) return { next: 'restore', patch: { state: 'built', step: '', left: s.asked ?? [], asked: [], checks: lines }, open: false }
  const why = firstFailure(lines) || (reason === 'answer' ? 'the checks did not pass' : `the builder ended: ${reason}`)
  return { next: 'failed', patch: { state: 'failed', step: '', error: why.length > 160 ? `${why.slice(0, 159)}…` : why, checks: lines }, open: false }
}

/** What follows a review: the view done (no problems, or no answer), a builder that fixes them (the last one after
 *  REVIEW_ROUNDS open reviews), or, after the last revision, the problems it was asked to fix that are still there
 *  left and the others counted fixed. */
export function afterReview(s: BuildStatus, problems: string[] | null, reason: string): { next: 'done' | 'revise'; patch: Partial<BuildStatus> } {
  const last = s.round >= LAST_ROUND
  if (problems === null) {
    const error = reason === 'answer' ? 'the review gave no list of problems' : `the review ended: ${reason}`
    return { next: 'done', patch: { state: 'built', step: '', error, ...(last ? { left: s.asked ?? [], asked: [] } : {}) } }
  }
  if (last) return { next: 'done', patch: { state: 'built', step: '', left: problems, fixed: [...(s.fixed ?? []), ...fixedOf(s.asked ?? [], problems)], asked: [] } }
  if (!problems.length) return { next: 'done', patch: { state: 'built', step: '' } }
  return { next: 'revise', patch: {} }
}

/** The problems a revision was asked to fix that its review no longer names: matched by their words, and never more
 *  than the asked less the named. */
export function fixedOf(asked: readonly string[], still: readonly string[]): string[] {
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const same = (a: string, b: string) => {
    const [x, y] = [words(a), words(b)]
    return x === y || x.startsWith(y.slice(0, 60)) || y.startsWith(x.slice(0, 60))
  }
  return asked.filter(a => !still.some(b => same(a, b))).slice(0, Math.max(0, asked.length - still.length))
}

/** What the review after the last revision is told: the problems that revision was asked to fix, each to check in the
 *  drawings, the ones still there to be named as written and nothing else. Empty for an open review. */
export function lastLook(s: BuildStatus | undefined): string {
  if (!s || s.round < LAST_ROUND || !s.asked?.length) return ''
  return [
    '## This review checks the last fixes',
    '',
    'The builder was asked to fix the problems below, and this is the view after its fixes. Check each problem in the drawings, and draw another state where you need to. Answer with the problems still there, each copied as it is written here, and leave out the ones fixed. Name nothing else: no builder reads this answer, and the problems you name are left in the views pane for the analyst.',
    '',
    findingsText(s.asked),
    '',
  ].join('\n')
}

/** The reviewer's answer: the problems of the last JSON object in it with a `problems` list, or null when it gave none. */
export function parseFindings(answer: string): string[] | null {
  const text = answer.replace(/```(?:json)?/g, '')
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try {
        const v = JSON.parse(text.slice(start, end + 1)) as { problems?: unknown }
        if (v && Array.isArray(v.problems)) return v.problems.map(x => str(x)).filter(Boolean)
      } catch {
        // not this span
      }
    }
  }
  return null
}

/** The review's problems as the builder reads them, numbered. */
export function findingsText(problems: string[]): string {
  return problems.map((p, i) => `${i + 1}. ${p}`).join('\n')
}

/** The first line of the checks' report that failed, for a status line. */
export function firstFailure(lines: string[]): string {
  return lines.find(l => l.startsWith('problem: ') || l.startsWith('bad '))?.replace(/^problem: /, '') ?? ''
}

/** A proposal's state as the row above the prompt and the views pane show it: a mark and a few words. */
export function stateWords(s: BuildStatus | undefined, drawable: boolean): { mark: string; words: string; state: BuildState } {
  const state: BuildState = s?.state ?? (drawable ? 'built' : 'proposed')
  const attempt = s && s.attempt > 1 ? ` · attempt ${s.attempt}` : ''
  switch (state) {
    case 'building':
      return { mark: '◌', words: `building${attempt}${s?.step ? ` · ${s.step}` : ''}`, state }
    case 'checking':
      return { mark: '◌', words: `checking${attempt}`, state }
    case 'reviewing':
      return { mark: '◌', words: s && s.round >= LAST_ROUND ? 'built · checking the last fixes' : 'built · reviewing', state }
    case 'revising':
      return { mark: '◌', words: `built · fixing what the review found${s?.step ? ` · ${s.step}` : ''}`, state }
    case 'built': {
      const fixed = s?.fixed?.length ?? 0
      const left = s?.left?.length ?? 0
      // problems the review found and no builder fixed: the view works, but it is not done
      if (left) return { mark: '!', words: `built · ${left} problem${left === 1 ? '' : 's'} left${fixed ? `, ${fixed} fixed` : ''}${s?.error ? ` · ${s.error}` : ''}`, state }
      const rev = fixed ? ` · reviewed, ${fixed} fixed` : s && !s.error ? ' · reviewed' : ''
      return { mark: '●', words: `built${rev}${s?.error ? ` · ${s.error}` : ''}`, state }
    }
    case 'failed':
      return { mark: '×', words: `failed${s?.error ? `: ${s.error}` : ''}`, state }
    case 'stopped':
      return { mark: '○', words: drawable ? 'built · its last change stopped' : 'stopped before it was built', state }
    default:
      return { mark: '○', words: 'proposed', state }
  }
}

/** The views of a folder counted by state, as /thimble-views answers: "1 view built", "3 views: 2 built, 1 proposed". */
export function viewsCount(states: readonly BuildState[]): string {
  const n = states.length
  if (!n) return 'no view proposed in this folder yet'
  const by = new Map<BuildState, number>()
  for (const st of states) by.set(st, (by.get(st) ?? 0) + 1)
  const views = `${n} view${n === 1 ? '' : 's'}`
  if (by.size === 1) return `${views} ${states[0]}`
  return `${views}: ${[...by].map(([st, k]) => `${k} ${st}`).join(', ')}`
}

/** What a builder's tool call is doing, in a few words, for the status line: the file it writes or reads, the check. */
export function stepOf(tool: string, input: Record<string, unknown> | undefined): string {
  const base = (p: unknown) => (typeof p === 'string' ? (p.split('/').at(-1) ?? p) : '')
  const cmd = typeof input?.command === 'string' ? input.command : ''
  if (tool === 'Write' || tool === 'Edit') return `writing ${base(input?.file_path)}`
  if (tool === 'Read') return `reading ${base(input?.file_path)}`
  if (tool === 'Bash') {
    if (/viewpipe\.py\s+check/.test(cmd)) return 'running the checks'
    if (/render_view\.mjs/.test(cmd)) return 'drawing the view'
    if (/\b(head|tail|wc|sed|grep|jq|cat|ls)\b/.test(cmd)) return 'reading the files'
    return 'running a script'
  }
  if (tool === 'Grep' || tool === 'Glob') return 'reading the files'
  return ''
}

/** Whether a tool call of main's makes or changes a proposal: the helper's propose, or a proposal.json written. */
export function touchesProposals(tool: string, input: Record<string, unknown> | undefined): boolean {
  if (tool === 'Bash') return /viewpipe\.py\s+propose|proposal\.json/.test(String(input?.command ?? ''))
  if (tool === 'Write' || tool === 'Edit') return /\/views\/[a-z0-9-]+\/proposal\.json$/.test(String(input?.file_path ?? ''))
  return false
}

/** The agent a delivery to main comes from when it is a subagent's handed-back report ("[Subagent hand-back]"): the
 *  origin's `from`, else the id in its `<agent-message from="...">` envelope. */
export function handbackFrom(origin: { kind: string }, text: string): string | undefined {
  if (origin.kind !== 'peer') return undefined
  const from = (origin as { from?: unknown }).from
  if (typeof from === 'string' && from) return from
  return /<agent-message from="([^"]+)"/.exec(text)?.[1]
}

/** The report a hand-back delivers: the text after its frame, each line's indent of two spaces taken off. */
export function handbackReport(text: string): string {
  const at = text.indexOf('The report follows:')
  const body = at >= 0 ? text.slice(at + 'The report follows:'.length) : text
  return body
    .replace(/<\/agent-message>\s*$/, '')
    .split('\n')
    .map(l => l.replace(/^ {2}/, ''))
    .join('\n')
    .trim()
}
