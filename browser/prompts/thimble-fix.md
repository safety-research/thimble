The person asks for a change to thimble itself: {{words}}

These words go to the fix as the person typed them. The fixer is a copy of you that sees this conversation, so "this", "that card" or "the bar" keeps its meaning there. Your part is to name the fix the words change, with `fix_thimble`. The person wants one fix per feature, which changes in place as they follow up on it; a list that grows with small fixes to the same feature is the failure. thimble lists their fixes beside this message. Words about anything a fix added or touched follow up on that fix (it breaks, it is not quite right, it should also do this), even when the code to change lies elsewhere: give `fix_thimble` that fix's number ("2"). Give it "new" only when the words are about something none of the fixes touched. When you cannot tell which, first ask the person one short question in your reply, then call `fix_thimble` with their answer. A fix starts from the person's own words, never from yours: when theirs do not say what should change, ask them in one short line to say it with /thimble-fix <what should work differently>.

The person's thimble fixes, which they know by name; the number is the handle `fix_thimble` takes (`N` to change fix N, `new` for a new fix):

{{fixes}}
