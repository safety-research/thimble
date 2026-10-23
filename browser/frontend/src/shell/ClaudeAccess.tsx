// How thimble reaches Claude (backend claude_access.py): an Anthropic API key (the default), the person's Claude Code
// sign-in, or Workload Identity Federation. The setup step opens by itself while no way is chosen (the first run, when
// install.sh's question was skipped), and again from Settings, from a chat's card that says Claude cannot be reached
// (bus `claudeAccess`), or from the line in Settings. Not now (or Escape) closes it, so the person can still browse
// without access; it opens by itself again on the next start while nothing is saved. Claude Code sign-in needs the
// person's yes to the consent text, since it launches headless Claude Code sessions in the background. Saving checks
// the choice with one small call and says what failed in plain words.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { TextInput } from '../components/Field'
import { api, type ClaudeAccess, type ClaudeAccessCheck } from '../lib/api'
import { bus } from '../lib/bus'

type How = 'api-key' | 'claude-code' | 'wif'

const CHOICES: { how: How; label: string; note: string }[] = [
  { how: 'api-key', label: 'Anthropic API key', note: 'thimble calls the Claude API itself.' },
  { how: 'claude-code', label: 'Claude Code sign-in', note: 'Uses your Claude subscription through Claude Code.' },
  { how: 'wif', label: 'Workload Identity Federation', note: 'thimble calls the Claude API with a config file you name.' },
]

/** The dialog, mounted once in the shell; it opens on bus `claudeAccess`, or by itself while no way is chosen. */
export function ClaudeAccessHost() {
  const [open, setOpen] = useState(false)
  const [first, setFirst] = useState(false)
  useEffect(() => {
    let alive = true
    api
      .claudeAccess()
      .then((s) => {
        if (alive && !s.how) {
          setFirst(true)
          setOpen(true)
        }
      })
      .catch(() => undefined)
    const off = bus.on('claudeAccess', () => {
      setFirst(false)
      setOpen(true)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  if (!open) return null
  return <ClaudeAccessDialog first={first} onClose={() => setOpen(false)} />
}

export function ClaudeAccessDialog({ first, onClose }: { first: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<ClaudeAccess | null>(null)
  const [how, setHow] = useState<How>('api-key')
  const [key, setKey] = useState('')
  const [file, setFile] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<ClaudeAccessCheck | null>(null)
  useEffect(() => {
    api
      .claudeAccess()
      .then((s) => {
        setStatus(s)
        if (s.how) setHow(s.how as How)
        setFile(s.wif_file || '')
      })
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const save = async () => {
    setBusy(true)
    setError(null)
    setCheck(null)
    try {
      const got = await api.setClaudeAccess({ how, key: how === 'api-key' && key ? key : undefined, wif_file: how === 'wif' ? file : undefined, consent: how === 'claude-code' && consent })
      setStatus(got)
      setKey('')
      setCheck(got.check)
      if (got.check.ok) onClose()
    } catch (e) {
      setError((e as Error).message.replace(/^\d+ /, ''))
    } finally {
      setBusy(false)
    }
  }
  const ready = how === 'api-key' ? !!key || !!status?.key_saved : how === 'wif' ? !!file.trim() : consent
  return (
    <div className="access-scrim" role="presentation">
      <div className="access" role="dialog" aria-modal="true" aria-label="How thimble reaches Claude">
        <h2 className="access-title">How should thimble reach Claude?</h2>
        <div className="access-choices" role="radiogroup">
          {CHOICES.map((c) => (
            <label key={c.how} className={`access-choice${how === c.how ? ' on' : ''}`} data-how={c.how}>
              <input type="radio" name="access-how" checked={how === c.how} onChange={() => setHow(c.how)} />
              <span className="access-choice-label">{c.label}</span>
              <span className="access-choice-note">{c.note}</span>
            </label>
          ))}
        </div>
        {how === 'api-key' && (
          <div className="access-field">
            <TextInput block mono type="password" value={key} onChange={setKey} placeholder={status?.key_saved ? 'A key is saved' : 'sk-ant-…'} aria-label="Anthropic API key" autoComplete="off" spellCheck={false} />
          </div>
        )}
        {how === 'wif' && (
          <div className="access-field">
            <TextInput block mono value={file} onChange={setFile} placeholder="/path/to/wif-config.toml" aria-label="Workload Identity Federation config file" spellCheck={false} />
          </div>
        )}
        {how === 'claude-code' && (
          <label className="access-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{status?.consent_text ?? 'This uses your Claude subscription through Claude Code and will launch headless Claude Code sessions in the background.'}</span>
          </label>
        )}
        {error && <p className="access-error" role="alert">{error}</p>}
        {check && !check.ok && (
          <p className="access-error" role="alert">
            {check.problem?.what} {check.problem?.fix}
          </p>
        )}
        <div className="access-foot">
          <Button variant="ghost" onClick={onClose}>
            {check && !check.ok ? 'Close' : first ? 'Not now' : 'Cancel'}
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={save}>
            {how === 'claude-code' ? 'Confirm and check' : 'Save and check'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Settings' line: the way chosen in words, and Change. */
export function ClaudeAccessLine() {
  const [status, setStatus] = useState<ClaudeAccess | null>(null)
  useEffect(() => {
    api.claudeAccess().then(setStatus).catch(() => undefined)
  }, [])
  return (
    <div className="settings-access" data-how={status?.how || 'none'}>
      <span className="settings-access-label">Claude access</span>
      <span className="settings-access-what">{status ? status.describe : '…'}</span>
      <Button variant="secondary" size="sm" onClick={() => bus.emit('claudeAccess', {})}>
        Change
      </Button>
    </div>
  )
}
