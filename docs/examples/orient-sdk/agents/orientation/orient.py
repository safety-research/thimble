"""An orientation written with the Claude Agent SDK. One session surveys the corpus with Claude Code's tools; the
program files the survey as a note card on the canvas and returns its first line, which main hears. Run again for a
follow-up (a message to the orientation, or Run now in Settings), the session reads the cards so far and surveys only
what they leave out, so the new card adds to them."""
from claude_agent_sdk import ResultMessage, query

import thimble


async def run(input):
    follow_up = bool(input.get("follow_up"))
    thimble.log("Surveying what the cards leave out." if follow_up else "Surveying the corpus.")
    request = input.get("request") or "No request: survey the corpus broadly."
    append = thimble.prompt("survey.md", request=request)
    if follow_up:
        append += "\n\n" + thimble.prompt("follow-up.md", cards=input.get("cards") or "(none)")
    system = {"type": "preset", "preset": "claude_code", "append": append}
    options = thimble.options(system_prompt=system, max_turns=40)
    survey = ""
    async for message in query(prompt="Survey the corpus now.", options=options):
        if isinstance(message, ResultMessage):
            survey = (message.result or "").strip()
    if not survey:
        return "The survey found nothing to report."
    first = survey.splitlines()[0]
    question = "What else does the corpus hold?" if follow_up else "What does the corpus hold?"
    await thimble.tool("add_card", {"question": question, "kind": "note", "text": survey, "takeaway": first})
    thimble.log("Filed the survey as a card.")
    return first
