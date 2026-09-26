# Threads: a message board read as threads. Each line of board.jsonl is one post, with its `thread_id`, the thread's
# `thread_title`, its `author`, its `created_at` and its `body`.
#
# What the view is for: the file holds the posts in the order they were written, so a proposal and the replies it got
# lie far apart between other threads' posts. Read as threads, the analyst sees every conversation of the board at
# once, how big each one is and when it ran, and reads one conversation from start to end.
#
# How the reader works: the index keeps, per thread, its posts in time order with each one's line, and the file's byte
# offsets, so a post is read back by seeking to its line instead of holding every body in memory.
import json
import re

EXCERPT_CHARS = 1500  # of a post, cut at a line boundary
PAGE_POSTS = 60  # posts one fetch of a thread returns
# The overview lists every thread, largest first, since the biggest conversations are where most happened. A board
# of thousands of threads is narrowed by the search box rather than scrolled, so the list stops at LIST_THREADS and
# says how many there are in all.
LIST_THREADS = 300


def build_index(paths):
    """{path: {"offsets": [byte offset of line n at n-1], "threads": {thread: [post, ...]}, "titles": {thread: title},
    "line": {n: [thread, i]}}} where a post is [line, created_at, author]. A thread's key is its thread_id as text; a
    line that is not a post of a thread (no thread_id, or not JSON) is left out."""
    index = {}
    for path in paths:
        offsets, threads, titles, where = [], {}, {}, {}
        with open(path, "rb") as f:
            pos = 0
            for n, raw in enumerate(f, 1):
                offsets.append(pos)
                pos += len(raw)
                try:
                    r = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(r, dict) or r.get("thread_id") in (None, ""):
                    continue
                key = str(r["thread_id"])
                threads.setdefault(key, []).append([n, r.get("created_at") or "", r.get("author") or ""])
                if r.get("thread_title") and key not in titles:
                    titles[key] = r["thread_title"]
        for key, posts in threads.items():
            posts.sort(key=lambda p: (p[1], p[0]))
            for i, post in enumerate(posts):
                where[post[0]] = [key, i]
        index[path] = {"offsets": offsets, "threads": threads, "titles": titles, "line": where}
    return index


def _record(path, data, line):
    """Line `line` of the file, parsed, read at its byte offset (data is the file's entry of the index)."""
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
    """An ISO 8601 time as day, month and minute, such as 30 Aug 14:06."""
    months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)", t or "")
    return f"{int(m.group(3))} {months[int(m.group(2)) - 1]} {m.group(4)}:{m.group(5)}" if m else (t or "")


def _title(data, key):
    return data["titles"].get(key) or f"thread {key}"


def _post(path, data, post):
    line, time, author = post
    body = (_record(path, data, line).get("body") or "").strip("\n")
    return {"ref": f"{path}#L{line}", "line": line, "time": time, "when": _when(time), "author": author, "text": body}


def _thread_summary(path, data, key):
    posts = data["threads"][key]
    return {"key": key, "title": _title(data, key), "posts": len(posts), "first": posts[0][1], "last": posts[-1][1],
            "path": path}


def records(index, query):
    """{op: threads, q?, limit?} lists the threads, most posts first, filtered by `q` in the title; {op: thread, key,
    around?, before?} gives one thread's posts, PAGE_POSTS at a time: the ones ending a little after line `around` (or
    the latest), or the ones before the post at index `before`."""
    query = query or {}
    if query.get("op") == "thread":
        key = str(query.get("key"))
        for path, data in index.items():
            posts = data["threads"].get(key)
            if posts is None:
                continue
            end = len(posts)
            if query.get("before") is not None:
                end = max(0, int(query["before"]))
            elif query.get("around") is not None and int(query["around"]) in data["line"]:
                end = min(len(posts), data["line"][int(query["around"])][1] + 1 + PAGE_POSTS // 4)
            start = max(0, end - PAGE_POSTS)
            return {**_thread_summary(path, data, key), "start": start,
                    "items": [_post(path, data, p) for p in posts[start:end]]}
        return None
    q = str(query.get("q") or "").lower()
    rows = [_thread_summary(path, data, key) for path, data in index.items() for key in data["threads"]
            if q in _title(data, key).lower()]
    rows.sort(key=lambda t: (-t["posts"], t["first"]))
    limit = int(query.get("limit") or LIST_THREADS)
    return {"total": len(rows), "threads": rows[:limit]}


def resolve(index, locator):
    """board.jsonl#L<n>: the post on that line. view:<slug>/<thread_id>: the thread, its excerpt the title and the
    opening post, citing every post of the thread in time order."""
    if "key" in locator:
        key = str(locator["key"])
        for path, data in index.items():
            posts = data["threads"].get(key)
            if not posts:
                continue
            first = _post(path, data, posts[0])
            title = _title(data, key)
            excerpt = "\n".join(x for x in (data["titles"].get(key), first["text"]) if x)
            return {"excerpt": _cut(excerpt), "label": f"{title[:24]} · {len(posts)} posts",
                    "refs": [f"{path}#L{p[0]}" for p in posts], "key": key, "target": {"thread": key}}
        return None
    path, fragment = locator.get("path"), str(locator.get("fragment") or "")
    data = index.get(path)
    m = re.fullmatch(r"L(\d+)", fragment)
    if data is None or not m or int(m.group(1)) not in data["line"]:
        return None
    line = int(m.group(1))
    key, i = data["line"][line]
    post = _post(path, data, data["threads"][key][i])
    # a post with no body still has its thread, so the thread's title stands in as its text
    text = post["text"] or data["titles"].get(key) or ""
    return {"excerpt": _cut(text), "label": f"{(post['author'] or 'no author')[:24]} · {post['when']}",
            "refs": [f"{path}#L{line}"], "key": key, "target": {"thread": key, "line": line}}
