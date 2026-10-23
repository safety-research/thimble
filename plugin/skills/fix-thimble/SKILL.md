---
name: fix-thimble
description: Start a fix of thimble itself when thimble misbehaves in this session, such as a card, a citation's evidence, a pane, the bar or a key of thimble's that draws or acts wrong. The argument says what thimble does wrong and what it should do. A copy of you then changes thimble in the background, and the person decides with a key whether to use the fix.
argument-hint: what thimble does wrong, and what it should do
user-invocable: false
---

What thimble does wrong, and what it should do: $ARGUMENTS

thimble starts its fix when this skill runs, and puts what came of it in place of this text. You read this text because thimble did not start the fix: tell the person, in one short line, to type /thimble-fix with these words.
