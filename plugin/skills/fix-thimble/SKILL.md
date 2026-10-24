---
name: fix-thimble
description: Start a fix of thimble itself when the person asks for one, with /thimble-fix or with a yes to your offer of a fix. thimble is theirs, so when it misbehaves in this session, such as a card, a citation's evidence, a pane, the bar or a key of thimble's that draws or acts wrong, offer the fix and let them decide. The argument says what thimble does wrong and what it should do. A copy of you then changes thimble in the background, and the person decides with a key whether to use the fix.
argument-hint: "[N | new] what thimble does wrong, and what it should do"
user-invocable: false
---

What thimble does wrong, and what it should do: $ARGUMENTS

thimble starts its fix when Claude calls this skill, and answers with what came of it in place of this text. You read this text, so thimble's hooks did not answer this skill in this session, and no fix started. Tell the person in one short line. Name a reason only when a notice in this session says it.
