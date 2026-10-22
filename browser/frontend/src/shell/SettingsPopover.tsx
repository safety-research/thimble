// The settings gear's popover: how thimble browser signs in to Claude and how Claude runs (backend settings_api.py).
// Sign in is Workload Identity Federation, configured in a file the analyst names (the page shows its path and where its
// identity token comes from, never its IDs), or an API key the analyst pastes in a password field; once saved, the key
// is never shown again, only that one is saved. Then the one model every agent
// runs on (the known ids, or another typed in), its effort, and thimble's features, each with its switch (features.ts:
// marks, cards, labels, report, views). A feature turned off takes its part of Claude's
// prompt, its tools and its surfaces on the page with it, and leaves the others as they are. Save sends only what
// changed; a choice applies from Claude's next request. Check asks the Models API once with the saved sign-in and says
// whether it works.
import { useEffect, useState } from 'react'
import { Button, Segmented } from '../components/Button'
import { Chip } from '../components/Chip'
import { TextInput } from '../components/Field'
import { Menu, Popover, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
import { Switch } from '../components/Switch'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { invalidateSettings, loadSettings, modelLabel, sameModel } from '../lib/models'
import { EFFORTS, type BrowserSettings, type Credentials } from '../lib/types'
import { loadFeatures } from '../features'

/** The two ways to sign in, as the switch names them. */
export const SOURCES: { value: 'wif' | 'key'; label: string }[] = [
  { value: 'wif', label: 'Workload Identity' },
  { value: 'key', label: 'API key' },
]
export const FEATURES_LABEL = 'Features'
export const APPLY_LINE = 'A change applies from Claude’s next request.'
/** What the key's row shows once a key is saved: never the key. */
export const KEY_SAVED = 'saved'

/** The form as the popover holds it. */
export interface SettingsForm {
  source: 'wif' | 'key'
  /** the Workload Identity Federation config file's path */
  file: string
  model: string
  effort: string
  /** each feature's switch, by name (features.ts) */
  features: Record<string, boolean>
}

/** The form for settings as the server answered them. Pure. */
export function formOf(s: BrowserSettings): SettingsForm {
  const c = s.credentials ?? {}
  return {
    source: c.source === 'key' ? 'key' : 'wif',
    file: c.file ?? '',
    model: s.model,
    effort: s.effort,
    features: Object.fromEntries((s.features ?? []).map((f) => [f.name, f.on])),
  }
}

/** What a save sends: each field that differs from what was loaded; credentials whole when either part changed. Pure. */
export function changedSettings(loaded: BrowserSettings, now: SettingsForm): Record<string, unknown> {
  const was = formOf(loaded)
  const out: Record<string, unknown> = {}
  const credsChanged = !loaded.credentials?.source || was.source !== now.source || (now.source === 'wif' && was.file !== now.file.trim())
  if (credsChanged) out.credentials = (now.source === 'wif' ? { source: 'wif', file: now.file.trim() } : { source: 'key' }) satisfies Credentials
  if (now.model.trim() && now.model.trim() !== was.model) out.model = now.model.trim()
  if (now.effort !== was.effort) out.effort = now.effort
  const features = Object.fromEntries(Object.entries(now.features).filter(([name, on]) => was.features[name] !== on))
  if (Object.keys(features).length) out.features = features
  return out
}

/** Why the form cannot be saved yet, or null. Pure. */
export function blockedWhy(s: BrowserSettings, form: SettingsForm, typedKey: string): string | null {
  if (form.source === 'key' && !s.has_api_key && !typedKey.trim()) return 'Paste an API key, or sign in with Workload Identity.'
  if (form.source === 'wif' && !form.file.trim()) return 'Name the Workload Identity Federation config file.'
  if (!/^claude-/.test(form.model.trim())) return 'The model is a Claude model id, such as claude-opus-5-5.'
  return null
}

export function SettingsPopover({ ws, anchor, open, onClose }: { ws: string; anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<BrowserSettings | null>(null)
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [key, setKey] = useState('')
  // a saved key is shown as saved until the analyst asks to paste another
  const [replacing, setReplacing] = useState(false)
  const [typing, setTyping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; message: string } | 'busy' | null>(null)

  const take = (s: BrowserSettings) => {
    setSettings(s)
    setForm(formOf(s))
  }
  useEffect(() => {
    if (!open) return
    let alive = true
    setSettings(null)
    setForm(null)
    setKey('')
    setReplacing(false)
    setTyping(false)
    setError(null)
    setCheck(null)
    loadSettings(ws, true)
      .then((s) => alive && take(s as BrowserSettings))
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [ws, open])

  const set = (patch: Partial<SettingsForm>) => setForm((f) => (f ? { ...f, ...patch } : f))
  const dirty = !!settings && !!form && (Object.keys(changedSettings(settings, form)).length > 0 || !!key.trim())
  const why = settings && form ? blockedWhy(settings, form, key) : null

  const save = async () => {
    if (!settings || !form) return
    setBusy(true)
    setError(null)
    try {
      if (form.source === 'key' && key.trim()) {
        await api.saveApiKey(ws, key.trim())
        setKey('')
        setReplacing(false)
      }
      const patch = changedSettings(settings, form)
      if (Object.keys(patch).length) await api.putSettings(ws, patch)
      invalidateSettings(ws)
      if (patch.features) void loadFeatures(ws)
      bus.emit('toast', { text: `Settings saved. ${APPLY_LINE}`, kind: 'info' })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const removeKey = async () => {
    setError(null)
    try {
      const s = (await api.removeApiKey(ws)) as BrowserSettings
      setSettings(s)
      setReplacing(true)
      invalidateSettings(ws)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const runCheck = async () => {
    setCheck('busy')
    try {
      setCheck(await api.checkSignIn(ws))
    } catch (e) {
      setCheck({ ok: false, message: (e as Error).message })
    }
  }

  const models = settings?.choices?.models ?? []
  const modelItems: MenuItem[] = form
    ? [
        ...[...new Set([form.model, ...models].filter(Boolean))].map((m) => ({ id: `m:${m}`, label: modelLabel(m), note: m, checked: sameModel(m, form.model), onSelect: () => set({ model: m }) })),
        { id: 'sep', separator: true as const },
        { id: 'other', label: 'Other', icon: 'edit' as const, onSelect: () => setTyping(true) },
      ]
    : []
  const showKeyField = !!settings && (!settings.has_api_key || replacing)

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" role="dialog" label="Settings" className="settings-pop">
      <div className="settings" data-panel="settings">
        {!settings && !error && (
          <div className="settings-loading dim">
            <Spinner size={10} label="Loading settings" />
          </div>
        )}
        {settings && form && (
          <div className="settings-grid settings-claude" role="table" aria-label="Claude">
            <div className="settings-row settings-headrow" role="row">
              <span className="label">Claude</span>
            </div>
            <div className="settings-row" role="row" data-setting="source">
              <span className="settings-role">Sign in</span>
              <Segmented className="settings-source" size="sm" track label="Sign in with" options={SOURCES} value={form.source} onChange={(v) => set({ source: v })} />
            </div>
            {form.source === 'wif' ? (
              <>
                <div className="settings-row" role="row" data-setting="wif">
                  <span className="settings-role">Config file</span>
                  <TextInput
                    bare
                    mono
                    block
                    autoComplete="off"
                    spellCheck={false}
                    className="settings-wif"
                    value={form.file}
                    onChange={(v) => set({ file: v })}
                    placeholder="/path/to/wif.toml"
                    aria-label="Workload Identity Federation config file"
                  />
                </div>
                {settings.wif && settings.wif.file === form.file.trim() && (
                  <div className="settings-row" role="row" data-setting="token">
                    <span className="settings-role">Token</span>
                    <span className={settings.wif.error ? 'settings-agent-line settings-check-failed' : 'settings-agent-line'}>{settings.wif.error ?? settings.wif.token}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="settings-row" role="row" data-setting="key">
                <span className="settings-role">API key</span>
                {showKeyField ? (
                  <TextInput
                    bare
                    mono
                    block
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="settings-key"
                    value={key}
                    onChange={setKey}
                    placeholder={settings.has_api_key ? 'Paste a new key' : 'Paste a key'}
                    aria-label="API key"
                  />
                ) : (
                  <span className="settings-key-saved">
                    <Chip kind="plain" face="sans" className="settings-cell" data-key="saved">
                      {KEY_SAVED}
                    </Chip>
                    <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
                      Replace
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void removeKey()}>
                      Remove
                    </Button>
                  </span>
                )}
              </div>
            )}
            <div className="settings-row" role="row" data-setting="model">
              <span className="settings-role">Model</span>
              {typing ? (
                <TextInput
                  bare
                  mono
                  block
                  autoFocus
                  className="settings-model"
                  value={form.model}
                  onChange={(v) => set({ model: v })}
                  aria-label="Model"
                  spellCheck={false}
                  onBlur={() => setTyping(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.preventDefault()
                      setTyping(false)
                    }
                  }}
                />
              ) : (
                <Menu
                  label="Model"
                  items={modelItems}
                  trigger={
                    <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-model" aria-label="Model" data-model={form.model}>
                      {modelLabel(form.model)}
                    </Chip>
                  }
                />
              )}
            </div>
            <div className="settings-row" role="row" data-setting="effort">
              <span className="settings-role">Effort</span>
              <Menu
                label="Effort"
                items={(settings.choices?.efforts ?? [...EFFORTS]).map((e) => ({ id: e, label: e, checked: e === form.effort, onSelect: () => set({ effort: e }) }))}
                trigger={
                  <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-cell settings-effort" aria-label="Effort" data-effort={form.effort}>
                    {form.effort}
                  </Chip>
                }
              />
            </div>
          </div>
        )}
        {settings && form && (settings.features ?? []).length > 0 && (
          <div className="settings-grid settings-modes settings-claude settings-features" role="table" aria-label={FEATURES_LABEL}>
            <div className="settings-row settings-headrow" role="row">
              <span className="label">features</span>
            </div>
            {(settings.features ?? []).map((f) => (
              <div key={f.name} className="settings-row" role="row" data-setting={`feature-${f.name}`}>
                <span className="settings-role">{f.title}</span>
                <span className="settings-web" data-on={form.features[f.name]}>
                  <Switch checked={!!form.features[f.name]} onChange={(on) => set({ features: { ...form.features, [f.name]: on } })} aria-label={f.title} />
                </span>
                <span className="settings-agent-line">{f.does}</span>
              </div>
            ))}
          </div>
        )}
        {settings && (
          <p className="settings-agent-main settings-signed-in" role="note">
            {check && check !== 'busy' ? <span className={check.ok ? 'settings-check-ok' : 'settings-check-failed'}>{check.message}</span> : <>Now signed in with {settings.signed_in}. {APPLY_LINE}</>}
          </p>
        )}
        {error && <div className="settings-error">{error}</div>}
        <div className="settings-foot">
          <Button variant="ghost" className="settings-report" onClick={() => {
              onClose()
              bus.emit('reportThis', { mode: 'report', text: '' })
            }}>
            Report a problem…
          </Button>
          <Button variant="ghost" className="settings-check" busy={check === 'busy'} disabled={!settings || dirty} title={dirty ? 'Save first: Check uses the saved sign-in' : 'Ask Claude’s API once with the saved sign-in'} onClick={() => void runCheck()}>
            Check sign-in
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()} disabled={!settings || !!why} title={why ?? undefined}>
            Save
          </Button>
        </div>
      </div>
    </Popover>
  )
}
