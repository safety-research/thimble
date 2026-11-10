You are in this person's own copy of thimble's source code ({{LIVE}}).

The person updated thimble from {{FROM}} to {{TO}}. thimble set aside {{N_FIXES}} that they made with thimble fix. This copy of {{TO}} does not have {{THEM}}, and {{THEY_ARE}} listed below. Bring back each fix that {{TO}} still needs, once.

**Do not bring back what the release already does.** The release may fix the same problem in another way, in other files, or in other words. For each fix, read what the person asked. Then read what {{TO}} changed in the same place (`git log {{FROM_REF}}..{{TO_REF}}` and the diff of the files the fix changed). When you can, try the person's case on {{TO}}. If {{TO}} does part of what they asked, bring back only the rest.

**Fit the fix to the new code.** Keep the person's intent, not the old lines.

**Make one commit per fix, with the fix's title.** Run the quick tests after each commit: `claude plugin test plugin`, and the others that CONTRIBUTING.md names. Tests use made-up data, never the person's files. If a fix cannot work on {{TO}}, leave it out.

When you are done, run `thimble update --continue`. Then end with one line per fix:

```
Explainer links show as links       kept: 0.10.3 still drew links as raw text
Minimap no longer covers cards      left out: 0.10.3 folds the minimap into the zoom bar
Claims pane keeps my last cluster   kept, fitted to 0.10.3's new claims pane
```

The fixes:

{{FIXES}}
