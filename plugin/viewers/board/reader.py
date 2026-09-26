# Forum: a community garden's message board read as topics.
#
# The data (sample/forum.jsonl): one line is one post, and the file holds the posts in the order they were written.
#   id        the post's id
#   topic     the id of the topic the post belongs to
#   title     the topic's title, on its first post only
#   author    the member who wrote it
#   posted    when, ISO 8601
#   reply_to  the id of the post it answers, on replies only
#   text      the post's body, with its own line breaks
# Posts with the same `topic` are one thread, read in `posted` order; `reply_to` points at an earlier post of it.
#
# The method: the posts of a thread lie far apart in the file, between other threads' posts, so the reader gathers
# them: the index keeps, per topic, its posts in time order with each one's line, and the byte offset of every line,
# so a post is read back by seeking to its line rather than holding every body in memory.
#
# Labels: they apply when records are served, never in the index. The list keeps only the topics with a post the
# filter keeps (thimble.kept) and counts only those posts, and a topic shows only its kept posts. Each topic counts the
# posts the first label that is on marks (thimble.marked), so the list shows where they are before a topic is opened.
import json
import re

import thimble

EXCERPT_CHARS = 1500  # of a post, cut at a line boundary
PAGE_POSTS = 60  # posts one fetch of a topic returns
LIST_TOPICS = 300  # topics the list shows; a larger board is narrowed by the search


def build_index(paths):
    """{path: {"offsets": [byte offset of line n at n-1], "topics": {topic: [post, ...]}, "titles": {topic: title},
    "line": {n: [topic, i]}, "ids": {post id: line}}}, a post being [line, posted, author]. A line that is not a post of
    a topic (no topic, or not JSON) is left out."""
    index = {}
    for path in paths:
        offsets, topics, titles, where, ids = [], {}, {}, {}, {}
        with open(path, "rb") as f:
            pos = 0
            for n, raw in enumerate(f, 1):
                offsets.append(pos)
                pos += len(raw)
                try:
                    r = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(r, dict) or r.get("topic") in (None, ""):
                    continue
                key = str(r["topic"])
                topics.setdefault(key, []).append([n, str(r.get("posted") or ""), str(r.get("author") or "")])
                if r.get("title") and key not in titles:
                    titles[key] = str(r["title"])
                if r.get("id") not in (None, ""):
                    ids[str(r["id"])] = n
        for key, posts in topics.items():
            posts.sort(key=lambda p: (p[1], p[0]))
            for i, post in enumerate(posts):
                where[post[0]] = [key, i]
        index[path] = {"offsets": offsets, "topics": topics, "titles": titles, "line": where, "ids": ids}
    return index


def _record(path, data, line):
    with open(path, "rb") as f:
        f.seek(data["offsets"][line - 1])
        return json.loads(f.readline())


def _cut(text, limit=EXCERPT_CHARS):
    """The text up to `limit` characters, cut after a whole line so every line kept is the source's own."""
    if len(text) <= limit:
        return text
    kept, size = [], 0
    for ln in text.split("\n"):
        if size + len(ln) + 1 > limit and kept:
            break
        kept.append(ln)
        size += len(ln) + 1
    return "\n".join(kept)


def _when(t):
    """An ISO 8601 time as day, month and minute, such as 3 Apr 17:40."""
    months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)", t or "")
    return f"{int(m.group(3))} {months[int(m.group(2)) - 1]} {m.group(4)}:{m.group(5)}" if m else (t or "")


def _title(data, key):
    return data["titles"].get(key) or f"topic {key}"


def _post(path, data, post):
    """A post as the page shows it; `reply` names the post it answers when that post is in the file."""
    line, posted, author = post
    r = _record(path, data, line)
    parent = data["ids"].get(str(r.get("reply_to") or ""))
    reply = None
    if parent is not None and parent in data["line"]:
        key, i = data["line"][parent]
        reply = {"ref": f"{path}#L{parent}", "author": data["topics"][key][i][2]}
    return {"ref": f"{path}#L{line}", "line": line, "when": _when(posted), "author": author,
            "text": str(r.get("text") or "").strip("\n"), "reply": reply}


def _kept(path, posts, cited=None):
    """The posts the label filter keeps, and the cited line's post whatever the filter, since a citation asked for it."""
    return [p for p in posts if p[0] == cited or thimble.kept(f"{path}#L{p[0]}")]


def _summary(path, data, key, posts):
    marked = sum(1 for p in posts if thimble.marked(f"{path}#L{p[0]}"))
    return {"key": key, "title": _title(data, key), "posts": len(posts), "marked": marked,
            "first": posts[0][1] if posts else "", "last": posts[-1][1] if posts else ""}


def records(index, query):
    """{op: topics, q?, sort?, limit?}: the topics with a kept post whose title holds `q`, most posts first, or latest
    first with sort "latest". {op: topic, key, start?, around?}: one topic's kept posts in time order, PAGE_POSTS from
    index `start`, or from a little before the post on line `around`."""
    query = query or {}
    if query.get("op") == "topic":
        key = str(query.get("key"))
        around = int(query["around"]) if query.get("around") is not None else None
        for path, data in index.items():
            posts = data["topics"].get(key)
            if posts is None:
                continue
            posts = _kept(path, posts, around)
            start = max(0, int(query.get("start") or 0))
            if around is not None:
                at = next((i for i, p in enumerate(posts) if p[0] == around), 0)
                start = max(0, at - PAGE_POSTS // 4) if at >= PAGE_POSTS else 0
            page = posts[start:start + PAGE_POSTS]
            return {**_summary(path, data, key, posts), "start": start,
                    "items": [_post(path, data, p) for p in page]}
        return None
    q = str(query.get("q") or "").lower()
    rows = []
    for path, data in index.items():
        for key, posts in data["topics"].items():
            if q in _title(data, key).lower() and (kept := _kept(path, posts)):
                rows.append(_summary(path, data, key, kept))
    if query.get("sort") == "latest":
        rows.sort(key=lambda t: t["last"], reverse=True)
    else:
        rows.sort(key=lambda t: (-t["posts"], t["first"]))
    return {"total": len(rows), "topics": rows[:int(query.get("limit") or LIST_TOPICS)]}


def resolve(index, locator):
    """forum.jsonl#L<n>: the post on that line, in its topic. view:<slug>/<topic>: the topic, its excerpt the title
    and the first post, citing every post in time order."""
    if "key" in locator:
        key = str(locator["key"])
        for path, data in index.items():
            posts = data["topics"].get(key)
            if not posts:
                continue
            first = _post(path, data, posts[0])
            title = _title(data, key)
            excerpt = "\n".join(x for x in (data["titles"].get(key), first["text"]) if x)
            return {"excerpt": _cut(excerpt), "label": f"{title[:24]} · {len(posts)} posts",
                    "refs": [f"{path}#L{p[0]}" for p in posts], "key": key, "target": {"topic": key}}
        return None
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    data = index.get(path)
    m = re.fullmatch(r"L(\d+)", fragment)
    if data is None or not m or int(m.group(1)) not in data["line"]:
        return None
    line = int(m.group(1))
    key, i = data["line"][line]
    post = _post(path, data, data["topics"][key][i])
    # a post with no text still belongs to its topic, whose title stands in as its text
    text = post["text"] or data["titles"].get(key) or ""
    return {"excerpt": _cut(text), "label": f"{(post['author'] or 'no author')[:24]} · {post['when']}",
            "refs": [f"{path}#L{line}"], "key": key, "target": {"topic": key, "line": line}}
