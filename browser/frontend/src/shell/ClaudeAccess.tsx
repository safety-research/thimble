// How the workbench reaches Claude (backend claude_access.py): the person's Claude Code sign-in (the default, and
// recommended), an Anthropic API key, or Workload Identity Federation, each in the few words of the install's question
// (the backend's labels and hints). The setup step opens by itself while no way is chosen (the first run, when the
// install did not ask), and again from a chat's card that says Claude cannot be reached (bus `claudeAccess`). Not now
// (or Escape) closes it, so the person can still browse without access; it opens by itself again on the next start
// while nothing is saved. Choosing the Claude Code sign-in, whose words say what it does, is the person's consent to it.
// The API key is ANTHROPIC_API_KEY when it is set where the workbench runs, else one pasted here. Saving checks the
// choice with one small call and says what failed in plain words. The first run's step stands alone: the tour's welcome
// (TourHost) waits until it is answered (accessAnswered). Settings' first row, Claude access (ClaudeAccessRow), shows
// the way chosen and switches it in place.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { TextInput } from '../components/Field'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { Spinner } from '../components/Spinner'
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

/** Settings' first row. */
export const ACCESS_LABEL = 'Claude access'

/** The ways in the row's menu, in the order of the install's question, by their short names. */
export const ACCESS_WAYS: readonly { how: How; label: string }[] = [
  { how: 'claude-code', label: 'Claude Code sign-in' },
  { how: 'api-key', label: 'API key' },
  { how: 'wif', label: 'Workload Identity Federation' },
]

/** What a way needs from the row before it can be saved: a key to paste while ANTHROPIC_API_KEY is not set where the
 * workbench runs and no key is saved, the WIF config file's path while none is known; '' when it has what it needs.
 * Pure. */
export function accessNeeds(how: How, status: Pick<ClaudeAccess, 'env_key' | 'key_saved'> | null, file: string): '' | 'key' | 'file' {
  if (how === 'api-key') return status?.env_key || status?.key_saved ? '' : 'key'
  if (how === 'wif') return file.trim() ? '' : 'file'
  return ''
}

/** A problem, or a failed check's, in words: what is wrong, then the fix. Pure. */
export const problemWords = (p: { what?: string; fix?: string } | null | undefined): string =>
  [p?.what, p?.fix]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' ')

/** Settings' first row, Claude access: the way chosen, in a menu of the three ways. A pick that has what it needs
 * (accessNeeds) is saved and checked at once, with the setup step's one PUT, which makes the check's one small call; a
 * pick of the Claude Code sign-in is the consent to it. Under the row: while the way is the API key and
 * ANTHROPIC_API_KEY is not set where the workbench runs, a field to paste a key, which never shows the key saved; while
 * it is WIF, the config file's path; Enter in either, or leaving it, saves what is typed and checks it. Then what a
 * failed check or a refused save said, or, before either, what the saved way lacks (the status's problem, found
 * without a call). A pick that waits for its key or its file is saved only from that field: Settings closed before
 * then, the way saved before stays. */
export function ClaudeAccessRow() {
  const [status, setStatus] = useState<ClaudeAccess | null>(null)
  // the way the row shows: the one saved, or a pick that waits for its key or its file
  const [how, setHow] = useState<How | ''>('')
  const [key, setKey] = useState('')
  const [file, setFile] = useState('')
  const [busy, setBusy] = useState(false)
  // what the last save said under the row: null before one, '' when its check passed
  const [said, setSaid] = useState<string | null>(null)
  const saving = useRef(false)
  // what a field last sent, which leaving the field does not send again
  const sent = useRef('')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let alive = true
    api
      .claudeAccess()
      .then((s) => {
        if (!alive) return
        setStatus(s)
        setHow(s.how)
        setFile(s.wif_file || '')
      })
      .catch((e: Error) => alive && setSaid(e.message.replace(/^\d+ /, '')))
    return () => {
      alive = false
    }
  }, [])
  const save = async (to: How, body: { key?: string; wif_file?: string } = {}) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setSaid(null)
    try {
      const got = await api.setClaudeAccess({ how: to, ...body, consent: to === 'claude-code' })
      setStatus(got)
      setHow(got.how)
      setKey('')
      sent.current = ''
      setFile(got.wif_file || '')
      setSaid(got.check.ok ? '' : problemWords(got.check.problem))
    } catch (e) {
      // nothing was saved: the pick and what was typed stay, to be put right
      setSaid((e as Error).message.replace(/^\d+ /, ''))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  const pick = (to: How) => {
    setHow(to)
    setSaid(null)
    const known = to === 'wif' ? file : ''
    if (!accessNeeds(to, status, known)) void save(to, to === 'wif' ? { wif_file: known.trim() } : {})
    else requestAnimationFrame(() => field.current?.focus())
  }
  /** What a field holds, saved with its way: on Enter always, on leaving the field only when it is new (not what the
   * field last sent, nor the path saved). */
  const typed = (enter: boolean) => {
    const to: How = how === 'wif' ? 'wif' : 'api-key'
    const v = (to === 'wif' ? file : key).trim()
    if (!v || (!enter && (v === sent.current || (to === 'wif' && status?.how === 'wif' && v === status.wif_file)))) return
    sent.current = v
    void save(to, to === 'wif' ? { wif_file: v } : { key: v })
  }
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    typed(true)
  }

  const chip = (
    <Chip kind="plain" face="sans" as="button" trailingIcon="chevron-down" className="settings-access-way" aria-label={ACCESS_LABEL} disabled={busy}>
      {ACCESS_WAYS.find((w) => w.how === how)?.label ?? 'Not chosen'}
    </Chip>
  )
  const items: MenuItem[] = ACCESS_WAYS.map((w) => ({ id: w.how, label: w.label, checked: w.how === how, onSelect: () => pick(w.how) }))
  const keyField = how === 'api-key' && !!status && !status.env_key
  const under = said ?? (status && how === status.how ? problemWords(status.problem) : '')
  return (
    <div className="settings-access" data-setting="claude-access" data-how={how || 'none'}>
      <div className="settings-line">
        <span className="settings-name">{ACCESS_LABEL}</span>
        <span className="settings-access-state">
          {busy && <Spinner size={10} label="Checking" />}
          {said === '' && <Icon name="check" size={14} className="settings-access-ok" title="Claude answers" />}
          {status && (busy ? chip : <Menu label={ACCESS_LABEL} align="end" items={items} trigger={chip} />)}
        </span>
      </div>
      {(keyField || how === 'wif' || under) && (
        <div className="settings-access-more">
          {keyField && (
            <TextInput
              ref={field}
              block
              mono
              type="password"
              value={key}
              onChange={setKey}
              placeholder={status?.key_saved ? 'A key is saved' : 'sk-ant-…'}
              aria-label="Anthropic API key"
              autoComplete="off"
              spellCheck={false}
              readOnly={busy}
              onKeyDown={onKey}
              onBlur={() => typed(false)}
            />
          )}
          {how === 'wif' && (
            <TextInput
              ref={field}
              block
              mono
              value={file}
              onChange={setFile}
              placeholder="/path/to/wif-config.toml"
              aria-label="Workload Identity Federation config file"
              spellCheck={false}
              readOnly={busy}
              onKeyDown={onKey}
              onBlur={() => typed(false)}
            />
          )}
          {under && (
            <p className="settings-access-said" role="alert">
              {under}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
