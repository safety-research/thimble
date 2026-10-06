// The arguments of /thimble-orient and /thimble-label (hooks/commands.ts): read forgivingly, said back in one line,
// an unknown option refused with the list. `claude plugin test mods/thimble-cc-mod`.
import { expect, test } from 'claude-code/testing'

import { ORIENT_DEFAULTS, labelInputOf, labelLine, orientLine, orientOptsOf, parseLabelArgs, parseOrientArgs, tokenize, withinOf } from '../hooks/commands'

test('words: whitespace splits them except inside quotes, and key="a b" stays one word', () => {
  expect(tokenize('  who edits  "the most" ')).toEqual(['who', 'edits', 'the most'])
  expect(tokenize(`definition="asks for money back" values='yes, no' regex=“a|b”`)).toEqual(['definition=asks for money back', 'values=yes, no', 'regex=a|b'])
  expect(tokenize('brief=""')).toEqual(['brief='])
  expect(tokenize("it's fine")).toEqual(["it's", 'fine'])
})

test('/thimble-orient: words are the brief, switches as flags or key=value, thimble\'s names read too; defaults are the Start gate\'s', () => {
  expect(ORIENT_DEFAULTS).toEqual({ deck: true, views: true, critique: true, report: true })
  expect(parseOrientArgs('')).toEqual({ opts: { brief: '', deck: true, views: true, critique: true, report: true } })
  expect(parseOrientArgs('the moderators --no-views report=off')).toEqual({ opts: { brief: 'the moderators', deck: true, views: false, critique: true, report: false } })
  expect(parseOrientArgs('focus="who reverts edits" -no-deck critique=no')).toEqual({ opts: { brief: 'who reverts edits', deck: false, views: true, critique: false, report: true } })
  expect(parseOrientArgs('--final_notebook=false --propose-views=0 --generate_report')).toEqual({ opts: { brief: '', deck: false, views: false, critique: true, report: true } })
  expect(parseOrientArgs('pages where 3 > 2, mostly')).toMatchObject({ opts: { brief: 'pages where 3 > 2, mostly' } })
  const bad = parseOrientArgs('the moderators --fast')
  expect(bad).toEqual({ error: 'unknown option --fast. /thimble-orient takes brief (or plain words: what to focus on), deck, views, critique, report (each on or off: deck=off, --no-deck, --report)' })
  expect(parseOrientArgs('status=deleted')).toMatchObject({ error: expect.stringContaining('unknown option status=deleted') })
  expect(parseOrientArgs('deck=maybe')).toMatchObject({ error: expect.stringContaining('deck=maybe: deck is on or off') })
  expect(parseOrientArgs('--no-deck=on')).toMatchObject({ error: expect.stringContaining('write --no-deck or deck=off') })
  expect(orientLine({ brief: '', ...ORIENT_DEFAULTS, report: false })).toBe('the whole corpus · deck on · views on · critique on · report off')
  // the tool: the same names, thimble's start_orientation names as aliases
  expect(orientOptsOf({ brief: ' edits ', final_notebook: false, propose_views: true })).toEqual({ opts: { brief: 'edits', deck: false, views: true, critique: true, report: true } })
  // the keys tool.call carries beside the tool's arguments are not arguments
  expect(orientOptsOf({ tool: 'mcp__thimble-cc-mod__orient', tool_use_id: 'toolu_1', consent: 'x', agentId: undefined, brief: 'b', report: false })).toEqual({ opts: { brief: 'b', deck: true, views: true, critique: true, report: false } })
  expect(orientOptsOf({ colour: 'red' })).toEqual({ error: 'unknown argument colour; the orient tool takes brief, deck, views, critique and report' })
})

test('/thimble-label: list, open, a definition from words and options, its aliases, and refusals', () => {
  expect(parseLabelArgs('')).toEqual({ op: 'list' })
  expect(parseLabelArgs('list')).toEqual({ op: 'list' })
  expect(parseLabelArgs('open asks for a refund')).toEqual({ op: 'open', name: 'asks for a refund' })
  expect(parseLabelArgs('open')).toMatchObject({ error: expect.stringContaining('open which label') })
  expect(parseLabelArgs('asks for a refund kind=prompt definition="The customer asks for money back." paths=tickets/*.jsonl,mail.jsonl values="refund, other" field=body limit=30')).toEqual({
    op: 'run',
    all: false,
    input: { name: 'asks for a refund', kind: 'prompt', definition: 'The customer asks for money back.', paths: ['tickets/*.jsonl', 'mail.jsonl'], values: ['refund', 'other'], field: 'body', limit: 30 },
  })
  // regex= gives the kind and the definition; files and trial are paths and limit; within as label=value
  expect(parseLabelArgs('reverts regex="^Revert" files="a.jsonl b.jsonl" --trial within="is an edit=yes"')).toEqual({
    op: 'run',
    all: false,
    input: { name: 'reverts', kind: 'regex', definition: '^Revert', paths: ['a.jsonl', 'b.jsonl'], limit: 30, within: { label: 'is an edit', value: 'yes' } },
  })
  expect(parseLabelArgs('name="x y" --code definition="def label(u): return (\'yes\', 1)" --all')).toMatchObject({ op: 'run', all: true, input: { name: 'x y', kind: 'code' } })
  expect(parseLabelArgs('reverts trial=10')).toEqual({ op: 'run', all: false, input: { name: 'reverts', limit: 10 } })
  expect(parseLabelArgs('reverts colour=red')).toMatchObject({ error: expect.stringMatching(/^unknown option colour=red\. \/thimble-label takes a name, kind \(prompt, regex or code\), definition, values, paths, field, within/) })
  expect(parseLabelArgs('kind=regex definition=x')).toMatchObject({ error: expect.stringContaining('name the label') })
  expect(parseLabelArgs('a name=b')).toMatchObject({ error: 'the label\'s name twice: "a" and name="b"' })
  expect(parseLabelArgs('a trial=0.5')).toMatchObject({ error: expect.stringContaining('a trial is a number of records') })
  expect(parseLabelArgs('a limit=5 --all')).toMatchObject({ error: 'both a trial size and --all: give one' })
  expect(withinOf('replies')).toEqual({ label: 'replies' })
  expect(withinOf('kind of edit:link fix')).toEqual({ label: 'kind of edit', value: 'link fix' })
  expect(labelLine({ name: 'reverts', kind: 'regex', definition: '^Revert', paths: ['a.jsonl'], values: ['yes', 'no'], within: { label: 'is an edit', value: 'yes' }, limit: 30 })).toBe('label "reverts" · regex · "^Revert" · a.jsonl · values yes, no · within "is an edit" = yes · trial of 30 records')
  expect(labelInputOf({ name: 'n', files: 'a.jsonl, b.jsonl', trial: 12, within: 'x=y', values: 'a|b' })).toEqual({ name: 'n', paths: ['a.jsonl', 'b.jsonl'], limit: 12, within: { label: 'x', value: 'y' }, values: ['a', 'b'] })
})
