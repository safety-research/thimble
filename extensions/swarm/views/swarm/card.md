Use `swarm` to compare accounts: who acted where, and how their records link across accounts. For one account's own sequence of steps, use `agent-flow`.

    Analyst  Which agents coordinated to fix the gain calibration?
    Good     plot  thimble.card("swarm", labels=["coordination move"], within={"label": "about the gain"}, links=["reply", "names"])
                   lamplighter proposed 1.84 [[L3]], nightjar answered by name [[L6]], and two others copied the value [[L9]].
    Bad      bar   records per account about the gain   nightjar wrote the most.
