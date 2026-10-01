// The settings gear's popover: a table with a row per role that runs a model (model, effort, fast mode), and one per
// agent of the extensions running here (`<extension>:<agent>`, model and effort, at the orientation's speed), saved with
// Save. main's model is read-only (only /model in the terminal changes it); its effort and fast mode are kept for its
// next launch through PUT session/effort and session/fast. Other roles are thimble's config (backend userconf.py),
// resolved with defaults by GET /settings, which also names the config's error; a save
// sends only the changed fields so defaults stay defaults, and applies to the next session or subagent. Choices that
// cannot take effect are dimmed with the reason in a tooltip. Every row names its model exactly, never `default`. Under
// the table, the permission mode of each agent thimble starts (MODE_ROWS): the analyst's pick, else the mode of their
// Claude Code session, as main's hooks report it (backend modes.py). Then the extensions added to thimble, each with its
// switch for this workspace (ExtensionsSettings).
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { TextInput } from '../components/Field'
import { Menu, type MenuItem } from '../components/Menu'
import { Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { useTooltip } from '../components/Tooltip'
import { api } from '../lib/api'
import { ExtensionsSettings, answeredRuns, changedExtensions, changedLocalViews, changedViews, viewKey } from './ExtensionsSettings'
import { hasFastMode, invalidateSettings, loadSettings, modelChoices, modelLabel, sameModel } from '../lib/models'
import { EFFORTS, ROLES, type Attached, type Extensions, type MainEffort, type ModeAgent, type ModelConf, type OrientPermissions, type Settings } from '../lib/types'
import { bus } from '../lib/bus'
import { EFFORT_CHOICES, FastBolt, MODEL_TIP, NEXT_LAUNCH, effortWord, mainEffort, mainFast, noFastTip } from '../chat/ModelLine'
import { BYPASS_LINE } from '../chat/ModeSwitch'
import { PERMISSION_OPTIONS, agentMode, permissionChoice } from '../chat/StartGate'

type Models = Record<string, ModelConf>

/** The agents whose permission modes the settings list, by their names there (backend modes.AGENTS). */
export const MODE_ROWS: { agent: ModeAgent; label: string }[] = [
  { agent: 'orient', label: 'Orientation' },
  { agent: 'writer', label: 'Writers' },
  { agent: 'critic', label: 'Critic' },
  { agent: 'checks', label: 'Checks' },
  { agent: 'dev', label: 'Dev agent' },
]
const MODE_NAME: Record<OrientPermissions, string> = { manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }

type Rows = Settings['permission_modes']

/** What a save sends for the permission modes: each agent whose pick differs from the loaded one, null for one put
 * back on the session's mode. Pure. */
export function changedModes(loaded: Rows, now: Rows): Partial<Record<ModeAgent, OrientPermissions | null>> {
  const out: Partial<Record<ModeAgent, OrientPermissions | null>> = {}
  for (const { agent } of MODE_ROWS) if ((loaded?.[agent] ?? null) !== (now?.[agent] ?? null)) out[agent] = now?.[agent] ?? null
  return out
}

/** The roles in the table: main, the known ones in their order, then any other the settings name. */
export const rolesOf = (s: Settings | null): string[] => {
  const known = Object.keys(s?.models ?? {})
  return [...ROLES, ...known.filter((r) => !(ROLES as readonly string[]).includes(r))]
}

/** A role's name in the table where its id alone would not say what it is. */
export const ROLE_LABEL: Record<string, string> = { subagents: 'orientation subagents' }
/** An extension's agent, whose row is keyed `<extension>:<agent>` as thimble's config keys it. */
const isExtensionAgent = (role: string): boolean => role.includes(':')
/** A row's name in the table: an extension's agent by its own name. Pure. */
export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? (isExtensionAgent(role) ? role.slice(role.indexOf(':') + 1) : role)
/** The orientation subagents' model while they follow the orientation's. */
export const SAME_AS_ORIENT = 'Same as orientation'
/** A subagent: its effort may be its session's (''). */
const SUBAGENT_ROLES = new Set(['subagents'])
/** The subagents that run at their session's effort and speed, and the role that session is. The card check (verify)
 * has a fast mode of its own. */
const SESSION_ROLE: Record<string, string> = { subagents: 'orient' }

/** The efforts a role's menu offers (backend config.role_efforts): the orientation's include ultracode, a subagent's its
 * session's (''). Pure. */
export function roleEfforts(role: string): string[] {
  if (role === 'main') return [...EFFORT_CHOICES]
  if (role === 'orient') return [...EFFORTS, 'ultracode']
  return SUBAGENT_ROLES.has(role) || isExtensionAgent(role) ? ['', ...EFFORTS] : [...EFFORTS]
}

/** Why a role's cell cannot be changed here, or null when it can. Pure. */
export function lockedWhy(role: string, cell: 'model' | 'effort' | 'fast', conf: ModelConf, main: { attached: boolean }): string | null {
  if (role === 'main') {
    if (cell === 'model') return MODEL_TIP
    return main.attached ? null : 'No Claude Code session is attached to main'
  }
  if (role === 'subagents' && cell !== 'model') return `Orientation subagents run at the orientation's ${cell === 'fast' ? 'speed' : 'effort'}`
  if (isExtensionAgent(role) && cell === 'fast') return "An extension's agent runs at the orientation's speed"
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
    if (Object.keys(patch).length) out[role] = patch
  }
  return out
}

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

export function SettingsPopover({ ws, anchor, open, onClose }: { ws: string; anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<Models>({})
  const [attached, setAttached] = useState<Attached | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the role whose model is being typed rather than picked
  const [typing, setTyping] = useState<string | null>(null)
  const [modeRows, setModeRows] = useState<Rows>({})
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
      if (Object.keys(changed).length || Object.keys(modes).length)
        await api.putSettings(ws, { ...(Object.keys(changed).length ? { models: changed } : {}), ...(Object.keys(modes).length ? { permission_modes: modes } : {}) })
      for (const [name, on] of Object.entries(changedExtensions(exts?.extensions ?? [], extOn))) await api.switchExtension(ws, name, on)
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
        if (status === 'resumed') bus.emit('toast', { text: `The orientation is running ${name}'s instructions.`, kind: 'info' })
        if (status === 'queued') bus.emit('toast', { text: `${name}'s instructions run when the orientation's run ends.`, kind: 'info' })
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
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" role="dialog" label="Settings" className="settings-pop">
      <div className="settings" data-panel="settings">
        {!settings && !error && (
          <div className="settings-loading dim">
            <Spinner size={10} label="Loading settings" />
          </div>
        )}
        {settings && (
          <div className="settings-grid" role="table">
            <div className="settings-row settings-headrow" role="row">
              <span className="label">role</span>
              <span className="label">model</span>
              <span className="label">effort</span>
              <span className="label">fast</span>
            </div>
            {roles.map((role) => {
              const conf = models[role] ?? EMPTY
              const why = (cell: 'model' | 'effort' | 'fast') => lockedWhy(role, cell, conf, mainState)
              const session = SESSION_ROLE[role] ? models[SESSION_ROLE[role]] : undefined
              const model = shownModel(role, models)
              const followed = conf.follows ? models[conf.follows]?.model : undefined
              const modelItems: MenuItem[] = [
                ...(role === 'subagents' ? [{ id: 'm:', label: SAME_AS_ORIENT, note: followed ? modelLabel(followed) : undefined, checked: !!conf.follows, onSelect: () => set(role, { model: '', follows: 'orient' }) }] : []),
                ...modelChoices({ models }, model).map((m) => ({ id: `m:${m}`, label: modelLabel(m), note: m, checked: !conf.follows && sameModel(m, conf.model), onSelect: () => (conf.follows || !sameModel(m, conf.model)) && set(role, { model: m, follows: undefined }) })),
                { id: 'sep', separator: true as const },
                { id: 'other', label: 'Other', icon: 'edit' as const, onSelect: () => setTyping(role) },
              ]
              const effort = session ? session.effort : conf.effort
              const fastOn = session ? !!session.fast : !!conf.fast && (!conf.model || hasFastMode(conf.model))
              return (
                <div className="settings-row" role="row" key={role} data-role={role}>
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
                      items={modelItems}
                      trigger={
                        <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-model" aria-label={`${role} model`} data-model={model} data-follows={conf.follows}>
                          {conf.follows ? SAME_AS_ORIENT : modelLabel(model)}
                        </Chip>
                      }
                    />
                  )}
                  {why('effort') ? (
                    <LockedChip why={why('effort')!} label={`${role} effort`}>
                      {effortWord(effort)}
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
                  <FastBolt on={fastOn} why={why('fast')} label={`${role} fast mode`} onChange={(fast) => set(role, { fast })} className={`settings-fast${why('fast') ? ' settings-locked' : ''}`} />
                </div>
              )
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
                ...PERMISSION_OPTIONS.filter((o) => !off.includes(o.value)).map((o) => ({ id: o.value, label: o.label, checked: picked === o.value, onSelect: () => pick(o.value) })),
              ]
              return (
                <div className="settings-row" role="row" key={agent} data-mode-agent={agent}>
                  <span className="settings-role">{label}</span>
                  <Menu
                    label={`${label} permission mode`}
                    items={items}
                    trigger={
                      <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-mode" aria-label={`${label} permission mode`} data-mode={mode} data-picked={picked ?? undefined}>
                        {picked ? MODE_NAME[mode] : `${MODE_NAME[mode]} (your session's)`}
                      </Chip>
                    }
                  />
                </div>
              )
            })}
            {MODE_ROWS.some(({ agent }) => agentMode(modeRows, agent, attached?.permission_mode, off) === 'bypass') && (
              <p className="settings-modes-warn" role="note">
                {BYPASS_LINE}
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
