---
name: fix-thimble
description: Start the fix the person asks for with /thimble-fix. A copy of you changes thimble in the background, from their words as they typed them, and the person decides with a key whether to use the fix. The argument names the fix their words change, `N` for their fix N or `new` for a new one. thimble is the person's own tool, so when it misbehaves in this session, such as a card, a citation's evidence, a pane, the bar or a key of thimble's that draws or acts wrong, you may tell them that /thimble-fix <what should work differently> asks for a fix.
argument-hint: "N | new"
user-invocable: false
---

The fix the person's words change: $ARGUMENTS

thimble starts its fix when Claude calls this skill, and answers with what came of it in place of this text. You read this text, so thimble's hooks did not answer this skill in this session, and no fix started. Tell the person in one short line. Name a reason only when a notice in this session says it.
