// A label's glob read by the one rule the backend reads a label's paths and a view's claims with (bug hunt E3: backend
// corpus_tree.glob_match): `*` spans `/`, a `**/` may stand for no folder, a plain path names a file or its folder, a
// record place after `#` is left out. The terminal's Files marks a file a label covers by it (hooks/term/files.ts
// globTest). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { globTest } from '../files'

const PATHS = ['README.md', 'bandit-sim/README.md', 'bandit-sim/report/README.md', 'runs/r1/agents/a.jsonl', 'runs/a.jsonl', 'a.md', 'sub/a.md', 'b.md', 'big.jsonl']

test("bug hunt E3: a label's glob names the files the backend's rule names", () => {
  // what backend corpus_tree.glob_match gives for each pattern over PATHS
  const want: [string, string[]][] = [
    ['*/**/README.md', ['bandit-sim/README.md', 'bandit-sim/report/README.md']],
    ['*.jsonl', ['runs/r1/agents/a.jsonl', 'runs/a.jsonl', 'big.jsonl']],
    ['runs/**/a.jsonl', ['runs/r1/agents/a.jsonl', 'runs/a.jsonl']],
    ['[ab]*.md', ['bandit-sim/README.md', 'bandit-sim/report/README.md', 'a.md', 'b.md']],
    ['[!/]*.md', ['README.md', 'bandit-sim/README.md', 'bandit-sim/report/README.md', 'a.md', 'sub/a.md', 'b.md']],
    ['r?n*/*', ['runs/r1/agents/a.jsonl', 'runs/a.jsonl']],
    ['runs/**/r1/**/a.jsonl', ['runs/r1/agents/a.jsonl']],
    ['**/*.md', ['README.md', 'bandit-sim/README.md', 'bandit-sim/report/README.md', 'a.md', 'sub/a.md', 'b.md']],
  ]
  for (const [glob, paths] of want) expect([glob, PATHS.filter(globTest(glob))]).toEqual([glob, paths])
  const scope = globTest('runs#prs, bandit-sim/README.md')
  expect(PATHS.filter(scope)).toEqual(['bandit-sim/README.md', 'runs/r1/agents/a.jsonl', 'runs/a.jsonl'])
})
