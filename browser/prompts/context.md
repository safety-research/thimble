This file holds the parts of the workspace that thimble's context engine (backend/app/context.py) renders for the agents that need them: the writer's first message, a check's first message, and the card check's reading of a card. Each `## ` section is one part. The engine sends a part under its heading when the caller asks for it, with its slot filled. This paragraph is not sent.

## The conversation

The analyst's whole conversation with their Claude Code session, in order. Its entries are:

- `[analyst]`: a message that the analyst typed or pasted. A paste is indented under a `(pasted)` line.
- `[event …]`: something the analyst did in thimble, or a notice from thimble.
- `[session]`: a reply of the session.
- `[session calls …]` or `[thread … calls …]`: a call of the session or of a side thread. Its `[result]` or `[error]` follows it. The analyst saw the call and its result only if they opened the call.
- `[notification]`: what a background agent returned.

{{conversation}}

## The conversation in brief

The analyst's conversation with their Claude Code session, turn by turn. Each turn shows what started it:

- `[analyst]`: a message that the analyst typed or pasted.
- `[event …]`: something the analyst did in thimble, or a notice from thimble.
- `[notification]`: what a background agent returned.

Under `[session]` is the session's answer as the analyst read it. Under `cards:` are the cards that the turn made or changed, each with its ref, kind, question and takeaway. The session's calls and their results are left out here. So what an answer rests on is in its cards and in what it cites. `read_ref` reads a card whole.

{{brief}}

## The threads

Every side thread that the analyst opened by pointing at something in thimble. Each thread shows what the analyst pointed at, their questions, the calls the thread made, and the replies they read.

{{threads}}

## The session

The work of the session that made the card, in order: the messages it was sent, its replies, and each tool call with its arguments and the start of its result.

{{session}}

## The cards

Every card, by group, with its kind, question and takeaway. `locked` marks a card that the analyst locked. No tool can change a locked card.

{{canvas}}

## The views

The views written for this corpus, each with the files it opens and what the analyst sees in it. Then the views that were proposed and are not built yet.

{{views}}

## The documents

Each document under its ref. A document that is not written yet shows everything the analyst wrote in it. A written document shows its open comments and the blocks the analyst locked, with the ids of the paragraphs around those blocks. thimble keeps a locked block word for word, in its place, in every version.

{{documents}}

## What the answer rests on

What the session did in the turn of the answer that you check. First comes each call it made, in order, with its arguments and the start of its result (`[result]`, or `[error]`). Then come the cards and files that the answer cites.

{{evidence}}

## Heads-ups already given

The heads-ups that the Heads up check already gave in this workspace, on Claude's answers, the documents and the cards. They are oldest first, each with the passage it is on. The analyst has read them. So do not give a heads-up again for a detail that one of these already names.

{{heads}}

## Terms already explained

The terms that the Explainers check already explained in this workspace, on Claude's answers, the documents and the cards. They are oldest first, each as its comment's text. The analyst has read these explanations. So do not explain any of these terms again.

{{glossed}}

## Your task

{{task}}
