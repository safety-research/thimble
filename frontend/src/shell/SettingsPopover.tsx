// The settings gear's popover: a table with a row per role that runs a model (model, effort, fast mode), saved with
// Save. main's model is read-only (only /model in the terminal changes it); its effort and fast mode are set through
// PUT session/effort and session/fast. Other roles are settings.models, resolved with defaults by GET /settings; a save
// sends only the changed fields so defaults stay defaults, and applies to the next session or subagent. Choices that
// cannot take effect are dimmed with the reason in a tooltip. Every row names its model exactly, never `default`.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { TextInput } from '../components/Field'
import { Menu, type MenuItem } from '../components/Menu'
import { Popover } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { useTooltip } from '../components/Tooltip'
import { api } from '../lib/api'
import { hasFastMode, invalidateSettings, loadSettings, modelChoices, modelLabel, sameModel } from '../lib/models'
import { EFFORTS, ROLES, type Attached, type MainEffort, type ModelConf, type Settings } from '../lib/types'
import { EFFORT_CHOICES, FAST_TIP, FastBolt, MODEL_TIP, effortWord, mainEffort, mainFast, noFastTip } from '../chat/ModelLine'

type Models = Record<string, ModelConf>

/** The roles in the table: main, the known ones in their order, then any other the settings name. */
export const rolesOf = (s: Settings | null): string[] => {
  const known = Object.keys(s?.models ?? {})
  return [...ROLES, ...known.filter((r) => !(ROLES as readonly string[]).includes(r))]
}

/** A role's name in the table where its id alone would not say what it is. */
export const ROLE_LABEL: Record<string, string> = { subagents: 'orientation subagents' }
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
  return SUBAGENT_ROLES.has(role) ? ['', ...EFFORTS] : [...EFFORTS]
}

/** Why a role's cell cannot be changed here, or null when it can. Pure. */
export function lockedWhy(role: string, cell: 'model' | 'effort' | 'fast', conf: ModelConf, main: { attached: boolean; fastSwitch: boolean }): string | null {
  if (role === 'main') {
    if (cell === 'model') return MODEL_TIP
    if (!main.attached) return 'No Claude Code session is attached to main'
    return cell === 'fast' && !main.fastSwitch ? FAST_TIP : null
  }
  if (role === 'subagents' && cell !== 'model') return `Orientation subagents run at the orientation's ${cell === 'fast' ? 'speed' : 'effort'}`
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

  useEffect(() => {
    if (!open) return
    let alive = true
    setSettings(null)
    setError(null)
    Promise.all([loadSettings(ws, true), api.chat(ws, 'main').catch(() => null)])
      .then(([s, main]) => {
        if (!alive) return
        const a = main?.meta?.attached ?? null
        setSettings(s)
        setAttached(a)
        const fast = mainFast(a)
        setModels({ ...(s.models ?? {}), main: { model: a?.model ?? '', effort: mainEffort(a), fast: !!fast } })
      })
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [ws, open])

  const mainState = { attached: !!attached, fastSwitch: mainFast(attached) != null }
  const set = (role: string, patch: Partial<ModelConf>) => setModels((m) => ({ ...m, [role]: { ...(m[role] ?? EMPTY), ...patch } }))
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const changed = changedRoles(settings?.models ?? {}, models)
      if (Object.keys(changed).length) await api.putSettings(ws, { models: changed })
      const was = { effort: mainEffort(attached), fast: !!mainFast(attached) }
      const main = models.main
      if (main && attached && main.effort !== was.effort) await api.setEffort(ws, main.effort as MainEffort)
      if (main && attached && mainState.fastSwitch && !!main.fast !== was.fast) await api.setFast(ws, !!main.fast)
      invalidateSettings(ws)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const roles = rolesOf(settings)
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
                  <span className="settings-role">{ROLE_LABEL[role] ?? role}</span>
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
        {error && <div className="settings-error">{error}</div>}
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
