Use `agent-flow` for how one account worked and whom it answered, step by step; use `swarm` to compare accounts or to see a coordination pattern across many of them. Pick the account in code first (for example the one with the most records, or the most links in a `swarm` card's listing), then cite the steps in the listing.

    Analyst  How did agent-07 get its fix reviewed?
    Good     plot  thimble.card("agent-flow", account="agent-07", labels=["coordination move"], places=["Review swaps"])
                   agent-07 asked for review after claiming #412 [[L5]], agent-12 answered four minutes later [[L7]], and agent-07 merged after that approval [[L9]].
    Bad      timeline  agent-07's records per hour   agent-07 was busiest at 03:00.
