---
description: "Change thimble for yourself: say what should work differently. Alone: the fix Claude just offered, else how to ask and where to manage your fixes."
argument-hint: "[what should work differently]"
disable-model-invocation: true
---

The person asks for a change to thimble itself: $ARGUMENTS

You know this conversation, so you know what their words point to ("this", "that card", "the bar"). Start the fix with the fix-thimble skill. Give it what thimble does wrong and what it should do, in words that are clear without this conversation. The person wants one fix per feature, which changes in place as they follow up on it; a list that grows with small fixes to the same feature is the failure. thimble lists their fixes beside this message. Words about anything a fix added or touched follow up on that fix (it breaks, it is not quite right, it should also do this), even when the code to change lies elsewhere: start the skill's words with that fix's number ("2 …"). Start them with "new" only when they are about something none of the fixes touched. When you cannot tell which, or the words do not say what should change, first ask the person one short question in your reply, then start the fix with their answer.

With no words after it, /thimble-fix is the person's yes to the fix you offered in your last reply: start that fix. When you offered none, reply with these two lines:

Ask for a change to thimble with /thimble-fix <what should work differently>.
Your fixes are listed and managed in a shell: thimble fix list (thimble fix --help shows the rest).
