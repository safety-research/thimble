// @vitest-environment jsdom
// The settings popover (src/shell/SettingsPopover.tsx): one flat list, Claude access, "Claude can edit files in this
// folder", Ask Claude with and Models, with no Save, no Cancel, no headings and no notes, every change sent at once.
// Claude access (src/shell/ClaudeAccess.tsx ClaudeAccessRow) shows how the workbench reaches Claude and switches it with
// one PUT that saves and checks the way: a pick that has what it needs at once, an API key pasted or a WIF config file
// named in the field under the row; a failed check or a refused save says why under the row. Models is open until the
// person folds it, which this browser keeps, and folded its line names the models and efforts in use. Each row is an
// agent by its plain name with a model menu, an effort menu and, where the row has fast mode and its model has it, the
// fast-mode bolt. Main's row is main's session's model, effort and fast mode, as the composer's line, sent to main's
// session routes (chat/mainChoice); the others go to thimble's config. While the config has an error, it shows first,
// and Ask Claude with and every row but main's are dimmed.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ACCESS_LABEL, ACCESS_WAYS, accessNeeds, problemWords } from '../../src/shell/ClaudeAccess.tsx'
import { ASK_KEY_LABEL, EDITS_LABEL, FAST_ROLES, MODEL_ROWS, MODELS_OPEN_KEY, PROPOSE_LABEL, SettingsPopover, askKeyOptions, modelsGist, roleEfforts, showsFast } from '../../src/shell/SettingsPopover.tsx'
import { choiceWords } from '../../src/chat/mainChoice.ts'
import { bus } from '../../src/lib/bus.ts'
import { KNOWN_MODELS, invalidateSettings, modelChoices } from '../../src/lib/models.ts'
import { getAskKey, setAskKey } from '../../src/lib/platform.ts'
import type { Attached, Settings } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const conf = (model: string, effort: string, fast = false) => ({ model, effort, fast })
const SETTINGS: Settings = {
  models: {
    orient: conf('claude-opus-5-5[1m]', 'xhigh'),
    subagents: { ...conf('claude-opus-5-5', 'xhigh'), follows: 'orient' },
    critic: conf('claude-opus-5-5', 'xhigh'),
    writer: conf('claude-opus-5-5', 'xhigh'),
    dev: conf('claude-opus-5-5', 'high', true),
    checks: conf('claude-opus-5-5', 'high'),
    labels: conf('claude-opus-5-5', 'low'),
    verify: conf('claude-opus-5-5', 'high', true),
    suggest: conf('claude-opus-5-5', 'medium'),
    refusal: { ...conf('claude-opus-4-8', 'high'), off: false },
  },
  config_error: '',
  config_ignored: ['agents.writer.fast'],
  card_wait: 10,
}
const ATTACHED: Attached = { session: 's1', cwd: '/c', since: '', effort: 'medium' }

/** How the workbench reaches Claude, as GET /api/claude-access gives it (backend claude_access.status) */
interface Access {
  how: '' | 'api-key' | 'claude-code' | 'wif'
  key_saved: boolean
  env_key: boolean
  wif_file: string
  problem: { what: string; fix: string } | null
}
const SIGNED_IN: Access = { how: 'claude-code', key_saved: false, env_key: false, wif_file: '', problem: null }

let puts: [string, unknown][] = []
let toasts: string[] = []
/** main's session, as main's chat gives it */
let attached: Attached | null = ATTACHED
/** what GET /settings answers */
let settings: Settings = SETTINGS
/** a PUT the server refuses, by its route's end */
let refuse: string | null = null
/** how the workbench reaches Claude; what the check after a PUT /claude-access finds (null: Claude answers); what a
 * refused PUT /claude-access says */
let access: Access = SIGNED_IN
let checkFails: { what: string; fix: string } | null = null
let accessRefused: string | null = null
let offToast = () => {}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  puts = []
  toasts = []
  attached = ATTACHED
  settings = SETTINGS
  refuse = null
  access = SIGNED_IN
  checkFails = null
  accessRefused = null
  invalidateSettings('mini')
  window.localStorage.clear()
  offToast = bus.on('toast', (t) => void toasts.push(t.text))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'PUT') {
      puts.push([u, JSON.parse(String(init.body))])
      if (refuse && u.endsWith(refuse)) return json({ detail: 'nope' }, 400)
    }
    if (u.endsWith('/claude-access')) {
      if (init?.method === 'PUT') {
        if (accessRefused) return json({ detail: accessRefused }, 400)
        const b = JSON.parse(String(init.body)) as { how: Access['how']; key?: string; wif_file?: string }
        access = { ...access, how: b.how, key_saved: access.key_saved || !!b.key, wif_file: b.how === 'wif' ? (b.wif_file ?? '') : '', problem: null }
        return json({ ...access, describe: '', consent_text: '', check: checkFails ? { ok: false, how: b.how, describe: '', problem: checkFails } : { ok: true, how: b.how, describe: '' } })
      }
      return json({ ...access, describe: '', consent_text: '' })
    }
    const body = u.includes('/settings') ? settings : u.includes('/session/') ? {} : { meta: { id: 'main', attached } }
    return json(body)
  })
})
afterEach(() => {
  offToast()
  unmountAll()
  vi.unstubAllGlobals()
})

const open = async (onClose: () => void = () => {}) => {
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  await mount(<SettingsPopover ws="mini" anchor={anchor} open onClose={onClose} />)
  await settle()
  await settle()
}
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const row = (role: string) => q(`.settings-row[data-role="${role}"]`)!
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click())
  await settle()
}
/** Opens the menu `label` names and picks its item `item`. */
const pick = async (label: string, item: string) => {
  await click(q(`[aria-label="${label}"]`))
  await click(q(`.menu-item[data-item="${item}"]`))
  await settle()
}

describe('the rules', () => {
  test("the rows by plain name; every agent's effort menu is Claude Code's levels and main's adds ultracode", () => {
    expect(MODEL_ROWS.map((r) => r.name)).toEqual(['Main and side threads', 'Writer', 'View builds and code tickets', 'Checks', 'Labels', 'Card check', 'View proposals'])
    expect(MODEL_ROWS.map((r) => r.role)).toEqual(['main', 'writer', 'dev', 'checks', 'labels', 'verify', 'suggest'])
    expect(roleEfforts('writer')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(roleEfforts('main')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
  })

  test('a row shows the bolt where it has fast mode and its model has it', () => {
    expect(FAST_ROLES).toEqual(['main', 'dev', 'labels', 'verify', 'suggest'])
    expect(showsFast('labels', 'claude-opus-5-5')).toBe(true)
    expect(showsFast('main', 'claude-opus-4-8')).toBe(true)
    expect(showsFast('labels', 'claude-sonnet-5-5')).toBe(false)
    expect(showsFast('writer', 'claude-opus-5-5')).toBe(false)
    expect(showsFast('checks', 'claude-opus-5-5')).toBe(false)
  })

  test('folded, Models names the models in use and the range of the efforts in use; a model with no effort counts none', () => {
    const rows = MODEL_ROWS.map(({ role }) => (role === 'main' ? conf('claude-opus-5-5', 'medium') : SETTINGS.models[role]))
    expect(modelsGist(rows)).toBe('Opus 5.5 · low to xhigh')
    expect(modelsGist([...rows, conf('claude-sonnet-5-5', 'max')])).toBe('Opus 5.5, Sonnet 5.5 · low to max')
    expect(modelsGist([conf('claude-opus-5-5', 'high'), conf('claude-haiku-4-5-20251001', '')])).toBe('Opus 5.5, Haiku 4.5 · high')
    expect(modelsGist([conf('claude-opus-5-5', 'ultracode'), conf('claude-opus-5-5', 'low')])).toBe('Opus 5.5 · low to ultracode')
  })

  test('the ask key reads ⌘-click and ⌥-click on a Mac, Ctrl-click and Alt-click elsewhere', () => {
    expect(askKeyOptions(true)).toEqual([
      { value: 'meta', label: '⌘-click' },
      { value: 'alt', label: '⌥-click' },
    ])
    expect(askKeyOptions(false).map((o) => o.label)).toEqual(['Ctrl-click', 'Alt-click'])
  })

  test('every model menu lists the current models in the same order, whichever is picked, then the others named', () => {
    expect(modelChoices(SETTINGS, 'claude-opus-4-8').slice(0, KNOWN_MODELS.length)).toEqual([...KNOWN_MODELS])
    expect(modelChoices(SETTINGS, 'claude-foo-1[1m]')).toEqual([...KNOWN_MODELS, 'claude-foo-1'])
  })

  test("main's choices are named in the toast as the composer names them", () => {
    expect(choiceWords({ model: 'claude-sonnet-5-5' })).toBe('Sonnet 5.5')
    expect(choiceWords({ effort: 'max' })).toBe('Effort max')
    expect(choiceWords({ fast: true })).toBe('Fast mode on')
  })
})

describe('the popover', () => {
  test('one flat list: Claude access, the edits switch, Ask Claude with, View proposals and Models, open, with no Save, Cancel, headings or notes', async () => {
    await open()
    const doc = document.body
    const lines = [...doc.querySelectorAll('.settings > [data-setting], .settings > .settings-fold')]
    expect(lines.map((l) => l.getAttribute('data-setting') ?? 'models')).toEqual(['claude-access', 'corpus-edits', 'ask-key', 'propose-views', 'models'])
    expect(q('[data-setting="claude-access"] .settings-name')?.textContent).toBe(ACCESS_LABEL)
    expect(q('.settings-line[data-setting="corpus-edits"] .settings-name')?.textContent).toBe(EDITS_LABEL)
    expect(q('.settings-line[data-setting="ask-key"] .settings-name')?.textContent).toBe(ASK_KEY_LABEL)
    expect(q('.settings-line[data-setting="propose-views"] .settings-name')?.textContent).toBe(PROPOSE_LABEL)
    expect(q('.settings-fold')?.getAttribute('aria-expanded')).toBe('true')
    expect([...doc.querySelectorAll('.settings-row .settings-name')].map((n) => n.textContent)).toEqual(MODEL_ROWS.map((r) => r.name))
    for (const { name } of MODEL_ROWS) {
      expect(q(`[aria-label="Model for ${name}"]`)?.textContent).toBe('Opus 5.5')
      expect(q(`[aria-label="Effort for ${name}"]`)).not.toBeNull()
    }
    expect(q('[aria-label="Effort for Main and side threads"]')?.textContent).toBe('medium')
    expect(q('[aria-label="Effort for Writer"]')?.textContent).toBe('xhigh')
    const buttons = [...doc.querySelectorAll('button')].map((b) => b.textContent)
    for (const gone of ['Save', 'Cancel', 'Take the tour', 'Change']) expect(buttons).not.toContain(gone)
    expect(doc.querySelectorAll('[role="switch"]')).toHaveLength(2)
    expect(doc.textContent).not.toMatch(/if refused|next start|CLAUDE\.md|permission mode|Asks nothing|View proposals switch|ignores|\/login/i)
    expect(doc.querySelector('.settings-error')).toBeNull()
  })

  test('the bolts: main, view builds, labels, the card check and view proposals, each as its row holds it', async () => {
    attached = { ...ATTACHED, fast_choice: true }
    await open()
    const bolt = (role: string) => row(role).querySelector('.fast-bolt')
    expect(MODEL_ROWS.filter(({ role }) => bolt(role)).map((r) => r.role)).toEqual(['main', 'dev', 'labels', 'verify', 'suggest'])
    expect(['main', 'dev', 'labels', 'verify', 'suggest'].map((r) => bolt(r)!.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'false', 'true', 'false'])
    expect(bolt('main')!.getAttribute('aria-label')).toBe('Fast mode for Main and side threads')
  })

  test("a row's bolt goes with a model that has no fast mode", async () => {
    settings = { ...SETTINGS, models: { ...SETTINGS.models, labels: conf('claude-sonnet-5-5', 'low', true) } }
    await open()
    expect(row('labels').querySelector('.fast-bolt')).toBeNull()
    expect(row('labels').querySelector('.settings-fast')).not.toBeNull()
  })

  test("an agent's pick is saved at once, in thimble's config: its model, its effort and its fast mode", async () => {
    await open()
    await pick('Effort for Writer', 'max')
    expect(puts).toEqual([['/api/ws/mini/settings', { models: { writer: { effort: 'max' } } }]])
    await pick('Model for Checks', 'm:claude-sonnet-5-5')
    await click(row('dev').querySelector('.fast-bolt'))
    await click(row('labels').querySelector('.fast-bolt'))
    expect(puts.slice(1)).toEqual([
      ['/api/ws/mini/settings', { models: { checks: { model: 'claude-sonnet-5-5' } } }],
      ['/api/ws/mini/settings', { models: { dev: { fast: false } } }],
      ['/api/ws/mini/settings', { models: { labels: { fast: true } } }],
    ])
    expect(toasts).toEqual([])
  })

  test("main's row is main's session: each pick goes to its routes at once, as the composer's line, and says when it applies", async () => {
    await open()
    await pick('Effort for Main and side threads', 'ultracode')
    await pick('Model for Main and side threads', 'm:claude-opus-4-8')
    await click(row('main').querySelector('.fast-bolt'))
    expect(puts).toEqual([
      ['/api/ws/mini/session/effort', { effort: 'ultracode' }],
      ['/api/ws/mini/session/model', { model: 'claude-opus-4-8' }],
      ['/api/ws/mini/session/fast', { fast: true }],
    ])
    expect(toasts).toEqual(['Effort ultracode: Main uses it from your next message.', 'Opus 4.8: Main uses it from your next message.', 'Fast mode on: Main uses it from your next message.'])
  })

  test("with no session attached, main's row still sends its picks and shows them", async () => {
    attached = null
    await open()
    await pick('Effort for Main and side threads', 'low')
    expect(puts).toEqual([['/api/ws/mini/session/effort', { effort: 'low' }]])
    expect(q('[aria-label="Effort for Main and side threads"]')?.textContent).toBe('low')
  })

  test('a save the server refuses says why, and the row shows what the server holds', async () => {
    refuse = '/settings'
    await open()
    await pick('Effort for Writer', 'max')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/^Could not change the effort: .*nope/)
    expect(q('[aria-label="Effort for Writer"]')?.textContent).toBe('xhigh')
  })

  test("Other takes a model's id: Enter saves it, Escape leaves the model and the menu as they were", async () => {
    const onClose = vi.fn()
    await open(onClose)
    const type = async (text: string, key: string) => {
      const input = q<HTMLInputElement>('.settings-typed')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
      await settle()
    }
    await pick('Model for Labels', 'other')
    expect(q('.settings-typed')?.getAttribute('aria-label')).toBe('Model for Labels')
    await type('claude-sonnet-5', 'Escape')
    expect(q('.settings-typed')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(puts).toEqual([])
    await pick('Model for Labels', 'other')
    await type(' claude-sonnet-5 ', 'Enter')
    expect(puts).toEqual([['/api/ws/mini/settings', { models: { labels: { model: 'claude-sonnet-5' } } }]])
  })

  test('the edits switch is saved at once: false turns it off, null back on', async () => {
    await open()
    const sw = () => q('.settings-line[data-setting="corpus-edits"] [role="switch"]')!
    expect(sw().getAttribute('aria-checked')).toBe('true')
    settings = { ...SETTINGS, corpus_edits: false }
    await click(sw())
    expect(sw().getAttribute('aria-checked')).toBe('false')
    settings = SETTINGS
    await click(sw())
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(puts).toEqual([
      ['/api/ws/mini/settings', { corpus_edits: false }],
      ['/api/ws/mini/settings', { corpus_edits: null }],
    ])
  })

  test('View proposals, after Ask Claude with, is saved at once in thimble’s config: false turns them off, null back on', async () => {
    await open()
    const line = q('.settings-line[data-setting="propose-views"]')!
    expect(line.previousElementSibling?.getAttribute('data-setting')).toBe('ask-key')
    const sw = () => line.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(sw().getAttribute('aria-label')).toBe(PROPOSE_LABEL)
    expect(sw().getAttribute('aria-checked')).toBe('true')
    settings = { ...SETTINGS, propose_views: false }
    await click(sw())
    expect(sw().getAttribute('aria-checked')).toBe('false')
    settings = SETTINGS
    await click(sw())
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(puts).toEqual([
      ['/api/ws/mini/settings', { propose_views: false }],
      ['/api/ws/mini/settings', { propose_views: null }],
    ])
    // a save the server refuses says why, and the switch shows what the server holds
    refuse = '/settings'
    await click(sw())
    expect(toasts).toEqual(['Could not change view proposals: 400 nope'])
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  test('Ask Claude with is saved at once, and the page takes the key', async () => {
    setAskKey('meta')
    try {
      await open()
      const options = () => [...document.body.querySelectorAll<HTMLButtonElement>('.settings-ask-key [role="radio"]')]
      // jsdom reports no Mac
      expect(options().map((o) => [o.textContent, o.getAttribute('aria-checked')])).toEqual([
        ['Ctrl-click', 'true'],
        ['Alt-click', 'false'],
      ])
      await click(options()[1])
      expect(puts).toEqual([['/api/ws/mini/settings', { ask_key: 'alt' }]])
      expect(getAskKey()).toBe('alt')
    } finally {
      setAskKey('meta')
    }
  })

  test('Models folds to the models and efforts in use, and this browser keeps it folded', async () => {
    await open()
    expect(q('.settings-gist')?.textContent).toBe('')
    await click(q('.settings-fold'))
    expect(q('.settings-fold')?.getAttribute('aria-expanded')).toBe('false')
    expect(q('.settings-row')).toBeNull()
    expect(q('.settings-gist')?.textContent).toBe('Opus 5.5 · low to xhigh')
    expect(window.localStorage.getItem(MODELS_OPEN_KEY)).toBe('false')
    unmountAll()
    await open()
    expect(q('.settings-fold')?.getAttribute('aria-expanded')).toBe('false')
    await click(q('.settings-fold'))
    expect(document.body.querySelectorAll('.settings-row')).toHaveLength(MODEL_ROWS.length)
  })

  test("while thimble's config has an error it shows first, and Ask Claude with, View proposals and every row but main's are dimmed", async () => {
    settings = { ...SETTINGS, config_error: "thimble's config ~/.thimble-browser/config.json: agents.writer.modle is not a setting" }
    await open()
    const first = q('.settings')!.firstElementChild!
    expect(first.className).toBe('settings-error')
    expect(first.textContent).toContain('~/.thimble-browser/config.json')
    expect(q('.settings-line[data-setting="ask-key"]')?.hasAttribute('data-frozen')).toBe(true)
    expect([...document.body.querySelectorAll<HTMLButtonElement>('.settings-ask-key [role="radio"]')].every((o) => o.disabled)).toBe(true)
    expect(q('.settings-line[data-setting="propose-views"]')?.hasAttribute('data-frozen')).toBe(true)
    expect(q<HTMLButtonElement>('.settings-line[data-setting="propose-views"] [role="switch"]')!.disabled).toBe(true)
    expect(MODEL_ROWS.filter(({ role }) => row(role).hasAttribute('data-frozen')).map((r) => r.role)).toEqual(['writer', 'dev', 'checks', 'labels', 'verify', 'suggest'])
    expect(q<HTMLButtonElement>('[aria-label="Model for Writer"]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>('[aria-label="Effort for Card check"]')!.disabled).toBe(true)
    await click(row('dev').querySelector('.fast-bolt'))
    expect(puts).toEqual([])
    expect(q<HTMLButtonElement>('[aria-label="Model for Main and side threads"]')!.disabled).toBe(false)
    expect(q<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false)
    // how the workbench reaches Claude is not thimble's config: its row comes next, and takes picks
    expect(first.nextElementSibling?.getAttribute('data-setting')).toBe('claude-access')
    expect(q<HTMLButtonElement>(`[aria-label="${ACCESS_LABEL}"]`)!.disabled).toBe(false)
  })
})

describe('Claude access', () => {
  const access_ = () => q('[data-setting="claude-access"]')!
  const way = () => q(`[aria-label="${ACCESS_LABEL}"]`)!
  const under = () => access_().querySelector('.settings-access-said')?.textContent ?? ''
  const field = (label: string) => q<HTMLInputElement>(`[data-setting="claude-access"] input[aria-label="${label}"]`)
  const KEY = 'Anthropic API key'
  const FILE = 'Workload Identity Federation config file'
  /** `text` typed in the field `label` names, then Enter */
  const enter = async (label: string, text: string) => {
    const input = field(label)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await settle()
    await settle()
  }
  const accessPuts = () => puts.filter(([u]) => u.endsWith('/claude-access')).map(([, b]) => b)

  test('the ways in the order of the install’s question; what each needs from the row; a problem in words', () => {
    expect(ACCESS_WAYS.map((w) => w.label)).toEqual(['Claude Code sign-in', 'API key', 'Workload Identity Federation'])
    expect(accessNeeds('claude-code', null, '')).toBe('')
    expect(accessNeeds('api-key', { env_key: false, key_saved: false }, '')).toBe('key')
    expect(accessNeeds('api-key', { env_key: true, key_saved: false }, '')).toBe('')
    expect(accessNeeds('api-key', { env_key: false, key_saved: true }, '')).toBe('')
    expect(accessNeeds('wif', null, ' ')).toBe('file')
    expect(accessNeeds('wif', null, '~/wif.toml')).toBe('')
    expect(problemWords({ what: 'Claude Code is not signed in.', fix: 'Run claude in a terminal and sign in.' })).toBe('Claude Code is not signed in. Run claude in a terminal and sign in.')
    expect(problemWords({ what: 'The check failed.', fix: '' })).toBe('The check failed.')
    expect(problemWords(null)).toBe('')
  })

  test('the first row shows the way chosen, and its menu lists the three ways with that one checked', async () => {
    await open()
    expect(way().textContent).toBe('Claude Code sign-in')
    expect(access_().getAttribute('data-how')).toBe('claude-code')
    await click(way())
    const items = [...document.body.querySelectorAll<HTMLButtonElement>('.popover[role="menu"] .menu-item')]
    expect(items.map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([
      ['Claude Code sign-in', 'true'],
      ['API key', 'false'],
      ['Workload Identity Federation', 'false'],
    ])
    // nothing is saved or checked by opening it
    expect(accessPuts()).toEqual([])
    expect(access_().querySelector('input')).toBeNull()
    expect(under()).toBe('')
  })

  test('a pick that has what it needs is saved and checked at once; a failed check says why under the row', async () => {
    access = { ...SIGNED_IN, how: 'api-key', env_key: true }
    await open()
    // ANTHROPIC_API_KEY is set where the workbench runs: the row takes no key
    expect(way().textContent).toBe('API key')
    expect(field(KEY)).toBeNull()
    checkFails = { what: 'Claude Code is not signed in.', fix: 'Run claude in a terminal and sign in.' }
    await pick(ACCESS_LABEL, 'claude-code')
    expect(accessPuts()).toEqual([{ how: 'claude-code', consent: true }])
    expect(way().textContent).toBe('Claude Code sign-in')
    expect(under()).toBe('Claude Code is not signed in. Run claude in a terminal and sign in.')
    expect(access_().querySelector('.settings-access-ok')).toBeNull()
    // a pick of the way saved saves and checks it again
    checkFails = null
    await pick(ACCESS_LABEL, 'claude-code')
    expect(accessPuts()).toHaveLength(2)
    expect(under()).toBe('')
    expect(access_().querySelector('.settings-access-ok')).not.toBeNull()
    await pick(ACCESS_LABEL, 'api-key')
    expect(accessPuts()[2]).toEqual({ how: 'api-key', consent: false })
    expect(toasts).toEqual([])
  })

  test('an API key without ANTHROPIC_API_KEY waits for the key pasted under the row, which Enter saves and checks; the field never shows a key', async () => {
    await open()
    await pick(ACCESS_LABEL, 'api-key')
    // nothing to save yet: the row shows the pick and its field
    expect(accessPuts()).toEqual([])
    expect(way().textContent).toBe('API key')
    expect(field(KEY)?.type).toBe('password')
    expect(field(KEY)?.placeholder).toBe('sk-ant-…')
    await enter(KEY, '  sk-ant-made-up  ')
    expect(accessPuts()).toEqual([{ how: 'api-key', key: 'sk-ant-made-up', consent: false }])
    expect(field(KEY)?.value).toBe('')
    expect(field(KEY)?.placeholder).toBe('A key is saved')
    expect(access_().querySelector('.settings-access-ok')).not.toBeNull()
    unmountAll()
    // opened again, the saved key is never in the field
    await open()
    expect(way().textContent).toBe('API key')
    expect(field(KEY)?.value).toBe('')
    expect(field(KEY)?.placeholder).toBe('A key is saved')
  })

  test('a refused save says why under the row, and the pick and the path typed stay to be put right', async () => {
    await open()
    await pick(ACCESS_LABEL, 'wif')
    expect(accessPuts()).toEqual([])
    expect(field(FILE)?.value).toBe('')
    accessRefused = 'there is no file /home/analyst/wif.toml'
    await enter(FILE, '~/wif.toml')
    expect(accessPuts()).toEqual([{ how: 'wif', wif_file: '~/wif.toml', consent: false }])
    expect(under()).toBe('there is no file /home/analyst/wif.toml')
    expect(way().textContent).toBe('Workload Identity Federation')
    expect(field(FILE)?.value).toBe('~/wif.toml')
    // leaving the field sends nothing it sent before
    await act(async () => void field(FILE)!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await settle()
    expect(accessPuts()).toHaveLength(1)
    accessRefused = null
    await enter(FILE, '~/wif-config.toml')
    expect(accessPuts()[1]).toEqual({ how: 'wif', wif_file: '~/wif-config.toml', consent: false })
    expect(under()).toBe('')
    expect(field(FILE)?.value).toBe('~/wif-config.toml')
  })

  test('a way that is chosen but lacks something says so under the row when Settings opens', async () => {
    access = { ...SIGNED_IN, how: 'api-key', problem: { what: 'No API key: ANTHROPIC_API_KEY is not set, and no key is saved.', fix: 'Paste one in Settings, Claude access, or set ANTHROPIC_API_KEY and start thimble-browser again.' } }
    await open()
    expect(under()).toBe('No API key: ANTHROPIC_API_KEY is not set, and no key is saved. Paste one in Settings, Claude access, or set ANTHROPIC_API_KEY and start thimble-browser again.')
    expect(field(KEY)).not.toBeNull()
    expect(accessPuts()).toEqual([])
  })
})
