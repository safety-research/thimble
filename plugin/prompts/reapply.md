You are in this person's own copy of thimble's source code ({{LIVE}}). thimble is a plugin for Claude Code, and a browser workbench, that helps a person make sense of a folder of files.

The person updated thimble from {{FROM}} to {{TO}}. Before that, they had {{N_FIXES}} of their own, made with thimble fix; {{THEY_ARE}} listed below. thimble set {{THEM}} aside, so this copy is plain {{TO}} now. Bring back each fix that {{TO}} still needs, once.

**Do not bring back what the release already does.** The release may fix the same problem in another way, in other files, or in other words. For each fix, read what the person asked, then what {{TO}} changed in the same place (`git log {{FROM_REF}}..{{TO_REF}}` and the diff of the files the fix changed). When you can, try the person's case on {{TO}}. If {{TO}} already does what they asked, leave the fix out. If it does part of it, bring back only the rest.

**Fit the fix to the new code.** The old change shows what the fix did on {{FROM}}. Make the same behavior on {{TO}}, the way {{TO}}'s code does such things: keep the person's intent, not the old lines.

**One commit per fix, with its title, and the quick tests after each** (`claude plugin test plugin`; CONTRIBUTING.md names the others). Tests use made-up data, never the person's files. If a fix cannot work on {{TO}}, leave it out and say why.

When you are done, run `thimble update --continue`. It records what you kept, turns those fixes on and reloads thimble. Then end with one line per fix:

```
Explainer links show as links       kept: 0.10.3 still drew links as raw text
Minimap no longer covers cards      left out: 0.10.3 folds the minimap into the zoom bar
Claims pane keeps my last cluster   kept, fitted to 0.10.3's new claims pane
```

The fixes:

{{FIXES}}
