// @vitest-environment jsdom
// The tour's captured Comments sidebar (src/tour/examples.json) shows the built-in checks as they are now
// (browser/prompts/checks/<id>.md: name, color, on or off), in their order, and no check thimble retired, then New
// check; the captured Report has no Comments pane of its own, as the Report has none: the top bar's Comments lists the
// checks.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import snaps from '../../src/tour/examples.json'

const dir = path.resolve(__dirname, '../../../prompts/checks')
const ORDER = ['heads-up', 'explainers', 'judgment'] // checks.py BUILTINS
const builtins = ORDER.map((id) => {
  const front = readFileSync(path.join(dir, `${id}.md`), 'utf8').split('---')[1]!
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(front)![1]!.trim()
  return { id, name: field('name'), color: `var(--label-${field('color')})`, on: field('shown') === 'true' }
})
const html = (s: string) => {
  const d = document.createElement('div')
  d.innerHTML = s
  return d
}

test('the prompts folder holds the built-ins the test reads', () => {
  expect(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort()).toEqual([...ORDER].sort())
})

test('the Comments sidebar example lists the built-in checks as they are now, then the analyst\'s own', () => {
  const side = html(snaps.commentsSide)
  const rows = [...side.querySelectorAll<HTMLElement>('.lside-row[data-category]')]
  expect(rows.map((r) => r.dataset.category)).toEqual([...ORDER, 'alternative-explanations'])
  for (const b of builtins) {
    const row = rows.find((r) => r.dataset.category === b.id)!
    expect(row.querySelector('.lside-name')!.firstChild!.textContent).toBe(b.name)
    expect(row.querySelector<HTMLElement>('.lside-swatch')!.style.getPropertyValue('--sw')).toBe(b.color)
    expect(row.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe(String(b.on))
    expect(row.classList.contains('is-off')).toBe(!b.on)
  }
  expect(side.textContent).not.toMatch(/Unverifiable|Important details|none reads the chat yet/)
  // the list ends in New check, as the sidebar's does (shell/LabelsSidebar.tsx NewCheck)
  const last = side.querySelector('.lside-section[data-section="comments"]')!.lastElementChild!
  expect([last.className, last.querySelector('button.lside-add')?.textContent]).toEqual(['lside-new', 'New check'])
})

test('the Report example has no Comments pane of its own: its sidebar holds the cards alone', () => {
  const report = html(snaps.reportPanel)
  expect(report.querySelector('.wu-side .wu-side-cards')).not.toBeNull()
  expect(report.querySelector('.wu-checks, .wu-check')).toBeNull()
})
