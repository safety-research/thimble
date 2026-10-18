// An agent's page lists its steps by what each did: a Bash call by the description it carries, else by its command
// without the variable settings and `cd` every step opens with; a file by its folder and name (bug hunt J2: a helper's
// 26 Bash steps all read `Bash · W=/mnt/…/workspaces/…`). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { bareCommand } from '../model'
import { CWD, aboveAt, paneAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const W = 'W=/home/someone/src/thimble/workspaces/sample-wiki/orient/work/tmp_helper01'
const HELPER = { id: 'n7', key: 'safeguards:c-helper', kind: 'safeguards', text: "Claude's safeguards switched a reply of a helper of the orientation from Opus 5.5 to Opus 4.8.", agent: 'Read link pages', chat: 'c-helper', open: 'agent', at: '2026-10-17T00:05:00Z', acts: [] }

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

test("an agent's steps say what each did: a Bash call's description, else its command without the settings every step opens with", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [HELPER]
  w.states.agents = { rows: [{ name: 'thimble:orient-helper', label: 'Read link pages', state: 'running', kind: 'subagent', chat: 'c-helper', role: 'orient-helper' }], line: '', text: '' }
  w.chats['c-helper'] = {
    meta: { id: 'c-helper', kind: 'agent', role: 'orient-helper', title: 'Read link pages', status: 'running' },
    events: [
      { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: `${W}; python3 - <<'EOF'\nimport json\nEOF`, description: 'Load data and print overview counts' } },
      { type: 'tool_use', id: 'u2', name: 'Bash', input: { command: `${W}; python3 - <<'EOF'\nprint(2)\nEOF`, description: 'Count the most common added lines' } },
      { type: 'tool_use', id: 'u3', name: 'Bash', input: { command: `${W} && cd "$W" && grep -c proxy revisions.jsonl` } },
      { type: 'tool_use', id: 'u4', name: 'Read', input: { file_path: '/home/someone/src/thimble/workspaces/sample-wiki/orient/work/tmp_helper01/notes.md' } },
    ],
  }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const band = (await $.ui.mount(aboveAt(220))) as unknown as M
  await band.press({ key: 'above-notice-n7-open' })
  await w.clock.settle()
  await band.unmount()
  const pane = (await $.ui.mount(paneAt(120, 60))) as unknown as M
  const text = words(await pane.drawn())
  expect(text).toContain('Steps (4)')
  expect(text).toContain('Bash · Load data and print overview counts')
  expect(text).toContain('Bash · Count the most common added lines')
  expect(text).toContain('Bash · grep -c proxy revisions.jsonl')
  expect(text).toContain('Read · …/tmp_helper01/notes.md')
  expect(text).not.toContain('Bash · W=')
  await pane.unmount()
})

test('a command keeps what follows its leading settings and `cd`s; a command with none is as written', () => {
  expect(bareCommand(`${W}; python3 x.py`)).toBe('python3 x.py')
  expect(bareCommand('export A=1 B="two words" && cd \'/tmp/a b\' && ls -la')).toBe('ls -la')
  expect(bareCommand('cd /data; wc -l *.jsonl')).toBe('wc -l *.jsonl')
  expect(bareCommand('ls -la /data')).toBe('ls -la /data')
  // a command that is only a setting stays as it is
  expect(bareCommand('A=1')).toBe('A=1')
})
