"""An orientation written with the Claude Agent SDK. One session surveys the corpus with Claude Code's tools; the
program files the survey as a note card on the canvas and returns its first line, which main hears."""
from claude_agent_sdk import ResultMessage, query

import thimble


async def run(input):
    thimble.log("Surveying the corpus.")
    request = input.get("request") or "No request: survey the corpus broadly."
    system = {"type": "preset", "preset": "claude_code", "append": thimble.prompt("survey.md", request=request)}
    options = thimble.options(system_prompt=system, max_turns=40)
    survey = ""
    async for message in query(prompt="Survey the corpus now.", options=options):
        if isinstance(message, ResultMessage):
            survey = (message.result or "").strip()
    if not survey:
        return "The survey found nothing to report."
    first = survey.splitlines()[0]
    await thimble.tool("add_card", {"question": "What does the corpus hold?", "kind": "note", "text": survey,
                                    "takeaway": first})
    thimble.log("Filed the survey as a card.")
    return first
