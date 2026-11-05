// @vitest-environment jsdom
// The settings popover (src/shell/SettingsPopover.tsx): one flat list, "Claude can edit files in this folder", Ask Claude
// with and Models, with no Save, no Cancel, no headings and no notes, every change sent at once. Models is open until
// the person folds it, which this browser keeps, and folded its line names the models and efforts in use. Each row is
// an agent by its plain name with a model menu, an effort menu and, where the row has fast mode and its model has it,
// the fast-mode bolt. Main's row is main's session's model, effort and fast mode, as the composer's line, sent to
// main's session routes (chat/mainChoice); the others go to thimble's config. While the config has an error, it shows
// first, and Ask Claude with and every row but main's are dimmed.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ASK_KEY_LABEL, EDITS_LABEL, FAST_ROLES, MODEL_ROWS, MODELS_OPEN_KEY, SettingsPopover, askKeyOptions, modelsGist, roleEfforts, showsFast } from '../../src/shell/SettingsPopover.tsx'
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

let puts: [string, unknown][] = []
let toasts: string[] = []
/** main's session, as main's chat gives it */
let attached: Attached | null = ATTACHED
/** what GET /settings answers */
let settings: Settings = SETTINGS
/** a PUT the server refuses, by its route's end */
let refuse: string | null = null
let offToast = () => {}
beforeEach(() => {
  puts = []
  toasts = []
  attached = ATTACHED
  settings = SETTINGS
  refuse = null
  invalidateSettings('mini')
  window.localStorage.clear()
  offToast = bus.on('toast', (t) => void toasts.push(t.text))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'PUT') {
      puts.push([u, JSON.parse(String(init.body))])
      if (refuse && u.endsWith(refuse)) return new Response(JSON.stringify({ detail: 'nope' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    const body = u.includes('/settings') ? settings : u.includes('/session/') ? {} : { meta: { id: 'main', attached } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
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
  test('one flat list: the edits switch, Ask Claude with and Models, open, with no Save, Cancel, headings or notes', async () => {
    await open()
    const doc = document.body
    expect(q('.settings-line[data-setting="corpus-edits"] .settings-name')?.textContent).toBe(EDITS_LABEL)
    expect(q('.settings-line[data-setting="ask-key"] .settings-name')?.textContent).toBe(ASK_KEY_LABEL)
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
    expect(doc.querySelectorAll('[role="switch"]')).toHaveLength(1)
    expect(doc.textContent).not.toMatch(/Claude access|if refused|next start|CLAUDE\.md|permission mode|Asks nothing|View proposals switch|ignores/i)
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

  test("while thimble's config has an error it shows first, and Ask Claude with and every row but main's are dimmed", async () => {
    settings = { ...SETTINGS, config_error: "thimble's config ~/.thimble-browser/config.json: agents.writer.modle is not a setting" }
    await open()
    const first = q('.settings')!.firstElementChild!
    expect(first.className).toBe('settings-error')
    expect(first.textContent).toContain('~/.thimble-browser/config.json')
    expect(q('.settings-line[data-setting="ask-key"]')?.hasAttribute('data-frozen')).toBe(true)
    expect([...document.body.querySelectorAll<HTMLButtonElement>('.settings-ask-key [role="radio"]')].every((o) => o.disabled)).toBe(true)
    expect(MODEL_ROWS.filter(({ role }) => row(role).hasAttribute('data-frozen')).map((r) => r.role)).toEqual(['writer', 'dev', 'checks', 'labels', 'verify', 'suggest'])
    expect(q<HTMLButtonElement>('[aria-label="Model for Writer"]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>('[aria-label="Effort for Card check"]')!.disabled).toBe(true)
    await click(row('dev').querySelector('.fast-bolt'))
    expect(puts).toEqual([])
    expect(q<HTMLButtonElement>('[aria-label="Model for Main and side threads"]')!.disabled).toBe(false)
    expect(q<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false)
  })
})
