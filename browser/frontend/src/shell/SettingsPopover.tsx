// The settings gear's popover: one flat list, every change applied at once; Escape or a click outside closes it. While
// thimble's config has an error the error comes first, its paths from the home folder as ~ (backend userconf.problem),
// and the config takes no write until the file is fixed, so Ask Claude with, View proposals and every Models row but
// main's are dimmed. Then Claude access, how the workbench reaches Claude, one choice for the install
// (shell/ClaudeAccess ClaudeAccessRow); "Claude can edit files in this folder", whether main and its thread forks may
// write the corpus folder of this workspace (the workspace's settings.json `corpus_edits`, on by default; thimble's
// other agents never write it); "Ask Claude with", the key held with a click to ask Claude about what the pointer is
// on, ⌘-click or ⌥-click (Ctrl-click or Alt-click off a Mac), whose other key places a card freely on the canvas
// (thimble's config `askKey`, lib/platform); View proposals, whether thimble proposes views after a turn and viewers
// for file types (thimble's config `views.propose`), which a view proposal's Don't ask again turns off too
// (chat/ProposalCard proposalsOff); then Models, open until the person folds it (kept in this browser,
// MODELS_OPEN_KEY), whose line then names the models and the efforts in use (modelsGist). Each Models row is an agent
// by its plain name (MODEL_ROWS) with its model menu (the current models, any other the settings name, then Other,
// which takes an id), its effort menu (none for a model that runs with none) and, while its model has fast mode, the
// fast-mode bolt (FAST_ROLES). Main and side threads hold main's session's model, effort and fast mode, the same ones
// as the composer's line under main's chat (chat/mainChoice), from main's next message; every other row is thimble's
// config (saveRole), from that agent's next start. The other settings are thimble's config file's (docs/config.md).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Segmented } from '../components/Button'
import { Chip } from '../components/Chip'
import { TextInput } from '../components/Field'
import { Icon } from '../components/Icon'
import { Menu, Popover, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { Switch } from '../components/Switch'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { hasEffort, hasFastMode, invalidateSettings, loadSettings, modelChoices, modelLabel, onSettingsChange, sameModel, saveRole } from '../lib/models'
import { askKeyLabel, isMacPlatform, setAskKey, type AskKey } from '../lib/platform'
import { track } from '../lib/telemetry'
import { EFFORTS, type Attached, type MainEffort, type ModelConf, type Settings } from '../lib/types'
import { readStorage, writeStorage } from '../lib/workspace'
import { chooseMain, type MainChoice } from '../chat/mainChoice'
import { EFFORT_CHOICES, FastBolt, effortWord, mainEffort, mainFast, mainModel } from '../chat/ModelLine'
import { ClaudeAccessRow } from './ClaudeAccess'

/** The switch that lets main and its thread forks write the corpus folder, per workspace (backend ledger.EDITS_KEY). */
export const EDITS_LABEL = 'Claude can edit files in this folder'
/** The ask key's choice (backend ledger.ASK_KEY): its name, and its options as the platform writes them (⌘-click and
 * ⌥-click on a Mac, Ctrl-click and Alt-click elsewhere). */
export const ASK_KEY_LABEL = 'Ask Claude with'
export const askKeyOptions = (mac: boolean): { value: AskKey; label: string }[] =>
  (['meta', 'alt'] as const).map((k) => ({ value: k, label: `${askKeyLabel(mac, k)}-click` }))
/** The switch of whether thimble proposes views (thimble's config `views.propose`, backend ledger.PROPOSE_KEY). */
export const PROPOSE_LABEL = 'View proposals'
export const MODELS_LABEL = 'Models'

/** The Models rows in order, each an agent by its plain name and the role whose model and effort it runs (backend
 * config.MODEL_ROLES): main and its side threads, which are forks of main and run on its model; the writer that Write
 * and Revise start; the dev agent of view builds, view reviews, code tickets and thimble fix; the checks (Heads up,
 * Explainers, Judgment calls and the analyst's own); the calls that read records for labels, label drafts and view fit;
 * the card check, which reads each card's picture; the view proposals after a turn and the viewers proposed for file
 * types. */
export const MODEL_ROWS: readonly { role: string; name: string }[] = [
  { role: 'main', name: 'Main and side threads' },
  { role: 'writer', name: 'Writer' },
  { role: 'dev', name: 'View builds and code tickets' },
  { role: 'checks', name: 'Comments' },
  { role: 'labels', name: 'Labels' },
  { role: 'verify', name: 'Card check' },
  { role: 'suggest', name: 'View proposals' },
]

/** The rows with a fast mode of their own: main's session (the composer's bolt), and the roles thimble's config keeps
 * one for (backend config.ROLES_WITH_FAST): the classifiers, and the dev row's, which its agents and `thimble fix`
 * run with, and which is main's until the person sets it here. The writer and the checks have none. */
export const FAST_ROLES: readonly string[] = ['main', 'dev', 'labels', 'verify', 'suggest']

/** Whether a row shows the fast-mode bolt: a row with fast mode, while its model has it. Pure. */
export const showsFast = (role: string, model: string): boolean => FAST_ROLES.includes(role) && hasFastMode(model)

/** The efforts a role's menu offers: Claude Code's levels for every agent and classifier; main's add ultracode, which
 * only main takes. Pure. */
export function roleEfforts(role: string): string[] {
  if (role === 'main') return [...EFFORT_CHOICES]
  return [...EFFORTS]
}

/** The Models line while folded: the models in use, each named once in the rows' order, then the range of the efforts
 * in use, lowest first ('Opus 5.5 · low to xhigh'); a row whose model runs with no effort counts no effort. Pure. */
export function modelsGist(rows: readonly { model: string; effort: string }[]): string {
  const models = [...new Set(rows.map((r) => r.model).filter(Boolean).map(modelLabel))]
  const at = rows.map((r) => (EFFORT_CHOICES as readonly string[]).indexOf(r.effort)).filter((i) => i >= 0)
  const lo = Math.min(...at)
  const hi = Math.max(...at)
  const efforts = at.length ? (lo === hi ? EFFORT_CHOICES[lo] : `${EFFORT_CHOICES[lo]} to ${EFFORT_CHOICES[hi]}`) : ''
  return [models.join(', '), efforts].filter(Boolean).join(' · ')
}

/** Whether the Models section is open in this browser: open until the person folds it. */
export const MODELS_OPEN_KEY = 'thimble:settings-models'

type Row = { role: string; name: string; model: string; effort: string; fast: boolean }

/** The field that takes a model's id in place of its menu (the menu's Other): Enter or leaving it picks what is typed,
 * Escape leaves the model as it was and keeps the menu open. */
function TypedModel({ label, onDone }: { label: string; onDone: (id: string) => void }) {
  const [text, setText] = useState('')
  const done = useRef(false)
  const finish = (id: string) => {
    if (done.current) return
    done.current = true
    onDone(id.trim())
  }
  return (
    <TextInput
      mono
      autoFocus
      className="settings-typed"
      value={text}
      onChange={setText}
      placeholder="model id"
      aria-label={label}
      spellCheck={false}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(text)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish('')
        }
      }}
    />
  )
}

export function SettingsPopover({ ws, anchor, open, onClose }: { ws: string; anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [attached, setAttached] = useState<Attached | null>(null)
  const [error, setError] = useState<string | null>(null)
  // what a pick shows until the server holds it, by `${role}.${field}`, `edits` or `ask`
  const [pending, setPending] = useState<Record<string, unknown>>({})
  const turns = useRef<Record<string, number>>({})
  // the row whose model is being typed rather than picked
  const [typing, setTyping] = useState<string | null>(null)
  const [modelsOpen, setModelsOpen] = useState(() => readStorage<boolean>(MODELS_OPEN_KEY, true) !== false)
  const mac = isMacPlatform()

  const refresh = useCallback(async () => {
    try {
      setSettings(await loadSettings(ws))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [ws])
  const readMain = useCallback(async (): Promise<Attached | null> => {
    const a = (await api.chat(ws, 'main').catch(() => null))?.meta?.attached ?? null
    setAttached(a)
    return a
  }, [ws])

  useEffect(() => {
    if (!open) return
    let alive = true
    setSettings(null)
    setError(null)
    setPending({})
    setTyping(null)
    Promise.all([loadSettings(ws, true), readMain()])
      .then(([s]) => alive && setSettings(s))
      .catch((e) => alive && setError((e as Error).message))
    // what another surface saves while the menu is open (a view build's line, a proposal's Don't ask again)
    const off = onSettingsChange((w) => w === ws && void refresh())
    return () => {
      alive = false
      off()
    }
  }, [ws, open, refresh, readMain])

  /** Show `value` for `key` at once and run `save`, which resolves true to keep showing it (main's choice while no
   * session is attached, whose meta cannot show it); otherwise the row shows what the server holds once `save` ends,
   * unless a later pick of the same key is under way. */
  const hold = (key: string, value: unknown, save: () => Promise<boolean>) => {
    const turn = (turns.current[key] = (turns.current[key] ?? 0) + 1)
    setPending((p) => ({ ...p, [key]: value }))
    void save().then((keep) => {
      if (turns.current[key] !== turn || keep) return
      setPending(({ [key]: _, ...rest }) => rest)
    })
  }
  const failed = (what: string) => (e: unknown) => bus.emit('toast', { text: `Could not change ${what}: ${(e as Error).message}`, kind: 'error' })
  /** A setting of thimble's or of the workspace's, saved at once; whoever shows the settings reads them again. */
  const put = (key: string, value: unknown, patch: Parameters<typeof api.putSettings>[1], what: string, then?: () => void) =>
    hold(key, value, async () => {
      await api
        .putSettings(ws, patch)
        .then(then)
        .catch(failed(what))
        .finally(() => invalidateSettings(ws))
      await refresh()
      return false
    })
  const pickRole = (role: string, patch: Partial<ModelConf>, what: string) => {
    const [field, value] = Object.entries(patch)[0]
    track('chat-settings', { target: `ui:settings-${role}`, detail: { role, ...patch } })
    hold(`${role}.${field}`, value, async () => {
      await saveRole(ws, role, patch).catch(failed(what))
      await refresh()
      return false
    })
  }
  const pickMain = (choice: MainChoice) => {
    const [field, value] = Object.entries(choice)[0]
    hold(`main.${field}`, value, async () => {
      const ok = await chooseMain(ws, choice, 'ui:settings-main')
      return ok && !(await readMain())
    })
  }
  const pickModel = (role: string, model: string) => (role === 'main' ? pickMain({ model }) : pickRole(role, { model }, 'the model'))
  const toggleModels = () => {
    setTyping(null)
    setModelsOpen(!modelsOpen)
    writeStorage(MODELS_OPEN_KEY, !modelsOpen)
  }

  const frozen = !!settings?.config_error
  const shown = <T,>(key: string, server: T): T => (key in pending ? (pending[key] as T) : server)
  const rows: Row[] = settings
    ? MODEL_ROWS.map(({ role, name }) => {
        const conf = settings.models?.[role]
        const server = role === 'main' ? { model: mainModel(attached), effort: mainEffort(attached), fast: mainFast(attached) } : { model: conf?.model ?? '', effort: conf?.effort ?? '', fast: !!conf?.fast }
        return { role, name, model: shown(`${role}.model`, server.model), effort: shown(`${role}.effort`, server.effort), fast: shown(`${role}.fast`, server.fast) }
      })
    : []
  const edits = shown('edits', settings?.corpus_edits !== false)
  const ask = shown<AskKey>('ask', settings?.ask_key === 'alt' ? 'alt' : 'meta')
  const propose = shown('propose', settings?.propose_views !== false)
  const problem = error || settings?.config_error || ''

  const modelItems = (row: Row): MenuItem[] => [
    ...modelChoices(settings, row.model).map((m) => ({
      id: `m:${m}`,
      label: modelLabel(m),
      checked: sameModel(m, row.model),
      onSelect: () => !sameModel(m, row.model) && pickModel(row.role, m),
    })),
    { id: 'sep', separator: true as const },
    { id: 'other', label: 'Other', onSelect: () => setTyping(row.role) },
  ]
  const effortItems = (row: Row): MenuItem[] =>
    roleEfforts(row.role).map((ef) => ({
      id: ef,
      label: effortWord(ef),
      checked: ef === row.effort,
      onSelect: () => ef !== row.effort && (row.role === 'main' ? pickMain({ effort: ef as MainEffort }) : pickRole(row.role, { effort: ef }, 'the effort')),
    }))

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" role="dialog" label="Settings" className="settings-pop">
      <div className="settings" data-panel="settings">
        {problem && (
          <div className="settings-error" role="alert">
            {problem}
          </div>
        )}
        <ClaudeAccessRow />
        {!settings && !error && (
          <div className="settings-loading dim">
            <Spinner size={10} label="Loading settings" />
          </div>
        )}
        {settings && (
          <>
            <div className="settings-line" data-setting="corpus-edits">
              <span className="settings-name">{EDITS_LABEL}</span>
              <Switch checked={edits} onChange={(on) => put('edits', on, { corpus_edits: on ? null : false }, 'whether Claude can edit files in this folder')} label={EDITS_LABEL} />
            </div>
            <div className="settings-line" data-setting="ask-key" data-key={ask} data-frozen={frozen || undefined}>
              <span className="settings-name">{ASK_KEY_LABEL}</span>
              <Segmented
                className="settings-ask-key"
                size="sm"
                track
                label={ASK_KEY_LABEL}
                options={askKeyOptions(mac).map((o) => ({ ...o, disabled: frozen }))}
                value={ask}
                onChange={(key) => put('ask', key, { ask_key: key === 'alt' ? 'alt' : null }, 'the ask key', () => setAskKey(key))}
              />
            </div>
            <div className="settings-line" data-setting="propose-views" data-frozen={frozen || undefined}>
              <span className="settings-name">{PROPOSE_LABEL}</span>
              <Switch
                checked={propose}
                disabled={frozen}
                onChange={(on) => {
                  track('chat-settings', { target: 'ui:propose-views', detail: { propose_views: on } })
                  put('propose', on, { propose_views: on ? null : false }, 'view proposals')
                }}
                label={PROPOSE_LABEL}
              />
            </div>
            <button type="button" className="settings-fold" aria-expanded={modelsOpen} aria-controls={modelsOpen ? 'settings-models' : undefined} onClick={toggleModels}>
              <span className="label">{MODELS_LABEL}</span>
              <span className="settings-gist">{modelsOpen ? '' : modelsGist(rows.map((r) => ({ model: r.model, effort: hasEffort(r.model) ? r.effort : '' })))}</span>
              <Icon name={modelsOpen ? 'chevron-up' : 'chevron-down'} size={14} className="settings-fold-chevron" />
            </button>
            {modelsOpen && (
              <div className="settings-models" id="settings-models" role="group" aria-label={MODELS_LABEL}>
                {rows.map((row) => {
                  const locked = frozen && row.role !== 'main'
                  const effortless = !!row.model && !hasEffort(row.model)
                  return (
                    <div className="settings-row" key={row.role} data-role={row.role} data-frozen={locked || undefined}>
                      <span className="settings-name">{row.name}</span>
                      <span className="settings-model-cell">
                        {typing === row.role ? (
                          <TypedModel
                            label={`Model for ${row.name}`}
                            onDone={(id) => {
                              setTyping(null)
                              if (id && !sameModel(id, row.model)) pickModel(row.role, id)
                            }}
                          />
                        ) : locked ? (
                          <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-model" aria-label={`Model for ${row.name}`} disabled>
                            {modelLabel(row.model)}
                          </Chip>
                        ) : (
                          <Menu
                            label={`Model for ${row.name}`}
                            items={modelItems(row)}
                            trigger={
                              <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-model" aria-label={`Model for ${row.name}`} data-model={row.model}>
                                {modelLabel(row.model)}
                              </Chip>
                            }
                          />
                        )}
                      </span>
                      {locked || effortless ? (
                        <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-effort" aria-label={`Effort for ${row.name}`} disabled>
                          {effortless ? 'none' : effortWord(row.effort)}
                        </Chip>
                      ) : (
                        <Menu
                          label={`Effort for ${row.name}`}
                          align="end"
                          items={effortItems(row)}
                          trigger={
                            <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-effort" aria-label={`Effort for ${row.name}`} data-effort={row.effort}>
                              {effortWord(row.effort)}
                            </Chip>
                          }
                        />
                      )}
                      {showsFast(row.role, row.model) ? (
                        <FastBolt
                          on={row.fast}
                          label={`Fast mode for ${row.name}`}
                          why={null}
                          onChange={locked ? undefined : (fast) => (row.role === 'main' ? pickMain({ fast }) : pickRole(row.role, { fast }, 'fast mode'))}
                          className="settings-fast"
                        />
                      ) : (
                        <span className="settings-fast" />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Popover>
  )
}
