# Hand-offs: agents linked by the pull requests they passed between them. Each line of events.jsonl is one call an
# agent made to the shared server, with the `agent`, the `action`, its `ts` and its `params`; the calls on a pull
# request carry its number as params.pr.
#
# What the view is for: who worked with whom is spread over hundreds of calls, one line each. Drawn as a network, the
# analyst sees at once which agents passed work between them and how often, and opens the calls behind any link.
#
# How the reader works: taken in time order per pull request, a call whose agent differs from the previous call's
# agent is a hand-off from that agent to this one, and the pair is an edge of the network. The edge keeps the lines of
# its hand-offs, so the page can open the records behind every link.
import json
import re

TOP_EDGES = 120  # edges the graph query returns, heaviest first
EDGE_RECORDS = 50  # records one edge query returns
LOOKS = ("pr.show", "pr.list")  # calls that only read a pull request, so they hand nothing on


def build_index(paths):
    """{"edges": {"a|b": [[path, line, pr, time, from, to, action], ...]}, "line": {"path#Ln": "a|b"}, "calls":
    {"path#Ln": [agent, action, time]}} with a and b the two agents in sorted order. `calls` holds every call, so a line
    that made no hand-off (a call on no pull request, a pull request's first call, an agent following itself) still
    resolves to its agent."""
    by_pr, calls = {}, {}
    for path in paths:
        with open(path, "rb") as f:
            for n, raw in enumerate(f, 1):
                try:
                    r = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(r, dict):
                    continue
                agent, action, t = r.get("agent") or "", r.get("action") or "", r.get("ts") or ""
                calls[f"{path}#L{n}"] = [agent, action, t]
                pr = (r.get("params") or {}).get("pr") if isinstance(r.get("params"), dict) else None
                if pr is not None and agent and action not in LOOKS:
                    by_pr.setdefault(pr, []).append((t, n, path, agent, action))
    edges, line = {}, {}
    for pr, pr_calls in by_pr.items():
        pr_calls.sort()
        for (_, _, _, a, _), (t, n, path, b, action) in zip(pr_calls, pr_calls[1:]):
            if a == b:
                continue
            pair = "|".join(sorted((a, b)))
            edges.setdefault(pair, []).append([path, n, pr, t, a, b, action])
            line[f"{path}#L{n}"] = pair
    return {"edges": edges, "line": line, "calls": calls}


def _degree(index):
    deg = {}
    for pair, hops in index["edges"].items():
        for agent in pair.split("|"):
            deg[agent] = deg.get(agent, 0) + len(hops)
    return deg


def records(index, query):
    """{op: graph, around?} gives the heaviest edges (those of one agent with `around`) and their nodes; {op: edge,
    pair} the hand-offs behind one edge, newest first."""
    query = query or {}
    if query.get("op") == "edge":
        hops = index["edges"].get(query.get("pair"), [])
        rows = sorted(hops, key=lambda h: h[3], reverse=True)[:EDGE_RECORDS]
        return {"pair": query.get("pair"), "total": len(hops),
                "items": [{"ref": f"{p}#L{n}", "pr": pr, "time": t, "from": a, "to": b, "action": act}
                          for p, n, pr, t, a, b, act in rows]}
    around = query.get("around")
    pairs = [(pair, len(h)) for pair, h in index["edges"].items() if not around or around in pair.split("|")]
    pairs.sort(key=lambda x: (-x[1], x[0]))
    pairs = pairs[:TOP_EDGES]
    deg = _degree(index)
    names = sorted({agent for pair, _ in pairs for agent in pair.split("|")})
    return {"nodes": [{"id": n, "weight": deg.get(n, 0)} for n in names],
            "edges": [{"pair": pair, "source": pair.split("|")[0], "target": pair.split("|")[1], "weight": w}
                      for pair, w in pairs]}


def resolve(index, locator):
    """events.jsonl#L<n>: the call on that line, with the hand-off it made when it made one; its excerpt the agent and
    the action as the record holds them. view:<slug>/<agent>: the agent, citing their calls in time order."""
    deg = _degree(index)
    if "key" in locator:
        agent = locator["key"]
        mine = sorted((call[2], ref) for ref, call in index["calls"].items() if call[0] == agent)
        if not agent or agent not in deg or not mine:
            return None
        return {"excerpt": agent, "label": f"{agent[:28]} · {deg[agent]} hand-offs", "refs": [ref for _, ref in mine][:200],
                "key": agent, "target": {"around": agent}}
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    ref = f"{path}#{fragment}"
    if not re.fullmatch(r"L\d+", fragment) or ref not in index["calls"]:
        return None
    agent, action, _ = index["calls"][ref]
    excerpt = "\n".join(x for x in (agent, action) if x)
    pair = index["line"].get(ref)
    if pair is None:
        # a call that handed nothing on opens at its agent, or at the whole network when the agent has no edge
        if not excerpt:
            return None
        key = agent if agent in deg else None
        return {"excerpt": excerpt, "label": f"{(agent or 'no agent')[:24]} · {action[:20]}", "refs": [ref], "key": key,
                "target": {"around": agent} if key else {}}
    hop = next(h for h in index["edges"][pair] if f"{h[0]}#L{h[1]}" == ref)
    return {"excerpt": excerpt, "label": f"{hop[4][:16]} → {hop[5][:16]}", "refs": [ref], "key": hop[5],
            "target": {"around": hop[5], "pair": pair, "ref": ref}}
