The parts of the workspace that thimble's context engine (backend/app/context.py) renders for the agents that need them, the writer's and a check's first message, and the card check's reading of a card. Each `## ` section is one part, sent under its heading when the caller asks for it, with its slot filled. This paragraph is not sent.

## The conversation

The analyst's whole conversation with their Claude Code session, in order, where `[analyst]` is a message they typed or pasted, a paste indented under a `(pasted)` line, `[event …]` something they did in thimble or a notice from thimble, `[session]` a reply, `[session calls …]` or `[thread … calls …]` a call of the session or of a side thread followed by its `[result]` or `[error]`, which the analyst saw only if they opened the call, and `[notification]` what a background agent returned.

{{conversation}}

## The conversation in brief

The analyst's conversation with their Claude Code session, turn by turn: what started each turn (`[analyst]` a message they typed or pasted, `[event …]` something they did in thimble or a notice from thimble, `[notification]` what a background agent returned), the session's answer as the analyst read it under `[session]`, and under `cards:` the cards the turn made or changed, each with its ref, kind, question and takeaway. The session's calls and their results are left out here, so what an answer rests on is in its cards and in what it cites. `read_ref` reads a card whole.

{{brief}}

## The threads

Every side thread the analyst opened by pointing at something in thimble, with what they pointed at, their questions, the calls the thread made and the replies they read.

{{threads}}

## The session

The work of the session that made the card, in order, the messages it was sent, its replies, and each tool call with its arguments and the start of its result.

{{session}}

## The cards

Every card by group with its kind, question and takeaway, where `locked` marks a card the analyst locked, which no tool can change.

{{canvas}}

## The views

The views written for this corpus, each with the files it opens and what the analyst sees in it, then the views proposed and not built yet.

{{views}}

## The documents

Each document under its ref, with everything the analyst wrote in it if it is not written yet, or, if it is written, its open comments and the blocks the analyst locked, with the ids of the paragraphs around them, which thimble keeps word for word in place in every version.

{{documents}}

## What the answer rests on

What the session did in the turn of the answer you check: each call it made, with its arguments and the start of its result (`[result]`, or `[error]`), in order, and then the cards and files the answer cites. These are the records the answer rests on.

{{evidence}}

## Heads-ups already given

The heads-ups the Heads up check already gave in this workspace, on Claude's answers, the documents and the cards, oldest first, each with the passage it is on. The analyst has read them, so give no heads-up again for a detail one of these already names.

{{heads}}

## Terms already explained

The terms the Explainers check already explained in this workspace, on Claude's answers, the documents and the cards, oldest first, each as its comment's text. The analyst has read these explanations, so explain none of these terms again.

{{glossed}}

## Your task

{{task}}
