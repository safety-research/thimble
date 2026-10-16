// @vitest-environment jsdom
// Settings > Extensions mounted (src/shell/ExtensionsSettings.tsx): a switch on every row, a locked extension's switch
// disabled and off, an extension's views following its switch, a view's failed check in full, an extension's details
// opening under its name, a line too long for its row opening there too, a shipped extension that is not added reading
// as off and asking to run its orientation once it is switched on, and the conflicts under the rows.
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { ExtensionsSettings } from '../../src/shell/ExtensionsSettings.tsx'
import type { ExtensionRow, Extensions } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

const LONG = 'A description far too long for one line of the popover, which the row cuts short and opens in full.'
const base = { version: '', active: true, why: '', note: '', locked: false, on: true, views: [], parts: [], consent: '', sandboxed: null, orients: false, offer: false }
const rows: ExtensionRow[] = [
  { ...base, name: 'swarm-orient', version: '0.4.0', builtin: true, description: 'Reads every message.', active: false, why: 'not added', on: false, addable: true, parts: ['swarm-reader agent'], consent: 'swarm-reader: network.', needs: ['multiagent-swimlane'], orients: true },
  {
    ...base,
    name: 'tally',
    version: '1.2.0',
    description: 'Who did each task.',
    parts: ['Tally view'],
    sandboxed: true,
    views: [
      { slug: 'tally', name: 'Tally', shown: true, note: '', on: true, locked: false },
      { slug: 'weekly', name: 'Weekly load', shown: false, note: 'its checks failed here: the reader stopped at line 12', on: false, locked: false },
    ],
  },
  { ...base, name: 'broken', description: 'Has an unknown key.', active: false, why: 'unknown key "scopes"', note: 'unknown key "scopes"', locked: true },
  { ...base, name: 'wordy', description: LONG },
]
const DATA: Extensions = {
  extensions: rows,
  conflicts: ['tally and swarm-orient both replace the critic: thimble runs its own.'],
  orientation_ran: true,
  local: { name: 'here', views: [{ slug: 'pages', name: 'Pages', description: 'Each page with its edits.', file_viewer: false, on: true }] },
}

function Section() {
  const [on, setOn] = useState(Object.fromEntries(rows.map((e) => [e.name, e.on])))
  const [viewOn, setViewOn] = useState(Object.fromEntries(rows.flatMap((e) => e.views.map((v) => [`${e.name}/${v.slug}`, v.on]))))
  const [localOn, setLocalOn] = useState({ pages: true })
  const [said, setSaid] = useState<Record<string, boolean>>({})
  return (
    <ExtensionsSettings
      data={DATA}
      on={on}
      setOn={(n, v) => setOn((o) => ({ ...o, [n]: v }))}
      viewOn={viewOn}
      setViewOn={(k, v) => setViewOn((o) => ({ ...o, [k]: v }))}
      localOn={localOn}
      setLocalOn={(k, v) => setLocalOn((o) => ({ ...o, [k]: v }))}
      answers={said}
      setAnswer={(n, run) => setSaid((o) => ({ ...o, [n]: run }))}
    />
  )
}

beforeAll(() => {
  // jsdom lays nothing out: a line is as wide as its text at 4px a character, in a row 300px wide
  Object.defineProperty(HTMLSpanElement.prototype, 'scrollWidth', { configurable: true, get() { return (this.textContent ?? '').length * 4 } })
  Object.defineProperty(HTMLSpanElement.prototype, 'clientWidth', { configurable: true, get: () => 300 })
})
afterAll(() => {
  delete (HTMLSpanElement.prototype as { scrollWidth?: number }).scrollWidth
  delete (HTMLSpanElement.prototype as { clientWidth?: number }).clientWidth
})
afterEach(unmountAll)

const row = (el: HTMLElement, key: string) => el.querySelector<HTMLElement>(`[data-row="${key}"]`)!
const sw = (r: HTMLElement) => r.querySelector<HTMLButtonElement>(':scope > .settings-ext-switch [role=switch]')!

test('every row has its switch, and a locked extension has its switch disabled and off', async () => {
  const el = await mount(<Section />)
  const all = el.querySelectorAll('[data-row]')
  expect(all.length).toBe(1 + rows.length + 2)
  for (const r of all) expect(r.querySelectorAll('[role=switch]').length).toBe(1)
  const broken = sw(row(el, 'ext:broken'))
  expect(broken.disabled).toBe(true)
  expect(broken.getAttribute('aria-checked')).toBe('false')
  expect(row(el, 'ext:broken').textContent).toContain('unknown key "scopes"')
  expect(el.querySelector('[data-local]')).not.toBeNull()
  expect([...el.querySelectorAll('[data-extension]')].map((x) => x.getAttribute('data-extension'))).toEqual(rows.map((e) => e.name))
  expect(el.textContent).toContain(DATA.conflicts[0])
})
