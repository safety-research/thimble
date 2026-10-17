// The settings gear's popover, under its title. First one table, a row per role with exactly the model and effort that
// runs: main, whose model is read-only (only /model in the terminal changes it, and the table reads it from main's meta
// as the composer does) and whose effort and fast mode, the bolt beside its effort, are kept for its next launch (PUT
// session/effort and session/fast); thimble's agents (the orientation, the orientation's subagents run as
// thimble:orient-helper, the critic, the writers, the dev agent of view builds, reviews and code tickets, the report
// checks), each with a switch in the "web" column that keeps it off WebFetch and WebSearch; the model calls (labels,
// the card check, the viewer suggestion), each a subagent of the session too; and the row a model call runs again on
// when its model refuses, whose model menu also has Off. Only main has fast mode: a subagent has none of its own. Then
// one row per agent of the extensions running here (`<extension>:<agent>`). The effort menu lists Claude Code's levels,
// and a model that runs with no effort shows none. An agent's row applies to its next start. A save sends only the
// changed fields so defaults stay defaults (thimble's config, backend userconf.py). Choices that cannot take effect are
// dimmed with the reason in a tooltip. Every row names its model exactly, never `default`. Under the table, thimble's
// feature switches (FEATURE_ROWS: View proposals, Labels, Checks, Citation marks, Coverage, Card check), the same
// switches as /config → thimble in the terminal, kept in thimble's config (`features`, backend features.py; View
// proposals as `views.propose`, which a view proposal's Don't ask again turns off); the Ask key choice, ⌘-click or
// ⌥-click (Ctrl-click or Alt-click off a Mac), whose other key places a card freely on the canvas (thimble's config
// `askKey`, lib/platform); then thimble's rules for main and its agents, the subagents of the analyst's Claude Code
// session (web, edits of the data, and whether the session's shell runs in Claude Code's sandbox), with the CLAUDE.md
// files each agent reads; then the one agent with a permission mode of its own, an extension's program that runs the
// dev agent, shown only where one does, with Manual or Auto (no Bypass: thimble 0.9.0 sets no agent to skip its
// permission prompts), and its own fence; then labels and the card check, which have no mode; then how long a code
// ticket's question about thimble's code waits on its card (cardWait); then the extensions added to thimble, each with
// its switch for this workspace (ExtensionsSettings). In the foot, beside Take the tour, Sign out this browser signs
// this browser out (POST /ui/signout with its own id, lib/notices ownBrowserId), and every tab shows the sign-in line
// (bug hunt G4: the browser had no way to sign itself out).
import { Fragment, useEffect, useState } from 'react'
import { Button, Segmented } from '../components/Button'
import { Chip } from '../components/Chip'
import { TextInput } from '../components/Field'
import { Menu, type MenuItem } from '../components/Menu'
import { Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { Switch } from '../components/Switch'
import { useTooltip } from '../components/Tooltip'
import { api } from '../lib/api'
import { clearBrowserKey } from '../lib/browserKey'
import { ownBrowserId } from '../lib/notices'
import { ExtensionsSettings, answeredRuns, changedLocalViews, changedViews, extensionCalls, viewKey } from './ExtensionsSettings'
import { hasEffort, hasFastMode, invalidateSettings, loadSettings, modelChoices, modelLabel, sameModel } from '../lib/models'
import { EFFORTS, ROLES, type AgentRow, type Attached, type CallAgent, type Extensions, type FeatureKey, type MainEffort, type MainFence, type ModeAgent, type ModelConf, type OrientPermissions, type Settings, type SettingsPatch, type TaskRow } from '../lib/types'
import { bus } from '../lib/bus'
import { askKeyLabel, isMacPlatform, setAskKey, type AskKey } from '../lib/platform'
import { EFFORT_CHOICES, FastBolt, MODEL_TIP, NEXT_LAUNCH, effortWord, mainEffort, mainFast } from '../chat/ModelLine'

type Models = Record<string, ModelConf>

/** The agents with a permission mode of their own: only an extension's program that runs the dev agent (backend
 * modes.AGENTS); code tickets' agents are subagents of the analyst's session and run in its mode. */
export const MODE_ROWS: { agent: ModeAgent; label: string }[] = [{ agent: 'dev', label: "Dev agent's program" }]
/** The ways an extension runs an agent as a program of its own, a job of thimble's server (backend roles.CODE_WAYS). */
const PROGRAM_WAYS = ['sdk', 'command']
/** Whether a MODE_ROWS row applies: an extension runs that agent with a program of its own. Pure. */
export const modeRowShown = (row: Pick<AgentRow, 'way'> | undefined): boolean => !!row && PROGRAM_WAYS.includes(row.way)
const MODE_NAME: Record<OrientPermissions, string> = { manual: 'Manual', auto: 'Auto', bypass: 'Manual' }
/** The modes of the dev agent's program, by the names the menu shows: no Bypass (backend modes.choose refuses it). */
export const MODE_OPTIONS: { value: OrientPermissions; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto' },
]
/** The one line on the modes of every other agent. */
export const MAIN_MODE_LINE = "thimble's agents, code tickets' among them, run in your Claude Code session's permission mode."

/** A Claude Code permission mode (main's `attached.permission_mode`) as the program's menu names it: Auto for auto,
 * Bypass for bypassPermissions, Manual for any other or none known (backend modes.OF_CLAUDE). Pure. */
export const permissionChoice = (mode: string | null | undefined): OrientPermissions =>
  mode === 'auto' ? 'auto' : mode === 'bypassPermissions' ? 'bypass' : 'manual'

/** The mode the dev agent's program starts in: its row as the server answers it, else the mode of the analyst's Claude
 * Code session, else Manual, whichever their Claude Code settings do not turn off (backend modes.mode_for); Bypass,
 * from a row an earlier version wrote or from the session, counts as Manual. Pure. */
export function agentMode(rows: Settings['permission_modes'], agent: ModeAgent, sessionMode: string | null | undefined, off: readonly string[] = []): OrientPermissions {
  const manual = (m: OrientPermissions | undefined): OrientPermissions | undefined => (m === 'bypass' ? 'manual' : m)
  return [manual(rows?.[agent]), manual(permissionChoice(sessionMode)), 'manual' as const].find((m): m is OrientPermissions => !!m && !off.includes(m))!
}

/** What a CALL_ROWS row shows where the dev agent's program shows its permission mode, and why: a model call through
 * the session's own client asks nothing; the card check, a subagent of the session that reads the card's picture,
 * follows its permission mode. */
const PROGRAM_TIP = "An extension's program that runs its tasks has no thread to ask you in."
export const CALL_CELLS = {
  model: { cell: 'Asks nothing', tip: `It is one model call through your Claude Code session's own sign-in, with no tools, so it asks nothing in any mode.\n${PROGRAM_TIP}` },
  subagent: { cell: "Your session's", tip: `It runs as a subagent of your Claude Code session, in its permission mode: Manual mode asks before it reads its task and before it sends its answer.\n${PROGRAM_TIP}` },
} as const
/** The agents of thimble's config that are one model call each, listed after the dev agent's program; their settings
 * reach an extension's program that runs their tasks (backend userconf.CALLS). */
export const CALL_ROWS: { agent: CallAgent; label: string; runs: keyof typeof CALL_CELLS }[] = [
  { agent: 'labels', label: 'Labels', runs: 'model' },
  { agent: 'cardCheck', label: 'Card check', runs: 'subagent' },
]

const DATA_WORDS: Record<NonNullable<AgentRow['data']>, string> = { ask: 'asks to edit data', allow: 'may edit data', off: 'never edits data' }
const DATA_TIP: Record<NonNullable<AgentRow['data']>, string> = {
  ask: 'It asks you before it changes a file of your data.',
  allow: 'It may change files of your data without asking.',
  off: 'It never changes a file of your data.',
}

/** Who runs an agent or a task, in a few words: thimble, or the extension and how. Pure. */
export function runsWords(row: Pick<AgentRow, 'way' | 'extension' | 'additions' | 'conflict'>): string {
  if (row.conflict.length) return `thimble, since ${row.conflict.join(' and ')} both replace it`
  const added = row.additions.length ? ` + ${row.additions.join(', ')}` : ''
  if (row.way === 'sdk') return `${row.extension}, Agent SDK, which thimble no longer starts`
  if (row.way === 'command') return `${row.extension}, own program`
  if (row.way === 'prompt') return `${row.extension}'s prompt${added}`
  return `thimble${added}`
}

/** What an agent may do with the data, in words: a labels or card check row (one with `tasks`) has no thread to ask in,
 * so at `ask` it never edits it. Pure. */
const dataWords = (row: AgentRow): string => (row.tasks && row.data === 'ask' ? DATA_WORDS.off : DATA_WORDS[row.data ?? 'ask'])

/** An agent's line under its row: who runs it and what its own fence lets it do, from thimble's config. Pure. */
export function agentLine(row: AgentRow): string {
  const box = row.sandbox === 'off' ? 'sandbox off' : row.sandbox_runs ? 'sandbox on' : 'no sandbox here'
  return [runsWords(row), box, `network ${row.network ?? 'on'}`, dataWords(row)].join(' · ')
}

/** The tasks an extension changes, with who runs them, the tasks one runner runs named together; '' when thimble runs
 * every task as it ships. Pure. */
export function tasksLine(rows: TaskRow[] | undefined): string {
  const changed = (rows ?? []).filter((t) => t.way !== 'thimble' || t.additions.length || t.conflict.length)
  const by = new Map<string, string[]>()
  for (const t of changed) by.set(runsWords(t), [...(by.get(runsWords(t)) ?? []), t.task])
  const names = (ts: string[]) => (ts.length > 1 ? `${ts.slice(0, -1).join(', ')} and ${ts[ts.length - 1]}` : ts[0])
  return [...by].map(([who, ts]) => `${names(ts)} by ${who}`).join(' · ')
}

/** What an agent's line means, one sentence per line, for its tooltip. Pure. */
export function agentTip(row: AgentRow): string {
  const who = row.conflict.length ? `thimble runs it, since ${row.conflict.join(' and ')} both replace it.`
    : row.way === 'sdk' ? `${row.extension} replaces it with an Agent SDK program, which thimble no longer starts: it starts no Claude Code session of its own.`
    : row.way === 'command' ? `${row.extension} runs it with its own program.`
    : row.way === 'prompt' ? `thimble runs it with ${row.extension}'s prompt.`
    : 'thimble runs it.'
  const box = row.sandbox === 'off' ? 'Sandbox off: its commands can write anywhere you can.'
    : row.sandbox_runs ? 'Sandbox on: its commands write only in its own folder.'
    : 'The sandbox cannot run on this machine.'
  const net = row.network === 'off' ? 'Network off: it reaches no host.' : 'Network on: it can reach the internet.'
  const added = row.additions.length ? [`${row.additions.join(', ')} add${row.additions.length > 1 ? '' : 's'} to its prompt.`] : []
  const tasks = row.tasks ?? []
  const names = tasks.length > 1 ? `${tasks.slice(0, -1).join(', ')} or ${tasks[tasks.length - 1]}` : tasks[0]
  const reach = tasks.length ? [`Its sandbox, network and data apply to an extension's program that runs ${names}.`] : []
  const data = row.tasks && row.data === 'ask' ? 'It has no thread to ask you in, so it never changes a file of your data.' : DATA_TIP[row.data ?? 'ask']
  return [who, ...added, ...reach, box, net, data, "It never reads thimble's key.", `Change these under ${row.config} in thimble's config.`].join('\n')
}

/** Main's row of thimble's rules, in words: its web, its edits of the data, and its shell (`box` while the session's
 * shell commands run in Claude Code's sandbox, Attached.sandbox). */
export const WEB_MAIN = { mode: 'web follows your mode', off: 'no web' } as const
export const DATA_MAIN: Record<NonNullable<MainFence['data']>, string> = { ask: 'data edits follow your mode', allow: 'data edits follow your mode', off: 'never edits data' }
export const SHELL_MAIN = { box: "shell in Claude Code's sandbox", mode: 'shell follows your mode' } as const

/** thimble's rules for main and its agents in words: web, edits of the data and the shell, which runs in Claude Code's
 * sandbox when `sandbox` (the session's Attached.sandbox). Pure. */
export function fenceLine(f: MainFence | null | undefined, sandbox?: boolean | null): string {
  if (!f) return ''
  return [WEB_MAIN[f.web === 'off' ? 'off' : 'mode'], DATA_MAIN[f.data ?? 'ask'], SHELL_MAIN[sandbox ? 'box' : 'mode']].join(' · ')
}

/** What thimble's rules for main and its agents mean, one sentence per line, for their tooltip. Pure. */
export function fenceTip(f: MainFence, sandbox?: boolean | null): string {
  const web = f.web === 'off' ? 'Web off: no agent fetches pages or searches the web.' : 'Web: a fetch or a search follows your permission mode.'
  const data = f.data === 'off' ? 'Data off: no agent changes a file of your data.' : 'Data: an edit of a file of your data follows your permission mode.'
  const shell = sandbox ? "Shell: commands run in Claude Code's sandbox." : sandbox === false ? "Shell: commands follow your permission mode. Claude Code's sandbox is off in this session." : 'Shell: commands follow your permission mode.'
  return [web, data, shell, 'Everything else follows your Claude Code permission mode.', `Change web and data under ${f.config ?? 'agents.orientation'} in thimble's config.`].join('\n')
}

function AgentLine({ row }: { row: AgentRow }) {
  const { props, tip } = useTooltip(agentTip(row), 'tip-lines', 'start')
  return (
    <>
      <span className="settings-agent-line" data-way={row.way} tabIndex={0} {...props}>
        {agentLine(row)}
      </span>
      {tip}
    </>
  )
}

function FenceLine({ fence, sandbox }: { fence: MainFence; sandbox?: boolean | null }) {
  const { props, tip } = useTooltip(fenceTip(fence, sandbox), 'tip-lines', 'start')
  return (
    <>
      <span className="settings-agent-line settings-fence-line" tabIndex={0} {...props}>
        {fenceLine(fence, sandbox)}
      </span>
      {tip}
    </>
  )
}

/** A CALL_ROWS row's cell where the code tickets have their permission mode. */
function CallCell({ label, runs }: { label: string; runs: keyof typeof CALL_CELLS }) {
  const { cell, tip: why } = CALL_CELLS[runs]
  const { props, tip } = useTooltip(why, 'tip-lines', 'start')
  return (
    <>
      <Chip kind="plain" face="sans" className="settings-cell settings-mode settings-mode-none" tabIndex={0} aria-label={`${label}: ${cell}`} {...props}>
        {cell}
      </Chip>
      {tip}
    </>
  )
}

type Rows = Settings['permission_modes']

/** What a save sends for the permission modes: each agent whose pick differs from the loaded one, null for one put
 * back on the session's mode. Pure. */
export function changedModes(loaded: Rows, now: Rows): Partial<Record<ModeAgent, OrientPermissions | null>> {
  const out: Partial<Record<ModeAgent, OrientPermissions | null>> = {}
  for (const { agent } of MODE_ROWS) if ((loaded?.[agent] ?? null) !== (now?.[agent] ?? null)) out[agent] = now?.[agent] ?? null
  return out
}

/** The roles in the table: main, the known ones the settings name in their order, then any other they name (an
 * extension's agent). Pure. */
export const rolesOf = (s: Settings | null): string[] => {
  const known = Object.keys(s?.models ?? {})
  return [...ROLES.filter((r) => r === 'main' || known.includes(r)), ...known.filter((r) => !(ROLES as readonly string[]).includes(r))]
}

/** A role's name in the table where its id alone would not say what it is. */
export const ROLE_LABEL: Record<string, string> = {
  orient: 'orientation',
  subagents: 'orientation subagents',
  writer: 'writers',
  checks: 'report checks',
  verify: 'card check',
  suggest: 'viewer suggestion',
  refusal: 'if refused',
}
/** A row's note under its name: what it covers, where its id does not say. */
export const ROLE_NOTE: Record<string, string> = {
  subagents: "for subagents the orientation starts as thimble:orient-helper; others run on the orientation's own model and effort",
  dev: 'view builds, view reviews and code tickets',
  suggest: "which viewer a file of an unknown type needs; a view proposal runs on your session's model",
  refusal: "if a model call's model refuses, the call runs again on this model, or not at all when Off",
}
/** thimble's agents, whose rows apply to their next start. */
export const AGENT_ROLES = ['orient', 'subagents', 'critic', 'writer', 'dev', 'checks'] as const
/** The model calls: labels and the viewer suggestion through main's own client, the card check a `thimble:call`
 * subagent of main; none has a fast mode of its own. */
export const CLASSIFIER_ROLES = ['labels', 'verify', 'suggest'] as const
/** The agents whose web switch the table offers (backend userconf.SUBAGENT_ROLES less the orientation, whose web is
 * main's rule). */
export const WEB_ROWS = ['critic', 'writer', 'checks'] as const
export type WebRow = (typeof WEB_ROWS)[number]
/** The table's last column, in words: each agent's switch for the web. */
export const WEB_HEAD_TIP = 'Whether the agent may fetch pages and search the web; off keeps it off the web'
/** The refusal row's model menu's last choice, which runs a refused call on no other model. */
export const REFUSAL_OFF = 'Off'
/** The dev row's web switch's reason: the dev agent's web in thimble's config reaches all of its work. */
export const DEV_WEB_WHY = "The dev agent's view builds, reviews and code tickets follow agents.dev.web in thimble's config."
/** The line on how long a code ticket's question about thimble's own code waits on its card (cardWait). */
export const cardWaitLine = (minutes: number): string =>
  `A code ticket asks you before its change reaches thimble's own code; its card waits ${minutes} min (cardWait).`
/** The line under the table. */
export const NEXT_START_LINE = "An agent's row applies to its next start; a run that goes on keeps its own model and effort."
/** The View proposals switch's name and note. */
export const PROPOSE_LABEL = 'View proposals'
export const PROPOSE_NOTE = 'thimble may propose a view for your task above the reply box. Nothing builds until you accept it.'

/** thimble's feature switches in Settings, the same rows as /config → thimble in the terminal, in that order (View
 * proposals first, as PROPOSE_LABEL): each key as thimble's config `features` names it (backend
 * features.py), its name and what it does. Off, a feature runs nothing in the background. */
export const FEATURE_ROWS: { key: FeatureKey; label: string; note: string }[] = [
  { key: 'labels', label: 'Labels', note: 'Claude can label every record of a file with a model.' },
  { key: 'checks', label: 'Checks', note: 'The checks that are on comment on answers that read data, and on documents.' },
  { key: 'citationMarks', label: 'Citation marks', note: 'thimble checks each citation in an answer and marks one it cannot verify red with ×.' },
  { key: 'coverage', label: 'Coverage', note: "A line under answers that read data says how much of the data Claude's tool calls saw." },
  { key: 'cardCheck', label: 'Card check', note: "thimble checks each new card's chart and citations." },
]

/** The feature switches as Settings loaded them: on unless thimble's config turns a feature off. Pure. */
export function featureRows(s: Settings | null): Record<FeatureKey, boolean> {
  return Object.fromEntries(FEATURE_ROWS.map(({ key }) => [key, s?.features?.[key] !== false])) as Record<FeatureKey, boolean>
}

/** What a save sends for the feature switches: false for one turned off, null for one put back on (the default), only
 * those that changed. Pure. */
export function changedFeatures(loaded: Settings | null, now: Record<FeatureKey, boolean>): Partial<Record<FeatureKey, false | null>> {
  const was = featureRows(loaded)
  const out: Partial<Record<FeatureKey, false | null>> = {}
  for (const { key } of FEATURE_ROWS) if (was[key] !== now[key]) out[key] = now[key] ? null : false
  return out
}

/** The Ask key choice's name, its options as the platform writes them (⌘-click and ⌥-click on a Mac, Ctrl-click and
 * Alt-click elsewhere), and its note: what the other key does. */
export const ASK_KEY_LABEL = 'Ask key'
export const askKeyOptions = (mac: boolean): { value: AskKey; label: string }[] =>
  (['meta', 'alt'] as const).map((k) => ({ value: k, label: `${askKeyLabel(mac, k)}-click` }))
export const askKeyNote = (mac: boolean, key: AskKey): string =>
  `${askKeyLabel(mac, key)}-click asks about anything in thimble; ${askKeyLabel(mac, key === 'alt' ? 'meta' : 'alt')}-drag places a card freely on the canvas.`

/** What a save sends for the ask key: "alt", null to put back the default (⌘), nothing when the choice did not change.
 * Pure. */
export function changedAskKey(loaded: Settings | null, key: AskKey): { ask_key?: 'alt' | null } {
  return (loaded?.ask_key === 'alt' ? 'alt' : 'meta') === key ? {} : { ask_key: key === 'alt' ? 'alt' : null }
}

/** What a save sends for View proposals: false to turn them off, null to put back the default (on), nothing when the
 * switch did not change. Pure. */
export function changedPropose(loaded: Settings | null, on: boolean): { propose_views?: false | null } {
  return (loaded?.propose_views !== false) === on ? {} : { propose_views: on ? null : false }
}

/** An extension's agent, whose row is keyed `<extension>:<agent>` as thimble's config keys it. */
const isExtensionAgent = (role: string): boolean => role.includes(':')
/** A row's name in the table: an extension's agent by its own name. Pure. */
export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? (isExtensionAgent(role) ? role.slice(role.indexOf(':') + 1) : role)
/** The orientation subagents' model while they follow the orientation's. */
export const SAME_AS_ORIENT = 'Same as orientation'

/** The efforts a role's menu offers: Claude Code's levels for every agent and classifier; main's add ultracode, which
 * only main takes. Pure. */
export function roleEfforts(role: string): string[] {
  if (role === 'main') return [...EFFORT_CHOICES]
  return [...EFFORTS]
}

/** Why a role's cell cannot be changed here, or null when it can. Only main has fast mode; a model with no effort has
 * no effort to pick. Pure. */
export function lockedWhy(role: string, cell: 'model' | 'effort' | 'fast', conf: ModelConf, main: { attached: boolean }): string | null {
  if (role === 'main') {
    if (cell === 'model') return MODEL_TIP
    return main.attached ? null : 'No Claude Code session is attached to main'
  }
  if (cell === 'effort' && conf.model && !hasEffort(conf.model)) return `${modelLabel(conf.model)} runs with no effort`
  if (cell === 'fast') return "thimble's agents have no fast mode of their own"
  return null
}

/** The model a role runs, as its row names it: the followed role's while it follows one (the orientation subagents
 * the orientation's), else its own. Pure. */
export function shownModel(role: string, models: Models): string {
  const conf = models[role]
  const of = conf?.follows
  return (of && models[of]?.model) || conf?.model || ''
}

/** What a save sends: for each role changed here the fields that differ from what was loaded, so a default left alone
 * stays a default. Pure. */
export function changedRoles(loaded: Models, now: Models): Record<string, Partial<ModelConf>> {
  const out: Record<string, Partial<ModelConf>> = {}
  for (const [role, conf] of Object.entries(now)) {
    if (role === 'main') continue
    const was = loaded[role]
    const patch: Partial<ModelConf> = {}
    if (!was || was.model !== conf.model) patch.model = conf.model
    if (!was || was.effort !== conf.effort) patch.effort = conf.effort
    if (role === 'refusal' && !!was?.off !== !!conf.off) patch.off = !!conf.off
    if (Object.keys(patch).length) out[role] = patch
  }
  return out
}

/** Each agent's web as the table holds it: on is main's rule, off keeps it off the web. */
export type WebRows = Partial<Record<WebRow, boolean>>

/** The web switches as Settings loaded them: on unless the agent's `web` is off. Pure. */
export function webRows(s: Settings | null): WebRows {
  return Object.fromEntries(WEB_ROWS.map((r) => [r, s?.agents?.[r]?.web !== 'off'])) as WebRows
}

/** What a save sends for the web switches: `off` for an agent switched off, null for one put back on main's rule. Pure. */
export function changedWeb(loaded: WebRows, now: WebRows): NonNullable<SettingsPatch['web']> {
  const out: NonNullable<SettingsPatch['web']> = {}
  for (const r of WEB_ROWS) if ((loaded[r] ?? true) !== (now[r] ?? true)) out[r] = now[r] === false ? 'off' : null
  return out
}

/** The CLAUDE.md files an agent reads, as its row says: on unless its `memory` is off. Pure. */
export const memoryWords = (memory: unknown): string => (memory === 'off' ? 'CLAUDE.md files: off' : 'CLAUDE.md files: on')

const EMPTY: ModelConf = { model: '', effort: 'medium', fast: false }

/** A cell that cannot be changed here: the same chip, dimmed, focusable, its reason in the tooltip. */
function LockedChip({ why, label, children }: { why: string; label: string; children: string }) {
  const { props, tip } = useTooltip(why)
  return (
    <>
      <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-locked" aria-label={label} aria-disabled="true" {...props}>
        {children}
      </Chip>
      {tip}
    </>
  )
}

/** An agent's web switch: on is main's rule, which follows the session's mode, off keeps it off WebFetch and WebSearch
 * (its disallowedTools). */
function WebSwitch({ role, on, onChange, why }: { role: string; on: boolean; onChange?: (on: boolean) => void; why?: string }) {
  const { props, tip } = useTooltip(why ?? (on ? `Web: your session's mode. Switch it off to keep the ${roleLabel(role)} off the web.` : `Web off: the ${roleLabel(role)} never fetches a page or searches the web.`))
  return (
    <>
      <span className={`settings-web${why ? ' settings-locked' : ''}`} data-on={on} {...props}>
        <Switch checked={on} onChange={() => !why && onChange?.(!on)} aria-label={`${roleLabel(role)} web`} disabled={!!why} />
      </span>
      {tip}
    </>
  )
}

export function SettingsPopover({ ws, anchor, open, onClose }: { ws: string; anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<Models>({})
  const [attached, setAttached] = useState<Attached | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the role whose model is being typed rather than picked
  const [typing, setTyping] = useState<string | null>(null)
  const [modeRows, setModeRows] = useState<Rows>({})
  const [web, setWeb] = useState<WebRows>({})
  const [exts, setExts] = useState<Extensions | null>(null)
  const [extOn, setExtOn] = useState<Record<string, boolean>>({})
  const [viewOn, setViewOn] = useState<Record<string, boolean>>({})
  const [localOn, setLocalOn] = useState<Record<string, boolean>>({})
  // each answer to an extension's question whether to run its orientation now, sent on Save
  const [runAnswers, setRunAnswers] = useState<Record<string, boolean>>({})
  // View proposals (thimble's config `views.propose`)
  const [propose, setPropose] = useState(true)
  // the feature switches (thimble's config `features`)
  const [features, setFeatures] = useState<Record<FeatureKey, boolean>>(featureRows(null))
  // the ask key (thimble's config `askKey`)
  const [ask, setAsk] = useState<AskKey>('meta')
  const mac = isMacPlatform()

  useEffect(() => {
    if (!open) return
    let alive = true
    setSettings(null)
    setError(null)
    Promise.all([loadSettings(ws, true), api.chat(ws, 'main').catch(() => null), api.extensions(ws).catch(() => null)])
      .then(([s, main, ex]) => {
        if (!alive) return
        setExts(ex)
        setExtOn(Object.fromEntries((ex?.extensions ?? []).map((e) => [e.name, e.on])))
        setViewOn(Object.fromEntries((ex?.extensions ?? []).flatMap((e) => (e.views ?? []).map((v) => [viewKey(e.name, v.slug), v.on]))))
        setLocalOn(Object.fromEntries((ex?.local?.views ?? []).map((v) => [v.slug, v.on])))
        setRunAnswers({})
        const a = main?.meta?.attached ?? null
        setSettings(s)
        setModeRows(s.permission_modes ?? {})
        setWeb(webRows(s))
        setPropose(s.propose_views !== false)
        setFeatures(featureRows(s))
        setAsk(s.ask_key === 'alt' ? 'alt' : 'meta')
        setAttached(a)
        const fast = mainFast(a)
        setModels({ ...(s.models ?? {}), main: { model: a?.model ?? '', effort: mainEffort(a) ?? '', fast: !!fast } })
      })
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [ws, open])

  const mainState = { attached: !!attached }
  const set = (role: string, patch: Partial<ModelConf>) => setModels((m) => ({ ...m, [role]: { ...(m[role] ?? EMPTY), ...patch } }))
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const changed = changedRoles(settings?.models ?? {}, models)
      const modes = changedModes(settings?.permission_modes, modeRows)
      const webs = changedWeb(webRows(settings), web)
      const proposeNow = changedPropose(settings, propose)
      const askNow = changedAskKey(settings, ask)
      const featuresNow = changedFeatures(settings, features)
      const anyFeature = Object.keys(featuresNow).length > 0
      if (Object.keys(changed).length || Object.keys(modes).length || Object.keys(webs).length || 'propose_views' in proposeNow || 'ask_key' in askNow || anyFeature)
        await api.putSettings(ws, {
          ...(Object.keys(changed).length ? { models: changed } : {}),
          ...(Object.keys(modes).length ? { permission_modes: modes } : {}),
          ...(Object.keys(webs).length ? { web: webs } : {}),
          ...proposeNow,
          ...askNow,
          ...(anyFeature ? { features: featuresNow } : {}),
        })
      // the pointer, the canvas, the tour and the views' frames take the key at once
      if ('ask_key' in askNow) setAskKey(ask)
      for (const [name, how] of extensionCalls(exts?.extensions ?? [], extOn)) {
        if (how === 'add') await api.addExtension(ws, name)
        else await api.switchExtension(ws, name, how === 'on')
      }
      for (const [name, slug, on] of changedViews(exts?.extensions ?? [], viewOn)) await api.switchExtensionView(ws, name, slug, on)
      for (const [slug, on] of changedLocalViews(exts?.local?.views ?? [], localOn)) await api.switchLocalView(ws, slug, on)
      const was = { effort: mainEffort(attached) ?? '', fast: !!mainFast(attached) }
      const main = models.main
      const effortNow = !!main && !!attached && main.effort !== was.effort
      const fastNow = !!main && !!attached && !!main.fast !== was.fast
      if (effortNow) await api.setEffort(ws, main.effort as MainEffort)
      if (fastNow) await api.setFast(ws, !!main.fast)
      if (effortNow || fastNow) bus.emit('toast', { text: `Main's effort and fast mode: ${NEXT_LAUNCH}.`, kind: 'info' })
      // last, so an orientation that cannot be sent the instructions leaves the other settings saved
      for (const [name, run] of exts ? answeredRuns(exts, extOn, runAnswers) : []) {
        const { status } = await api.answerExtensionOrientation(ws, name, run)
        if (status === 'rerun') bus.emit('toast', { text: `${name} is running the orientation again.`, kind: 'info' })
        if (status === 'resumed' || status === 'sent') bus.emit('toast', { text: `The orientation is running ${name}'s instructions.`, kind: 'info' })
        if (status === 'held' || status === 'queued') bus.emit('toast', { text: `${name}'s instructions go to the orientation when its coverage check ends.`, kind: 'info' })
      }
      invalidateSettings(ws)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // this browser's id, known once GET /ui/paired answered; a page without one (a screenshot's) has no sign-out
  const me = ownBrowserId()
  const signOut = async () => {
    try {
      await api.signOut(me, ws)
    } catch (e) {
      setError(`Could not sign this browser out. ${(e as Error).message}`)
      return
    }
    onClose()
    // the key is spent: every tab asks again and shows the sign-in line (shell/SignIn)
    clearBrowserKey()
    bus.emit('signedOut', {})
  }
  const roles = rolesOf(settings)
  const off = settings?.disabled_modes ?? []
  const own = permissionChoice(attached?.permission_mode)
  const fence = settings?.agents?.main
  const ignored = settings?.config_ignored ?? []
  const modelMenu = (role: string, conf: ModelConf, model: string): MenuItem[] => {
    const followed = conf.follows ? models[conf.follows]?.model : undefined
    return [
      ...(role === 'subagents' ? [{ id: 'm:', label: SAME_AS_ORIENT, note: followed ? modelLabel(followed) : undefined, checked: !!conf.follows, onSelect: () => set(role, { model: '', follows: 'orient' }) }] : []),
      ...modelChoices({ models }, model).map((m) => ({
        id: `m:${m}`,
        label: modelLabel(m),
        note: m,
        checked: !conf.follows && !conf.off && sameModel(m, conf.model),
        onSelect: () =>
          (conf.follows || conf.off || !sameModel(m, conf.model)) &&
          set(role, { model: m, follows: undefined, ...(role === 'refusal' ? { off: false } : {}), ...(hasEffort(m) ? (conf.effort ? {} : { effort: 'high' }) : { effort: '' }) }),
      })),
      { id: 'sep', separator: true as const },
      { id: 'other', label: 'Other', icon: 'edit' as const, onSelect: () => setTyping(role) },
      ...(role === 'refusal' ? [{ id: 'off', label: REFUSAL_OFF, checked: !!conf.off, onSelect: () => set(role, { off: true }) }] : []),
    ]
  }
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" role="dialog" label="Settings" className="settings-pop">
      <div className="settings" data-panel="settings">
        <h2 className="settings-title">Settings</h2>
        {!settings && !error && (
          <div className="settings-loading dim">
            <Spinner size={10} label="Loading settings" />
          </div>
        )}
        {settings && (
          <div className="settings-grid settings-models" role="table" aria-label="Models">
            <div className="settings-row settings-headrow" role="row">
              <span className="label">role</span>
              <span className="label">model</span>
              <span className="label">effort</span>
              <span className="label" title={WEB_HEAD_TIP}>web</span>
            </div>
            {roles.map((role) => {
              const conf = models[role] ?? EMPTY
              const why = (cell: 'model' | 'effort' | 'fast') => lockedWhy(role, cell, conf, mainState)
              const model = shownModel(role, models)
              const agent = (AGENT_ROLES as readonly string[]).includes(role)
              const classifier = (CLASSIFIER_ROLES as readonly string[]).includes(role)
              const refusal = role === 'refusal'
              const offRow = refusal && !!conf.off
              const effortShown = model && !hasEffort(model) ? '' : conf.effort
              return (
                <div className={`settings-row${ROLE_NOTE[role] ? ' settings-row-noted' : ''}${offRow ? ' settings-row-off' : ''}`} role="row" key={role} data-role={role} data-kind={agent ? 'agent' : classifier ? 'classifier' : role}>
                  <span className="settings-role">{roleLabel(role)}</span>
                  {why('model') ? (
                    <LockedChip why={why('model')!} label={`${role} model`}>
                      {role === 'main' && !attached ? 'no session' : model ? modelLabel(model) : 'not known yet'}
                    </LockedChip>
                  ) : typing === role ? (
                    <TextInput
                      bare
                      mono
                      block
                      autoFocus
                      className="settings-model"
                      value={conf.model}
                      onChange={(v) => set(role, { model: v, follows: undefined })}
                      aria-label={`${role} model`}
                      spellCheck={false}
                      onBlur={() => setTyping(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          e.preventDefault()
                          setTyping(null)
                        }
                      }}
                    />
                  ) : (
                    <Menu
                      label={`${role} model`}
                      items={modelMenu(role, conf, model)}
                      trigger={
                        <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-model" aria-label={`${role} model`} data-model={model} data-follows={conf.follows}>
                          {conf.follows ? SAME_AS_ORIENT : offRow ? REFUSAL_OFF : modelLabel(model)}
                        </Chip>
                      }
                    />
                  )}
                  <span className="settings-effort-cell">
                    {why('effort') ? (
                      <LockedChip why={why('effort')!} label={`${role} effort`}>
                        {effortShown ? effortWord(effortShown) : 'none'}
                      </LockedChip>
                    ) : (
                      <Menu
                        label={`${role} effort`}
                        items={roleEfforts(role).map((ef) => ({ id: ef || 'default', label: effortWord(ef), checked: ef === conf.effort, onSelect: () => set(role, { effort: ef }) }))}
                        trigger={
                          <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-effort" aria-label={`${role} effort`} data-effort={conf.effort}>
                            {effortWord(conf.effort)}
                          </Chip>
                        }
                      />
                    )}
                    {role === 'main' && (
                      <FastBolt on={!!conf.fast && (!conf.model || hasFastMode(conf.model))} why={why('fast')} label={`${role} fast mode`} onChange={(fast) => set(role, { fast })} className={`settings-fast${why('fast') ? ' settings-locked' : ''}`} />
                    )}
                  </span>
                  {(WEB_ROWS as readonly string[]).includes(role) ? (
                    <WebSwitch role={role} on={web[role as WebRow] ?? true} onChange={(on) => setWeb((w) => ({ ...w, [role]: on }))} />
                  ) : role === 'orient' || role === 'subagents' ? (
                    <WebSwitch role={role} on={fence?.web !== 'off'} why={`The orientation and its subagents follow your session's web rule (${fence?.config ?? 'agents.orientation'}.web in thimble's config).`} />
                  ) : role === 'dev' ? (
                    <WebSwitch role={role} on={settings.agents?.dev?.web !== 'off'} why={DEV_WEB_WHY} />
                  ) : (
                    <span />
                  )}
                  {ROLE_NOTE[role] && <span className="settings-role-note">{ROLE_NOTE[role]}</span>}
                </div>
              )
            })}
            <p className="settings-agent-main settings-next-start" role="note">
              {NEXT_START_LINE}
            </p>
          </div>
        )}
        {settings && (
          <div className="settings-grid settings-modes settings-auto settings-features" role="table" aria-label="Features">
            <div className="settings-row settings-headrow" role="row">
              <span className="label">features</span>
            </div>
            {FEATURE_ROWS.map(({ key, label, note }, i) => (
              <Fragment key={key}>
                {i === 0 && (
                  <div className="settings-row" role="row" data-auto="propose-views">
                    <span className="settings-role">{PROPOSE_LABEL}</span>
                    <span className="settings-web" data-on={propose}>
                      <Switch checked={propose} onChange={() => setPropose(!propose)} aria-label={PROPOSE_LABEL} />
                    </span>
                    <span className="settings-agent-line">{PROPOSE_NOTE}</span>
                  </div>
                )}
                <div className="settings-row" role="row" data-feature={key}>
                  <span className="settings-role">{label}</span>
                  <span className="settings-web" data-on={features[key]}>
                    <Switch checked={features[key]} onChange={() => setFeatures((f) => ({ ...f, [key]: !f[key] }))} aria-label={label} />
                  </span>
                  <span className="settings-agent-line">{note}</span>
                </div>
              </Fragment>
            ))}
          </div>
        )}
        {settings && (
          <div className="settings-grid settings-modes settings-auto" role="table" aria-label={ASK_KEY_LABEL}>
            <div className="settings-row settings-headrow" role="row">
              <span className="label">pointer</span>
            </div>
            <div className="settings-row" role="row" data-auto="ask-key" data-key={ask}>
              <span className="settings-role">{ASK_KEY_LABEL}</span>
              <Segmented className="settings-ask-key" size="sm" track label={ASK_KEY_LABEL} options={askKeyOptions(mac)} value={ask} onChange={setAsk} />
              <span className="settings-agent-line">{askKeyNote(mac, ask)}</span>
            </div>
          </div>
        )}
        {settings && fence && (
          <div className="settings-grid settings-modes settings-fence" role="table" aria-label="thimble's rules">
            <div className="settings-row settings-headrow" role="row">
              <span className="label">thimble's rules</span>
              <span className="label">what it lets agents do</span>
            </div>
            <div className="settings-row" role="row" data-fence="main">
              <span className="settings-role">Main and its agents</span>
              <FenceLine fence={fence} sandbox={attached?.sandbox} />
              <span className="settings-agent-line settings-fence-note">Your Claude Code session and thimble's agents, its subagents.</span>
            </div>
            {(['orient', 'critic', 'writer', 'checks'] as const).map((agent) => {
              const row = settings.agents?.[agent]
              return row ? (
                <div className="settings-row" role="row" key={agent} data-memory-agent={agent}>
                  <span className="settings-role">{roleLabel(agent)}</span>
                  <span className="settings-agent-line">{[runsWords(row), memoryWords((row as AgentRow & { memory?: string }).memory)].join(' · ')}</span>
                </div>
              ) : null
            })}
          </div>
        )}
        {settings && (
          <div className="settings-grid settings-modes" role="table" aria-label="Permission modes">
            <div className="settings-row settings-headrow" role="row">
              <span className="label">agent</span>
              <span className="label">permission mode</span>
            </div>
            {MODE_ROWS.filter(({ agent }) => modeRowShown(settings.agents?.[agent])).map(({ agent, label }) => {
              const picked = modeRows?.[agent]
              const mode = agentMode(modeRows, agent, attached?.permission_mode, off)
              const pick = (m: OrientPermissions | undefined) => setModeRows((r) => ({ ...r, [agent]: m }))
              const items: MenuItem[] = [
                { id: 'session', label: "Your session's", note: MODE_NAME[off.includes(own) ? 'manual' : own], checked: !picked, onSelect: () => pick(undefined) },
                ...MODE_OPTIONS.filter((o) => !off.includes(o.value)).map((o) => ({ id: o.value, label: o.label, checked: picked === o.value, onSelect: () => pick(o.value) })),
              ]
              const row = settings.agents?.[agent]
              return (
                <div className="settings-row" role="row" key={agent} data-mode-agent={agent}>
                  <span className="settings-role">{label}</span>
                  <span className="settings-mode-cell">
                    <Menu
                      label={`${label} permission mode`}
                      items={items}
                      trigger={
                        <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-mode" aria-label={`${label} permission mode`} data-mode={mode} data-picked={picked && picked !== 'bypass' ? picked : undefined}>
                          {picked && picked !== 'bypass' ? MODE_NAME[mode] : `${MODE_NAME[mode]} (your session's)`}
                        </Chip>
                      }
                    />
                  </span>
                  {row && <AgentLine row={row} />}
                </div>
              )
            })}
            {CALL_ROWS.map(({ agent, label, runs }) => {
              const row = settings.agents?.[agent]
              return row ? (
                <div className="settings-row" role="row" key={agent} data-call-agent={agent}>
                  <span className="settings-role">{label}</span>
                  <CallCell label={label} runs={runs} />
                  <AgentLine row={row} />
                </div>
              ) : null
            })}
            <p className="settings-agent-main settings-main-mode" role="note">
              {MAIN_MODE_LINE}
            </p>
            {settings.card_wait != null && (
              <p className="settings-agent-main settings-card-wait" role="note" title="cardWait in thimble's config">
                {cardWaitLine(settings.card_wait)}
              </p>
            )}
            {!!settings.agents?.main?.additions.length && (
              <p className="settings-agent-main" role="note">
                Main: your own session, with {settings.agents.main.additions.join(', ')}'s prompt from its next start
              </p>
            )}
            {!!tasksLine(settings.tasks) && (
              <p className="settings-agent-main settings-agent-tasks" role="note">
                Tasks: {tasksLine(settings.tasks)}
              </p>
            )}
            {ignored.length > 0 && (
              <p className="settings-agent-main settings-ignored" role="note">
                {`thimble's config holds settings this version ignores: ${ignored.join(', ')}. Saving here drops them.`}
              </p>
            )}
          </div>
        )}
        {settings && exts && (
          <ExtensionsSettings
            data={exts}
            on={extOn}
            setOn={(name, v) => setExtOn((cur) => ({ ...cur, [name]: v }))}
            viewOn={viewOn}
            setViewOn={(key, v) => setViewOn((cur) => ({ ...cur, [key]: v }))}
            localOn={localOn}
            setLocalOn={(slug, v) => setLocalOn((cur) => ({ ...cur, [slug]: v }))}
            answers={runAnswers}
            setAnswer={(name, run) => setRunAnswers((cur) => ({ ...cur, [name]: run }))}
          />
        )}
        {(error || settings?.config_error) && <div className="settings-error">{error || settings?.config_error}</div>}
        <div className="settings-foot">
          <span className="settings-foot-start">
            {/* the product tour again, from its first step, in its frame on thimble's demo workspace (shell/TourHost) */}
            <Button
              variant="ghost"
              className="settings-tour"
              onClick={() => {
                onClose()
                window.setTimeout(() => bus.emit('tour', {}), 250)
              }}
            >
              Take the tour
            </Button>
            {me && (
              <Button variant="ghost" className="settings-signout" onClick={() => void signOut()}>
                Sign out this browser
              </Button>
            )}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()} disabled={!settings}>
            Save
          </Button>
        </div>
      </div>
    </Popover>
  )
}
