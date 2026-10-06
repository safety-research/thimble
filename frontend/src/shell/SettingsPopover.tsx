// The settings gear's popover. First one table, a row per role with exactly the model and effort that runs: main, whose
// model is read-only (only /model in the terminal changes it) and whose effort and fast mode are kept for its next
// launch (PUT session/effort and session/fast); thimble's agents (the orientation, the orientation's subagents run as
// thimble:helper, the critic, the writers, the dev agent of view builds, reviews and code tickets, the report checks),
// with a "web" switch that keeps an agent off WebFetch and WebSearch; the classifiers (labels, the card check, the
// viewer suggestion), the only rows with fast mode; and the row a classifier's call runs again on when its model
// refuses, or off. Then one row per agent of the extensions running here (`<extension>:<agent>`). The effort menu lists
// Claude Code's levels, and a model that runs with no effort shows none. An agent's row applies to its next start. A
// save sends only the changed fields so defaults stay defaults (thimble's config, backend userconf.py). Choices that
// cannot take effect are dimmed with the reason in a tooltip. Every row names its model exactly, never `default`.
// Under the table, main's fence, which thimble's agents share as subagents of the analyst's Claude Code session (its
// sandbox, network, web and edits of the data), with the CLAUDE.md files each agent reads; then the one agent with a
// permission mode of its own, the code tickets' (with cardWait, how long its card waits), and its own fence; then labels
// and the card check, which have no mode; then the extensions added to thimble, each with its switch for this workspace
// (ExtensionsSettings).
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { TextInput } from '../components/Field'
import { Menu, type MenuItem } from '../components/Menu'
import { Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { Switch } from '../components/Switch'
import { useTooltip } from '../components/Tooltip'
import { api } from '../lib/api'
import { ExtensionsSettings, answeredRuns, changedLocalViews, changedViews, extensionCalls, viewKey } from './ExtensionsSettings'
import { hasEffort, hasFastMode, invalidateSettings, loadSettings, modelChoices, modelLabel, sameModel } from '../lib/models'
import { EFFORTS, ROLES, type AgentRow, type Attached, type CallAgent, type Extensions, type MainEffort, type MainFence, type ModeAgent, type ModelConf, type OrientPermissions, type Settings, type SettingsPatch, type TaskRow } from '../lib/types'
import { bus } from '../lib/bus'
import { EFFORT_CHOICES, FastBolt, MODEL_TIP, NEXT_LAUNCH, effortWord, mainEffort, mainFast, noFastTip } from '../chat/ModelLine'

type Models = Record<string, ModelConf>

/** The agents with a permission mode of their own: only the code tickets' (backend modes.AGENTS). */
export const MODE_ROWS: { agent: ModeAgent; label: string }[] = [{ agent: 'dev', label: 'Code tickets' }]
const MODE_NAME: Record<OrientPermissions, string> = { manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }
/** The code tickets' modes, by the names the menu shows. */
export const MODE_OPTIONS: { value: OrientPermissions; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypass', label: 'Bypass' },
]
/** The warning Claude Code shows before a session runs in Bypass Permissions mode, its first sentence. */
export const BYPASS_LINE = 'In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.'
/** The one line on the modes of every other agent. */
export const MAIN_MODE_LINE = "Every other agent of thimble's runs in your Claude Code session's permission mode."

/** A Claude Code permission mode (main's `attached.permission_mode`) as the code tickets' menu names it: Auto for auto,
 * Bypass for bypassPermissions, Manual for any other or none known (backend modes.OF_CLAUDE). Pure. */
export const permissionChoice = (mode: string | null | undefined): OrientPermissions =>
  mode === 'auto' ? 'auto' : mode === 'bypassPermissions' ? 'bypass' : 'manual'

/** The mode code tickets start in: their row, else the mode of the analyst's Claude Code session, else Manual, whichever
 * their Claude Code settings do not turn off (backend modes.mode_for). Pure. */
export function agentMode(rows: Settings['permission_modes'], agent: ModeAgent, sessionMode: string | null | undefined, off: readonly string[] = []): OrientPermissions {
  return [rows?.[agent], permissionChoice(sessionMode), 'manual' as const].find((m): m is OrientPermissions => !!m && !off.includes(m))!
}

/** The agents of thimble's config that are one model call each, listed after the code tickets; their settings reach an
 * extension's program that runs their tasks (backend userconf.CALLS). */
export const CALL_ROWS: { agent: CallAgent; label: string }[] = [
  { agent: 'labels', label: 'Labels' },
  { agent: 'cardCheck', label: 'Card check' },
]
/** What a CALL_ROWS row shows where the code tickets show their permission mode, and why. */
export const CALL_CELL = 'Asks nothing'
const CALL_CELL_TIP = "It has no permission mode. thimble runs it as one model call with no tools, and an extension's program that runs its tasks has no thread to ask you in."

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
  if (row.way === 'sdk') return `${row.extension}, Agent SDK`
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
    : row.way === 'sdk' ? `${row.extension} runs it with an Agent SDK program.`
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

/** Main's fence in words: its sandbox, network, web calls and edits of the data. Pure. */
export function fenceLine(f: MainFence | null | undefined): string {
  if (!f) return ''
  const box = f.sandbox === 'off' ? 'sandbox off' : f.sandbox_runs === false ? 'no sandbox here' : 'sandbox on'
  const web = f.web === 'off' ? 'no web' : f.web === 'allow' ? 'web allowed' : 'asks before the web'
  return [box, `network ${f.network ?? 'on'}`, web, DATA_WORDS[f.data ?? 'ask']].join(' · ')
}

/** What main's fence means, one sentence per line, for its tooltip. Pure. */
export function fenceTip(f: MainFence): string {
  const box = f.sandbox === 'off' ? 'Sandbox off: commands can write anywhere you can.'
    : f.sandbox_runs === false ? 'The sandbox cannot run on this machine.'
    : "Sandbox on: commands write only in thimble's work folders, never in the folder you opened."
  const net = f.network === 'off' ? 'Network off: commands reach no host.' : 'Network on: commands can reach the internet.'
  const web = f.web === 'off' ? 'Web off: no agent fetches pages or searches the web.' : f.web === 'allow' ? 'Web allowed: agents fetch pages and search without asking.' : 'Web: Claude Code asks you before an agent fetches a page or searches the web.'
  return [box, net, web, DATA_TIP[f.data ?? 'ask'], `Change these under ${f.config ?? 'agents.orientation'} in thimble's config.`].join('\n')
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

function FenceLine({ fence }: { fence: MainFence }) {
  const { props, tip } = useTooltip(fenceTip(fence), 'tip-lines', 'start')
  return (
    <>
      <span className="settings-agent-line settings-fence-line" tabIndex={0} {...props}>
        {fenceLine(fence)}
      </span>
      {tip}
    </>
  )
}

/** A CALL_ROWS row's cell where the code tickets have their permission mode. */
function CallCell({ label }: { label: string }) {
  const { props, tip } = useTooltip(CALL_CELL_TIP, 'tip-lines', 'start')
  return (
    <>
      <Chip kind="plain" face="sans" className="settings-cell settings-mode settings-mode-none" tabIndex={0} aria-label={`${label}: ${CALL_CELL}`} {...props}>
        {CALL_CELL}
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
  subagents: "for subagents the orientation starts as thimble:helper; others run on the orientation's own model and effort",
  dev: 'view builds, view reviews and code tickets',
  refusal: "if a classifier's model refuses: run again on this, or switch it off",
}
/** thimble's agents, whose rows apply to their next start. */
export const AGENT_ROLES = ['orient', 'subagents', 'critic', 'writer', 'dev', 'checks'] as const
/** The classifiers: one model call each, the only rows with fast mode. */
export const CLASSIFIER_ROLES = ['labels', 'verify', 'suggest'] as const
/** The agents whose web switch the table offers (backend userconf.SUBAGENT_ROLES less the orientation, whose web is
 * main's fence's). */
export const WEB_ROWS = ['critic', 'writer', 'checks'] as const
export type WebRow = (typeof WEB_ROWS)[number]
/** The line under the table. */
export const NEXT_START_LINE = "An agent's row applies to its next start; a run that goes on keeps its own model and effort."

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

/** Why a role's cell cannot be changed here, or null when it can. Fast mode is the classifiers' and main's alone; a
 * model with no effort has no effort to pick. Pure. */
export function lockedWhy(role: string, cell: 'model' | 'effort' | 'fast', conf: ModelConf, main: { attached: boolean }): string | null {
  if (role === 'main') {
    if (cell === 'model') return MODEL_TIP
    return main.attached ? null : 'No Claude Code session is attached to main'
  }
  if (cell === 'effort' && conf.model && !hasEffort(conf.model)) return `${modelLabel(conf.model)} runs with no effort`
  if (cell === 'fast' && !(CLASSIFIER_ROLES as readonly string[]).includes(role)) return "thimble's agents have no fast mode of their own"
  if (cell === 'fast' && conf.model && !hasFastMode(conf.model)) return noFastTip(conf.model)
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
    if (!was || !!was.fast !== !!conf.fast) patch.fast = !!conf.fast
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

/** An agent's web switch: on is the fence's rule, off keeps it off WebFetch and WebSearch (its disallowedTools). */
function WebSwitch({ role, on, onChange, why }: { role: string; on: boolean; onChange?: (on: boolean) => void; why?: string }) {
  const { props, tip } = useTooltip(why ?? (on ? `Web: your fence's rule. Switch it off to keep the ${roleLabel(role)} off the web.` : `Web off: the ${roleLabel(role)} never fetches a page or searches the web.`))
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
        setAttached(a)
        const fast = mainFast(a)
        setModels({ ...(s.models ?? {}), main: { model: a?.model ?? '', effort: mainEffort(a), fast: !!fast } })
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
      if (Object.keys(changed).length || Object.keys(modes).length || Object.keys(webs).length)
        await api.putSettings(ws, {
          ...(Object.keys(changed).length ? { models: changed } : {}),
          ...(Object.keys(modes).length ? { permission_modes: modes } : {}),
          ...(Object.keys(webs).length ? { web: webs } : {}),
        })
      for (const [name, how] of extensionCalls(exts?.extensions ?? [], extOn)) {
        if (how === 'add') await api.addExtension(ws, name)
        else await api.switchExtension(ws, name, how === 'on')
      }
      for (const [name, slug, on] of changedViews(exts?.extensions ?? [], viewOn)) await api.switchExtensionView(ws, name, slug, on)
      for (const [slug, on] of changedLocalViews(exts?.local?.views ?? [], localOn)) await api.switchLocalView(ws, slug, on)
      const was = { effort: mainEffort(attached), fast: !!mainFast(attached) }
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
        checked: !conf.follows && sameModel(m, conf.model),
        onSelect: () =>
          (conf.follows || !sameModel(m, conf.model)) &&
          set(role, { model: m, follows: undefined, ...(hasEffort(m) ? (conf.effort ? {} : { effort: 'high' }) : { effort: '' }), ...(hasFastMode(m) ? {} : { fast: false }) }),
      })),
      { id: 'sep', separator: true as const },
      { id: 'other', label: 'Other', icon: 'edit' as const, onSelect: () => setTyping(role) },
    ]
  }
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" role="dialog" label="Settings" className="settings-pop">
      <div className="settings" data-panel="settings">
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
              <span className="label">fast · web</span>
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
                          {conf.follows ? SAME_AS_ORIENT : modelLabel(model)}
                        </Chip>
                      }
                    />
                  )}
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
                  {role === 'main' || classifier ? (
                    <FastBolt on={!!conf.fast && (!conf.model || hasFastMode(conf.model))} why={why('fast')} label={`${role} fast mode`} onChange={(fast) => set(role, { fast })} className={`settings-fast${why('fast') ? ' settings-locked' : ''}`} />
                  ) : refusal ? (
                    <span className="settings-web" data-on={!conf.off}>
                      <Switch checked={!conf.off} onChange={() => set(role, { off: !conf.off })} aria-label="Run a refused classifier call again" />
                    </span>
                  ) : (WEB_ROWS as readonly string[]).includes(role) ? (
                    <WebSwitch role={role} on={web[role as WebRow] ?? true} onChange={(on) => setWeb((w) => ({ ...w, [role]: on }))} />
                  ) : role === 'orient' || role === 'subagents' ? (
                    <WebSwitch role={role} on={fence?.web !== 'off'} why={`The orientation and its subagents follow your fence's web rule (${fence?.config ?? 'agents.orientation'}.web in thimble's config).`} />
                  ) : role === 'dev' ? (
                    <WebSwitch role={role} on={settings.agents?.dev?.web !== 'off'} why="Code tickets keep a fence of their own (agents.dev.web in thimble's config); view builds and reviews follow yours." />
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
        {settings && fence && (
          <div className="settings-grid settings-modes settings-fence" role="table" aria-label="Fence">
            <div className="settings-row settings-headrow" role="row">
              <span className="label">fence</span>
              <span className="label">what it lets agents do</span>
            </div>
            <div className="settings-row" role="row" data-fence="main">
              <span className="settings-role">Main and its agents</span>
              <FenceLine fence={fence} />
              <span className="settings-agent-line settings-fence-note">Your Claude Code session's sandbox, which thimble's agents share as its subagents.</span>
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
            {MODE_ROWS.map(({ agent, label }) => {
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
                        <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-mode" aria-label={`${label} permission mode`} data-mode={mode} data-picked={picked ?? undefined}>
                          {picked ? MODE_NAME[mode] : `${MODE_NAME[mode]} (your session's)`}
                        </Chip>
                      }
                    />
                    {settings.card_wait != null && (
                      <span className="settings-card-wait" title="cardWait in thimble's config">
                        {`a request waits ${settings.card_wait} min`}
                      </span>
                    )}
                  </span>
                  {row && <AgentLine row={row} />}
                </div>
              )
            })}
            {CALL_ROWS.map(({ agent, label }) => {
              const row = settings.agents?.[agent]
              return row ? (
                <div className="settings-row" role="row" key={agent} data-call-agent={agent}>
                  <span className="settings-role">{label}</span>
                  <CallCell label={label} />
                  <AgentLine row={row} />
                </div>
              ) : null
            })}
            <p className="settings-agent-main settings-main-mode" role="note">
              {MAIN_MODE_LINE}
            </p>
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
            {MODE_ROWS.some(({ agent }) => agentMode(modeRows, agent, attached?.permission_mode, off) === 'bypass') && (
              <p className="settings-modes-warn" role="note">
                {BYPASS_LINE}
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
          {/* the product tour again, from its first step (shell/TourHost) */}
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
