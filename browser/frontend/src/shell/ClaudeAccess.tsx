// How the workbench reaches Claude (backend claude_access.py): the person's Claude Code sign-in (the default, and
// recommended), an Anthropic API key, or Workload Identity Federation, each in the few words of the install's question
// (the backend's labels and hints). The setup step opens by itself while no way is chosen (the first run, when the
// install did not ask), and again from a chat's card that says Claude cannot be reached (bus `claudeAccess`). Not now
// (or Escape) closes it, so the person can still browse without access; it opens by itself again on the next start
// while nothing is saved. Choosing the Claude Code sign-in, whose
// words say what it does, is the person's consent to it. The API key is ANTHROPIC_API_KEY when it is set where the
// workbench runs, else one pasted here. Saving checks the choice with one small call and says what failed in plain
// words. The first run's step stands alone: the tour's welcome (TourHost) waits until it is answered (accessAnswered).
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { TextInput } from '../components/Field'
import { api, type ClaudeAccess, type ClaudeAccessCheck } from '../lib/api'
import { bus } from '../lib/bus'

type How = 'api-key' | 'claude-code' | 'wif'

/** In the order and the words of the install's question (backend claude_access.py LABELS and HINTS, which the status
 * gives); the first is the default. */
const CHOICES: { how: How; label: string; hint: string; mark?: string }[] = [
  { how: 'claude-code', label: 'Your Claude Code sign-in', hint: 'It runs Claude Code in the background, on your Claude plan.', mark: 'recommended' },
  { how: 'api-key', label: 'An Anthropic API key', hint: 'ANTHROPIC_API_KEY when it is set, or a key you paste here.' },
  { how: 'wif', label: 'Workload Identity Federation', hint: 'The path of your WIF config file.' },
]

let answer: () => void = () => undefined
const answered = new Promise<void>((resolve) => (answer = resolve))

/** Settles once the first run's step is answered (saved, Not now or Escape), or once the status says a way is chosen
 * or cannot be read. */
export const accessAnswered = (): Promise<void> => answered

/** The dialog, mounted once in the shell; it opens on bus `claudeAccess`, or by itself while no way is chosen. */
export function ClaudeAccessHost() {
  const [open, setOpen] = useState(false)
  const [first, setFirst] = useState(false)
  useEffect(() => {
    let alive = true
    api
      .claudeAccess()
      .then((s) => {
        if (s.how) answer()
        else if (alive) {
          setFirst(true)
          setOpen(true)
        }
      })
      .catch(() => answer())
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
  return (
    <ClaudeAccessDialog
      first={first}
      onClose={() => {
        setOpen(false)
        answer()
      }}
    />
  )
}

export function ClaudeAccessDialog({ first, onClose }: { first: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<ClaudeAccess | null>(null)
  const [how, setHow] = useState<How>(CHOICES[0].how)
  const [key, setKey] = useState('')
  const [file, setFile] = useState('')
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
      const got = await api.setClaudeAccess({ how, key: how === 'api-key' && key ? key : undefined, wif_file: how === 'wif' ? file : undefined, consent: how === 'claude-code' })
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
  // with ANTHROPIC_API_KEY set where the workbench runs, the API key needs nothing pasted
  const ready = how === 'api-key' ? !!key || !!status?.key_saved || !!status?.env_key : how === 'wif' ? !!file.trim() : true
  return (
    <div className="access-scrim" role="presentation">
      <div className="access" role="dialog" aria-modal="true" aria-label="How the workbench reaches Claude">
        <h2 className="access-title">How should the workbench reach Claude?</h2>
        <div className="access-choices" role="radiogroup">
          {CHOICES.map((c) => (
            <label key={c.how} className={`access-choice${how === c.how ? ' on' : ''}`} data-how={c.how}>
              <input type="radio" name="access-how" checked={how === c.how} onChange={() => setHow(c.how)} />
              <span className="access-choice-label">
                {status?.labels?.[c.how] ?? c.label}
                {c.mark && <span className="access-choice-mark"> ({c.mark})</span>}
              </span>
              <span className="access-choice-hint">{c.hint}</span>
            </label>
          ))}
        </div>
        {how === 'api-key' && status?.env_key && <p className="access-hint">ANTHROPIC_API_KEY is set where the workbench runs, so it uses that key.</p>}
        {how === 'api-key' && !status?.env_key && (
          <div className="access-field">
            <TextInput block mono type="password" value={key} onChange={setKey} placeholder={status?.key_saved ? 'A key is saved' : 'sk-ant-…'} aria-label="Anthropic API key" autoComplete="off" spellCheck={false} />
          </div>
        )}
        {how === 'wif' && (
          <div className="access-field">
            <TextInput block mono value={file} onChange={setFile} placeholder="/path/to/wif-config.toml" aria-label="Workload Identity Federation config file" spellCheck={false} />
          </div>
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
            Save and check
          </Button>
        </div>
      </div>
    </div>
  )
}
