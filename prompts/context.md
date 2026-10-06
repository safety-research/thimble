The parts of the workspace that thimble's context engine (backend/app/context.py) renders for the agents that need them, the writer's and a check's first message, a critique's, and the card check's reading of a card. Each `## ` section is one part, sent under its heading when the caller asks for it, with its slot filled. This paragraph is not sent.

## The conversation

The analyst's whole conversation with their Claude Code session, in order, where `[analyst]` is a message they typed, `[event …]` something they did in thimble or a notice from thimble, `[session]` a reply, `[session calls …]` or `[thread … calls …]` a call of the session or of a side thread followed by its `[result]` or `[error]`, which the analyst saw only if they opened the call, and `[notification]` what a background agent returned.

{{conversation}}

## The threads

Every side thread the analyst opened by pointing at something in thimble, with what they pointed at, their questions, the calls the thread made and the replies they read.

{{threads}}

## The orientation

The latest orientation's working behind its cards, what it and its agents wrote and each call they made under its ref with its input and the start of its output, which read_ref reads whole and which you cite only for a claim no card shows, such as a count or a search that found nothing, since a card shows the reader the evidence at a glance.

{{orientation}}

## The session

The work of the session that made the card, in order, the messages it was sent, its replies, and each tool call with its arguments and the start of its result.

{{session}}

## The cards

Every card by group with its kind, question and takeaway, where `locked` marks a card the analyst locked, which no tool can change, and the `Orientation` group, if an orientation ran, holds its findings in the order it presents them.

{{canvas}}

## The views

The views written for this corpus, each with the files it opens and what the analyst sees in it, then the views proposed and not built yet.

{{views}}

## The documents

Each document under its ref, with everything the analyst wrote in it if it is not written yet, or, if it is written, its open comments and the blocks the analyst locked, with the ids of the paragraphs around them, which thimble keeps word for word in place in every version.

{{documents}}

## Your task

{{task}}
