// @vitest-environment jsdom
// B26: a whole-file JSON transcript's folded row names each tool call by the argument Claude Code names it by (a Read's
// file_path, a Grep's pattern, a WebFetch's url), not by the argument's key, and an opened system turn renders its
// Markdown (src/files/views/transcript.tsx callGloss, TurnCard).
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import transcript from '../../src/files/views/transcript.tsx'
import { api } from '../../src/lib/api.ts'
import type { SourcePage } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const call = (name: string, input: object) => ({ kind: 'tool_use' as const, text: `${name}\n${JSON.stringify(input, null, 2)}` })

test("a tool call's row names what it acts on, and a system turn's Markdown renders", async () => {
  vi.spyOn(api, 'sourceTurns').mockResolvedValue({
    path: 'u1.json',
    total: 2,
    start: 0,
    n_groups: 1,
    groups: { '0': { title: '', first: 0 } },
    turns: [
      { i: 0, line: 2, speaker: 'system', role: 'system', text: 'You maintain **Lattice**, a notes app.\n\n## Your assignment\n\nMove it to Go.', group: 0 },
      {
        i: 1,
        line: 9,
        speaker: 'assistant',
        role: 'assistant',
        text: '',
        group: 0,
        blocks: [
          call('Bash', { command: 'ls /workspace', description: 'List the workspace' }),
          call('Read', { file_path: '/workspace/lattice/README.md' }),
          call('Grep', { path: '/workspace/lattice', pattern: 'TODO' }),
          call('WebFetch', { prompt: 'What does it say about links?', url: 'https://example.com/spec' }),
        ],
      },
    ],
  })
  const page: SourcePage = { path: 'u1.json', kind: 'text', total_lines: 20, start: 1, records: [] }
  const el = await mount(<transcript.component workspace="w" path="u1.json" kind="text" page={page} loadMore={() => undefined} transcript={{ format: 'json', score: 0.95 }} />)
  await settle()
  const card = (line: number) => el.querySelector<HTMLElement>(`.reader-card[data-line="${line}"]`)!
  expect(card(9).querySelector('.reader-fold-text')!.textContent).toBe('Bash ls /workspace · Read /workspace/lattice/README.md · Grep TODO · WebFetch https://example.com/spec')
  await act(async () => card(2).querySelector<HTMLButtonElement>('.reader-fold-line')!.click())
  expect(card(2).querySelector('strong')?.textContent).toBe('Lattice')
  expect(card(2).querySelector('h2')?.textContent).toBe('Your assignment')
  expect(card(2).querySelector('.reader-record-main')!.textContent).not.toMatch(/\*\*|##/)
})
