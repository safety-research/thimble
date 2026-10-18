// @vitest-environment jsdom
// A shell step in the browser chat says what it did (bug hunt round 10, K5): its line names the description the Bash
// call carries, as the terminal panel's steps do since J2, never the start of its command, which opened alike in every
// row (`Bash B=/mnt/…/thimble-run; $B card …`, `Bash cd /mnt/…; python3 -c "`). A call with no description names its
// command without the settings and cd it opens with. Open, the call shows its whole command (src/chat/model.ts
// toolSummary, bareCommand; src/chat/Rows.tsx CallLine).
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { bareCommand, toolSummary, type ToolRow } from '../../src/chat/model.ts'
import { CallLine } from '../../src/chat/Rows.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(unmountAll)

const RUN = '/srv/opt/teashop-tools/plugin/bin/thimble-run'
const call = (input: Record<string, unknown>): ToolRow => ({ kind: 'tool', index: 0, id: 'toolu_tea1', name: 'Bash', input, children: [], result: { summary: 'ok' } })

test("a shell step's line names what the call says it does, not the start of its command", async () => {
  const command = `B=${RUN}; $B card brews-per-pot brews-per-day 2>&1 | tail -20`
  const el = await mount(<CallLine tool={call({ command, description: 'Run the two brew cards' })} ws="teashop" running={false} />)
  expect(el.querySelector('.chat-call-target')?.textContent).toBe('Run the two brew cards')
  // open, it shows the whole command
  await act(async () => el.querySelector<HTMLButtonElement>('.chat-call-chip')?.click())
  expect(el.querySelector('.chat-call-body')?.textContent).toContain('$B card brews-per-pot brews-per-day')
})

test('three scripts run in one folder read apart: by their descriptions, else by what follows the cd', () => {
  const ws = 'teashop'
  const script = (n: number) => `cd /srv/data/${ws}; python3 -c "\nimport json\nprint(${n})\n"`
  expect(toolSummary('Bash', { command: script(1), description: 'Count the pots' }, ws)).toBe('Count the pots')
  expect(toolSummary('Bash', { command: script(2) }, ws)).toBe('python3 -c " import json print(2) "')
  expect(toolSummary('Bash', { command: `B=${RUN}; $B card pots` }, ws)).toBe('$B card pots')
  expect(bareCommand('export W=/srv/w && cd "$W" && ls -la')).toBe('ls -la')
  expect(bareCommand('cd /srv/data')).toBe('cd /srv/data')
})
