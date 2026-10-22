"""The deterministic check of a checker's answer: no model call, no code run. Standard library only, so the browser can
import it too.

A reply marks its claims as `[words](#)`. After the reply, the checker (a fork of the session, prompts/checker.md) gives
one answer per mark: a status (`verified`, `corrected`, `failed`), the evidence, and for a correction the new words.
check_mark() decides what the person sees of that mark; its result wins over the checker's status:

  computed  the evidence is code. One of the real calls of the session (the checker's or main's Bash calls, as the
            transcript stored their output) ran that code: the call's command holds the code's lines, in order. That
            call's output shows the marked words (or the corrected words): the words whole, the same words with number
            words as digits ("five" is 5), each quoted part of the words, or every number of the words, each a whole number of the output (a 3 never
            matches inside 2,301). The code does not type in a number of the words where it can be the printed value
            (assigned, printed or returned; a bound in a comparison or an argument of another call is a condition). The
            check reads the output the call really printed, never the output the checker wrote down.
  quote     the file is inside the working folder (or the folder the session started in), the line (or a range of at most 50 lines) exists, and the substring
  code      is in it: in the raw line or in the line's JSON strings decoded, runs of white space as one space (or as
            none: JSON written with no space after its colons), and `**` and backticks as formatting. The quoted words of a direct quote, and the numbers of the words, are in
            the cited lines too. Big files are read line by line.

A number with a scale (8k) matches the values it rounds from; a number inside a date matches only a number of the
words' own dates. A cited line a few lines off from the one that holds the words is moved to it.

A mark the checker verified or corrected whose evidence does not hold here fails, with the reason; a correction whose
evidence shows the marked words instead leaves them verified. A mark the checker failed keeps its reason. A mark with
no answer stays unchecked.

  check_mark(mark, item, calls, cwd, root)  -> {n, status, shown, reason, failedBy?, evidence?}
  parse_answer(text)                  -> the last ```json array of the checker's answer, or None
"""
from __future__ import annotations

import ast
import io
import json
import math
import os
import re
import tokenize
from typing import Any

MONTHS = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
DATE_PARTS = [re.compile(p) for p in (
    r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?\b",
    rf"\b\d{{1,2}}\s+{MONTHS}\b(?:,?\s+\d{{4}})?",
    rf"\b{MONTHS}\.?\s+\d{{1,2}}\b(?:,?\s+\d{{4}})?",
    rf"\b{MONTHS}\s+\d{{4}}\b",
    r"\b\d{4}-\d{2}\b(?!-\d)",
    r"\b\d{1,2}:\d{2}(?::\d{2})?\b",
)]
# A number as written: its digits, with `,` or `_` between groups (1,714 and 4_000), then a scale (8k, 1.2M, 3bn,
# 6.5 billion), or
# an ordinal ending (3rd), which names a place in an order, not a value. In the marked words and in code a number right
# after a letter or a `.` is part of a name or of another number; in an output or a file's line it may follow a letter
# (`T14:29`).
NUM = re.compile(r"(?<![\w.])[-−]?\$?(\d[\d,_]*(?:\.\d+)?)(?:(st|nd|rd|th)\b|([kKMB]|bn|\sthousand|\smillion|\sbillion)\b)?")
NUM_IN_TEXT = re.compile(r"(?<![\d.])[-−]?\$?(\d[\d,_]*(?:\.\d+)?)(?:(st|nd|rd|th)\b|([kKMB]|bn|\sthousand|\smillion|\sbillion)\b)?")
SCALE = {"k": 1e3, "m": 1e6, "b": 1e9}
SCALE_OF = {"k": "k", "K": "k", "M": "m", "B": "b", "bn": "b", "thousand": "k", "million": "m", "billion": "b"}
NAME = re.compile(r"#\d+\b|\b[A-Za-z][\w]*[-_]\d+\b")
QUOTE_CHARS = "\"“”'‘’"
WORDNUM = {w: str(i) for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
    "eighteen nineteen twenty".split())}
PRINTERS = {"print", "str", "format", "repr", "f"}
MAX_RANGE = 50
SHIFT_MAX = 5  # lines a cited line may be off by and still name the line that holds the words
OUTPUT_MAX = 20000  # characters of a call's output the evidence keeps, around its first highlight
LINE_MAX = 600  # characters of a cited line the evidence keeps, around its highlight
CONTEXT_MAX = 160  # characters of a line around the cited ones


# ------------------------------------------------------------------------------------------------ words and numbers

def norm_ws(s: Any) -> str:
    return " ".join(str(s).split())


def unmark(s: Any) -> str:
    """Markdown emphasis and code marks are formatting, not words."""
    return norm_ws(str(s).replace("**", "").replace("`", ""))


def num_value(tok: str, scale: str | None = None) -> str:
    """A number token as one form: 1,714 and 4_000 are 1714 and 4000, 6.0 is 6, $40 is 40; with a scale, the digits
    and the scale's letter (`8k`; `1.2M` and `1.2 million` are `1.2m`)."""
    t = tok.replace(",", "").replace("_", "").replace("$", "").replace("−", "-")
    try:
        v = float(t)
    except ValueError:
        return t
    one = str(int(v)) if v == int(v) and "." not in t.rstrip("0").rstrip(".") else repr(v)
    return one + SCALE_OF[scale.strip()] if scale else one


def number_at(m: re.Match) -> str | None:
    """A match of NUM as its value, or None for an ordinal (`3rd`)."""
    return None if m.group(2) else num_value(m.group(1), m.group(3))


def rounds_to(x: float, places: int) -> float:
    """x rounded half up to `places` decimals, as a person rounds (24.5 is 25)."""
    q = 10 ** places
    return math.floor(abs(x) * q + 0.5 + 1e-9) / q * (1 if x >= 0 else -1)


def same_number(v: str, w: str) -> bool:
    """`v`, a number of the marked words, and `w`, one of an output, in one form, are the same value: `w` rounded to the
    places `v` is written with is `v` (24 is 24.2, 48.4% is 48.43%, never 48.5%). A number with a scale is the value
    rounded to it: `8k` is any number from 7,500 to 8,499, `1.2m` any from 1,150,000 to 1,249,999."""
    if v == w:
        return True
    scale = next((k for k in SCALE if v.endswith(k) and v[:-1][-1:].isdigit()), None)
    digits = v[:-len(scale)] if scale else v
    try:
        want = float(digits)
        x = float(w[:-len(scale)]) * SCALE[scale] if scale and w.endswith(scale) else float(w)
    except ValueError:
        return False
    places = len(digits.split(".")[1]) if "." in digits else 0
    if not scale and len(w.split(".")[1] if "." in w else "") <= places:
        return False
    return rounds_to(x / (SCALE[scale] if scale else 1), places) == want


def names_record(text: str, m: re.Match) -> bool:
    """The number is part of a name, not a value: after `#` (`#118`) or after a letter and a hyphen (`agent-11`)."""
    return text[max(0, m.start() - 1):m.start()] == "#" or bool(re.search(r"[A-Za-z][-_]$", text[:m.start()]))


def numbers(text: str) -> list[str]:
    """The numbers of a text, each in one form; a number that is part of a name (`#118`, `agent-11`) and an ordinal
    (`3rd`) are left out."""
    return [v for m in NUM.finditer(text) if not names_record(text, m) for v in [number_at(m)] if v is not None]


def marked_numbers(words: str) -> list[tuple[str, bool]]:
    """The numbers of marked words, each with whether it stands in a date or a time of the words."""
    spans = date_spans(words)
    return [(v, any(a <= m.start(1) < b for a, b in spans)) for m in NUM.finditer(words)
            if not names_record(words, m) for v in [number_at(m)] if v is not None]


def wordnums(s: str, counts: bool = False) -> str:
    """Number words as digits: "five of the twelve" is "5 of the 12", and "half" is 50 (a share in percent). With
    `counts`, "one" stays a word: it is more often an article ("one page every 9 seconds") than a count."""
    words = [w for w in WORDNUM if not (counts and w == "one")]
    return re.sub(r"\b(" + "|".join(words) + r"|half)\b", lambda m: WORDNUM.get(m.group(1).lower(), "50"), s, flags=re.I)


def date_spans(text: str) -> list[tuple[int, int]]:
    out = []
    for rx in DATE_PARTS:
        out += [m.span() for m in rx.finditer(text)]
    return out


def cited_numbers(words: str) -> set[str]:
    """The numbers of the marked words that the evidence must not type in: each number outside a date or a time, and
    outside a direct quote. A date in code names the period the code counts (`n['2025-04']`, `f"April 2025: {n}"`), so
    a date is never a typed value. A number in a quote is part of the record's words, which must come from the record
    (typed_quote). A number that is part of a name (`#118`, `agent-11`) is no value either."""
    words = re.sub(r"[\"“][^\"“”]+[\"”]", " ", wordnums(words))
    return {v for v, in_date in marked_numbers(words) if not in_date}


def bounded_find(needle: str, hay: str) -> int:
    """Where `needle` stands in `hay` and not as a part of a longer number, or -1."""
    if not needle:
        return -1
    start = 0
    while True:
        i = hay.find(needle, start)
        if i < 0:
            return -1
        j = i + len(needle)
        before, after = hay[i - 1:i], hay[j:j + 2]
        ok_b = not (needle[0].isdigit() and (before.isdigit() or (before != "" and before in ".," and i >= 2 and hay[i - 2].isdigit())))
        ok_a = not (needle[-1].isdigit() and (after[:1].isdigit() or (after[:1] != "" and after[:1] in ".," and after[1:2].isdigit())))
        if ok_b and ok_a:
            return i
        start = i + 1


def bounded_in(needle: str, hay: str) -> bool:
    return bounded_find(norm_ws(needle), norm_ws(hay)) >= 0


def has_number(v: str, text: str, dates: bool = True) -> bool:
    """`v` (a number in one form) is one of the numbers of `text`, compared as values: 6 matches 6.0, 9 matches 09, 8k
    matches 8,225. With `dates` False, a number inside a date or a time of the text does not count (a count of 12 is
    not the 12 of 2026-10-12)."""
    t = norm_ws(text)
    spans = [] if dates else date_spans(t)
    for m in NUM_IN_TEXT.finditer(t):
        w = number_at(m)
        if w is not None and not any(a <= m.start(1) < b for a, b in spans) and same_number(v, w):
            return True
    return False


def has_name(name: str, text: str) -> bool:
    """A record's name (`#118`, `agent-11`) stands in the text as a whole word."""
    return re.search(r"(?<![\w#-])" + re.escape(name) + r"(?![\w-])", text) is not None


LABEL = re.compile(r"^([ \t]*)\d+:[ \t]+", re.M)


def unlabeled(out: str) -> str:
    """The output without the labels that open its lines (`9: 2 of 21` is `2 of 21`)."""
    return LABEL.sub(r"\1", out)


def shows(target: str, out: str) -> bool:
    """The output holds the marked words: whole, or with number words as digits, or each quoted part of the words
    (`"added", "context" or "removed"`), or every number of the words, each as a whole number of the output, or, for
    words with no number, every record name of the words (`#102, #125 and #130`). A label that opens a line (`9: `) is no part of the output."""
    out = unlabeled(out)
    if bounded_in(target, out):
        return True
    bare = target.strip(QUOTE_CHARS + " ")
    if bounded_in(bare, out) or bounded_in(wordnums(target), wordnums(out)):
        return True
    frags = quote_fragments(target)
    if frags and all(bounded_in(f, out) for f in frags):
        return True
    nums = marked_numbers(wordnums(target, counts=True))
    if nums:
        return all(has_number(v, out, dates=d) for v, d in nums)
    names = NAME.findall(target)
    return bool(names) and all(has_name(x, out) for x in names)


def spans_of(target: str, out: str) -> list[list[int]]:
    """Where the output shows the words, for the pane: the words whole (white space as written in the output), else
    each of their numbers."""
    words = [w for w in norm_ws(target.strip(QUOTE_CHARS + " ")).split(" ") if w]
    if words:
        rx = re.compile(r"\s+".join(re.escape(w) for w in words))
        for m in rx.finditer(out):
            a, b = m.span()
            if not (out[a:a + 1].isdigit() and out[a - 1:a].isdigit()) and not (out[b - 1:b].isdigit() and out[b:b + 1].isdigit()):
                return [[a, b]]
    hits = []
    for v in numbers(wordnums(target)):
        for m in NUM_IN_TEXT.finditer(out):
            w = number_at(m)
            if w is not None and same_number(v, w):
                hits.append([m.start(1), m.end(1)])
                break
    for x in NAME.findall(target):
        m = re.search(r"(?<![\w#-])" + re.escape(x) + r"(?![\w-])", out)
        if m:
            hits.append([m.start(), m.end()])
    return sorted(hits)


# ------------------------------------------------------------------------------------------------ typed-in values

def literals(code: str) -> list[tuple[str, str]]:
    """(kind, value) of each number the code types where it can be the printed value: a NUMBER token or a number inside
    a string, assigned to a name, given to print() or a format as the innermost call (not to round() inside it), or
    returned. A bound in a comparison, a key or an argument of another call is a condition, not a value. A number inside
    a string is left out in a format spec, in a string that names a path or a file, as a part of a name (agent-02), as a
    bound of a range ("teen 13-17") and as a label that opens a string (`"9: "`)."""
    out: list[tuple[str, str]] = []
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(code).readline))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return [("number", v) for v in numbers(code)]
    prev = None
    before_fstring = None  # the token before an f-string opened, for its middle parts
    stack: list[str] = []
    for i, t in enumerate(toks):
        if t.type == tokenize.OP and t.string in "([{":
            # a call's name, or `cond` for a tuple or list a value is compared with (`r["c"] in ("1", "2")`)
            stack.append("cond" if is_comparison(prev) else prev.string if prev is not None and prev.type == tokenize.NAME and t.string == "(" else t.string)
        elif t.type == tokenize.OP and t.string in ")]}" and stack:
            stack.pop()
        if t.type == getattr(tokenize, "FSTRING_START", -1):
            before_fstring = prev
        call = next((x for x in reversed(stack) if x not in ("(", "[", "{", "cond")), None)
        printed = call in PRINTERS
        if t.type == tokenize.NUMBER:
            v = num_value(t.string.replace("_", ""))
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            ends = nxt is None or nxt.type in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER, tokenize.COMMENT) or (nxt.type == tokenize.OP and nxt.string in (";", ","))
            assigned = prev is not None and prev.type == tokenize.OP and prev.string in ("=", "+=") and ends
            bound = prev is not None and prev.type == tokenize.OP and prev.string in ("<", ">", "<=", ">=", "==", "!=", "[", ":")
            returned = prev is not None and prev.type == tokenize.NAME and prev.string in ("return", "yield")
            if assigned or (printed and not bound) or returned:
                out.append(("number", v))
        elif t.type == tokenize.STRING or t.type == getattr(tokenize, "FSTRING_MIDDLE", -1):
            s = t.string
            opener = prev if t.type == tokenize.STRING else before_fstring
            spec = t.type != tokenize.STRING and prev is not None and prev.type == tokenize.OP and prev.string in (":", "!")
            pathlike = "/" in s or re.search(r"\.[A-Za-z]{1,6}[\"']?$", s.strip()) or re.search(r"\.(jsonl?|csv|db|md|txt|py|ya?ml)\b", s)
            assigned = opener is not None and opener.type == tokenize.OP and opener.string in ("=", "+=") and not stack
            returned = opener is not None and opener.type == tokenize.NAME and opener.string in ("return", "yield")
            if (printed or assigned or returned) and not spec and not pathlike and not is_comparison(opener):
                out += [("string", v) for m in NUM.finditer(s) if not re.search(r"[A-Za-z][-_]$", s[:m.start()]) and not in_range(s, m) and not label(s, m)
                        for v in [number_at(m)] if v is not None]
        prev = t
    return out


def is_comparison(tok: Any) -> bool:
    """A token after which a value is a condition: a comparison operator, or `in`."""
    return tok is not None and (tok.type == tokenize.OP and tok.string in ("==", "!=", "<", ">", "<=", ">=") or tok.type == tokenize.NAME and tok.string == "in")


def label(s: str, m: re.Match) -> bool:
    """The number opens the string as a label, `"9: "`, as code numbers what it prints (unlabeled() takes such labels
    off the output, so a label never shows a value)."""
    return bool(re.match(r"^[\s\"'f]*$", s[:m.start()]) and re.match(r":\s", s[m.end():]))


def in_range(s: str, m: re.Match) -> bool:
    """The number is one end of a range written in a label: `13-17`, `0–12`."""
    return bool(re.match(r"\s*[-–]\s*\d", s[m.end():]) or re.search(r"\d\s*[-–]\s*$", s[:m.start()]))


def conditions(code: str) -> set[str]:
    """The numbers the code uses as conditions: number tokens in a comparison or an argument (`age < 12`, `head(5)`)."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(code).readline))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return set()
    every = {num_value(t.string.replace("_", "")) for t in toks if t.type == tokenize.NUMBER}
    return every - {v for kind, v in literals(code) if kind == "number"}


def string_values(code: str) -> tuple[list[str], list[str]]:
    """The text of each string the code prints or assigns (a plain string's value, an f-string's text between its
    fields), as literals() reads a number's place, and of each string it compares with something (`r["v"] == "yes"`,
    `"words" in body`). A key or an argument of another call is neither."""
    out: list[str] = []
    tested: list[str] = []
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(code).readline))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return out, tested
    stack: list[str] = []
    prev = None
    before_fstring = None
    for i, t in enumerate(toks):
        if t.type == tokenize.OP and t.string in "([{":
            stack.append("cond" if is_comparison(prev) else prev.string if prev is not None and prev.type == tokenize.NAME and t.string == "(" else t.string)
        elif t.type == tokenize.OP and t.string in ")]}" and stack:
            stack.pop()
        if t.type == getattr(tokenize, "FSTRING_START", -1):
            before_fstring = prev
        if t.type in (tokenize.STRING, getattr(tokenize, "FSTRING_MIDDLE", -1)):
            opener = prev if t.type == tokenize.STRING else before_fstring
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            call = next((x for x in reversed(stack) if x not in ("(", "[", "{", "cond")), None)
            assigned = opener is not None and opener.type == tokenize.OP and opener.string in ("=", "+=") and not stack
            compared = is_comparison(opener) or is_comparison(nxt)
            text: Any = t.string
            if t.type == tokenize.STRING:
                try:
                    text = ast.literal_eval(t.string)
                except (ValueError, SyntaxError):
                    text = None
            if isinstance(text, str) and compared:
                tested.append(text)
            elif isinstance(text, str) and (call in PRINTERS or assigned):
                out.append(text)
        prev = t
    return out, tested


def typed_quote(words: str, code: str) -> list[str]:
    """The quoted words of a direct quote that the code writes itself, in a string it prints, so that its output shows
    them whatever the records say. Code that prints them only after it found them in a record (`if "…" in body:`)
    reads them from the record. A quoted single word ("yes") names a value, as a label's, and is no quote."""
    printed, tested = string_values(code)
    has = lambda f, xs: any(norm_ws(f) in norm_ws(x) for x in xs)  # noqa: E731
    return [f for f in quote_fragments(words) if len(f.split()) > 1 and has(f, printed) and not has(f, tested)]


def typed_values(words: str, code: str) -> list[str]:
    """The numbers of the words that the code types in (0 and 1 as numbers are never a typed value). A number the code
    uses as a condition may stand in its printed words too: `print(f"{n} children under 12")` after `age < 12`."""
    nums = cited_numbers(words) - conditions(code)
    return sorted({v for kind, v in literals(code) if v in nums and not (kind == "number" and v in ("0", "1"))})


# ------------------------------------------------------------------------------------------------ computed evidence

def code_lines(text: str) -> list[str]:
    return [norm_ws(line) for line in str(text).split("\n") if line.strip()]


HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)(\w+)\1[^\n]*\n(.*?)\n[ \t]*\2[ \t]*(?=\n|$)", re.S)


def scripts(command: str) -> list[str]:
    """The scripts a shell command runs: each here-document's body (`python3 - <<'PY' … PY`), then the command."""
    return [m.group(3) for m in HEREDOC.finditer(command)] + [command]


def computes(line: str) -> str:
    """A line as what it computes: the words of its labels left out (a string with a space or a `{…}` field), the
    fields of an f-string kept; a string with neither, such as a key (`r["Survived"]`), stays as written."""
    def label(m: re.Match) -> str:
        body = m.group(2)
        return m.group(0) if not re.search(r"\s|\{", body) else m.group(1) + "".join(re.findall(r"\{[^{}]*\}", body)) + m.group(1)
    return re.sub(r"(['\"])(.*?)(?<!\\)\1", label, line)


def ran(code: str, command: str) -> str | None:
    """The script of a call's command that ran the code, or None: the code's lines (each with runs of white space as
    one space, blank lines left out) are lines of the script, in order, so the code may be a few lines of a script that
    printed more; a one-line code may also stand inside one line (`python3 -c "…"`). When no script holds the lines as
    written, lines that compute the same (only the words inside their strings differ, as when a copy drops a word of
    a label) count."""
    want = code_lines(code)
    if not want:
        return None
    for form in (lambda x: x, computes):
        for script in scripts(command):
            have = iter(form(line) for line in code_lines(script))
            if all(form(line) in have for line in want):
                return script
    if len(want) == 1 and any(want[0] in line for line in code_lines(command)):
        return command
    return None


def window(text: str, spans: list[list[int]], size: int) -> tuple[str, list[list[int]]]:
    """At most `size` characters of the text around its first span, the spans moved to match."""
    if len(text) <= size:
        return text, spans
    a = max(0, (spans[0][0] if spans else 0) - size // 4)
    b = min(len(text), a + size)
    lead = "…" if a > 0 else ""
    return lead + text[a:b] + ("…" if b < len(text) else ""), [[x - a + len(lead), y - a + len(lead)] for x, y in spans if x >= a and y <= b]


def check_computed(target: str, code: str, calls: list[dict[str, Any]]) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of computed evidence, and the evidence to show: the script of the call that ran the code and that
    call's real output (the first that shows the words, else the first that ran it). A value typed into any line of
    that script, not only into the lines the checker gave, is no evidence."""
    if not code.strip():
        return ["the evidence has no code"], None
    runs = [(c, script) for c in calls for script in [ran(code, str(c.get("command") or ""))] if script is not None]

    def shown(c: dict[str, Any] | None, script: str, spans: list[list[int]]) -> dict[str, Any]:
        text, hl = window(str((c or {}).get("output") or ""), spans, OUTPUT_MAX)
        return {"kind": "computed", "code": script.strip("\n"), "output": text, "highlight": hl, "by": (c or {}).get("by") or "checker"}

    if not runs:
        return ["no command of the session ran its code"], shown(None, code, [])
    problem = ""
    for c, script in runs:
        # the whole script that ran, not only the lines the checker gave, types in no value (a script that is the
        # command itself, not a here-document, is read by the lines given)
        body = code if script == c.get("command") else script
        typed = typed_values(target, body)
        quoted = typed_quote(target, body)
        out = str(c.get("output") or "")
        if typed:
            problem = problem or f"its code writes {', '.join(typed)} in by hand instead of computing it"
        elif quoted:
            problem = problem or f"its code writes the quoted words “{quoted[0]}” itself instead of reading them from the records"
        elif shows(target, out):
            return [], shown(c, script, spans_of(target, out))
        else:
            problem = problem or f"its code's output does not show “{target}”"
    return [problem], shown(runs[0][0], runs[0][1], [])


# ------------------------------------------------------------------------------------------------ quote evidence

def json_strings(v: Any) -> list[str]:
    if isinstance(v, str):
        return [v]
    if isinstance(v, list):
        return [s for x in v for s in json_strings(x)]
    if isinstance(v, dict):
        return [s for k, x in v.items() for s in [str(k)] + json_strings(x)]
    return [str(v)] if v is not None else []


def line_span(line: Any) -> tuple[int, int] | None:
    """A line number or a range (`12`, `"8-11"`, `"L8-L11"`, `[8, 11]`), as (first, last); None when it is neither or
    spans more than MAX_RANGE lines."""
    if isinstance(line, (list, tuple)) and line:
        try:
            a, b = int(line[0]), int(line[-1])
        except (TypeError, ValueError):
            return None
    else:
        m = re.fullmatch(r"\s*[Ll]?(\d+)(?:\s*[-–]\s*[Ll]?(\d+))?\s*", str(line))
        if not m:
            return None
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
    return (a, b) if 1 <= a <= b and b - a <= MAX_RANGE else None


def read_lines(path: str, a: int, b: int, partial: bool = False) -> tuple[int, list[str]] | None:
    """Lines a to b of a file, read line by line, as (a, lines); None when the file cannot be read, or, unless
    `partial`, has no line b."""
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f, start=1):
                if i >= a:
                    out.append(line.rstrip("\n"))
                if i >= b:
                    break
    except OSError:
        return None
    return (a, out) if out and (partial or len(out) == b - a + 1) else None


def quote_fragments(words: str) -> list[str]:
    """The quoted words of a direct quote, split at an ellipsis: `"Confirmed sequence: GA -> ... G5"` gives
    ["Confirmed sequence: GA ->", "G5"]; [] for words that are no direct quote."""
    w = unmark(words)
    spans = re.findall(r"[\"“]([^\"“”]+)[\"”]", w)
    if not spans and w[:1] in QUOTE_CHARS and w[-1:] in QUOTE_CHARS:
        spans = [w[1:-1]]
    frags = []
    for s in spans:
        frags += [f.strip(" .,;:" + QUOTE_CHARS) for f in re.split(r"…|\.\.\.", s)]
    return [f for f in frags if len(f) >= 3]


def forms(raw: str) -> list[tuple[str, bool]]:
    """The texts a line can hold words in: the line as written, and its JSON strings decoded (`decoded` True)."""
    out = [(raw, False)]
    try:
        out.append(("\n".join(json_strings(json.loads(raw))), True))
    except ValueError:
        pass
    return out


def shown_forms(raw: str) -> list[tuple[str, bool]]:
    """The texts a cited line is shown in, best first: each string value of its JSON alone, decoded (a record's message
    reads as written, its line breaks real), then the line as written."""
    try:
        v = json.loads(raw)
    except ValueError:
        return [(raw, False)]
    vals: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, str):
            vals.append(x)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)
    walk(v)
    return [(t, True) for t in vals] + [(raw, False)]


def find_loose(sub: str, text: str) -> list[int] | None:
    """Where `sub` stands in `text`, runs of white space as one, `**` and backticks as formatting: [start, end] in
    `text`, or None."""
    words = [w for w in unmark(sub).split(" ") if w]
    if not words:
        return None
    gap = r"(?:[\s*`]|\\n)*"
    rx = re.compile(r"[*`]*" + gap.join(r"[*`]*".join(map(re.escape, w)) for w in words), re.S)
    m = rx.search(text)
    return [m.start(), m.end()] if m else None


def inside(cwd: str, file: str, root: str | None = None) -> str | None:
    """The file's path, from the working folder, when it lies inside the working folder or the folder the session
    started in (no symbolic link is followed, so a folder of links reads as the person sees it), else None."""
    p = os.path.abspath(file if os.path.isabs(file) else os.path.join(cwd, file))
    for r in {os.path.abspath(cwd), os.path.abspath(root or cwd)}:
        if p == r or p.startswith(r + os.sep):
            return p
    return None


def hay_of(cited: list[str]) -> list[str]:
    """The texts cited lines hold words in: each line raw and decoded, and for a range the lines joined."""
    texts = [norm_ws(t) for raw in cited for t, _ in forms(raw)]
    if len(cited) > 1:
        texts += [" ".join(norm_ws(t) for raw in cited for t, d in forms(raw) if d == dec) for dec in (False, True)]
    return [h for t in texts for h in (t, unmark(t)) if h]


def holds(sub: str, hay: list[str]) -> bool:
    tight = re.sub(r"\s+", "", unmark(sub))
    return any(norm_ws(sub) in h or unmark(sub) in h or tight in re.sub(r"\s+", "", h) for h in hay)


def check_quote(target: str, ev: dict[str, Any], cwd: str, root: str | None = None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of quote or code evidence, and the cited lines to show, the substring highlighted. A line number is
    where to look: when the cited lines do not hold the substring and lines up to SHIFT_MAX away do, the nearest such
    lines are cited in their place."""
    file, line, sub = ev.get("file"), ev.get("line", ev.get("lines")), ev.get("substring")
    if not file or line is None or not sub:
        return ["the evidence needs a file, a line and a substring"], None
    path = inside(cwd, str(file), root)
    if not path:
        return [f"{file} is outside the folder of this session"], None
    span = line_span(line)
    if not span:
        return [f"line {line!r} is not a line number or a range of at most {MAX_RANGE} lines"], None
    a, b = span
    near = read_lines(path, max(1, a - SHIFT_MAX), b + SHIFT_MAX, partial=True)
    if near is None or near[0] + len(near[1]) - 1 < b:
        return [f"{file} has no line {line}"], None
    top, texts = near
    at = lambda x, y: texts[x - top:y - top + 1]  # noqa: E731
    for d in sorted(range(-SHIFT_MAX, SHIFT_MAX + 1), key=abs):
        if a + d >= top and b + d < top + len(texts) and holds(str(sub), hay_of(at(a + d, b + d))):
            a, b = a + d, b + d
            break
    line = f"{a}" if a == b else f"{a}-{b}"
    first, last = max(top, a - 1), min(top + len(texts) - 1, b + 1)
    rows = [{"n": n, "text": t} for n, t in zip(range(first, last + 1), at(first, last))]
    hay = hay_of(at(a, b))
    problems = []
    if not holds(str(sub), hay):
        problems.append(f"line {line} of {file} does not hold the words the check gave")
    for frag in quote_fragments(target):
        if not any(unmark(frag) in h for h in hay):
            problems.append(f"line {line} of {file} does not hold the quoted words {frag[:60]!r}")
    # a quote of a record shows its numbers; a claim about what code does may compute them from it (`2 ** k`)
    for v, in_date in (marked_numbers(unmark(target)) if ev.get("kind") != "code" else []):
        if not any(has_number(v, h, dates=in_date) for h in hay):
            problems.append(f"line {line} of {file} does not show {v}")
    # for the pane: each cited line in the form that holds the substring, cut around it; the lines around cut short
    for r in rows:
        if not (a <= r["n"] <= b):
            r["text"] = window(r["text"], [], CONTEXT_MAX)[0]
            continue
        for text, decoded in shown_forms(r["text"]):
            at = find_loose(str(sub), text)
            if at:
                r["text"], hl = window(text, [at], LINE_MAX)
                r["highlight"] = hl[0]
                if decoded:
                    r["decoded"] = True
                break
        else:
            r["text"] = window(r["text"], [], LINE_MAX)[0]
    rel = os.path.relpath(path, os.path.abspath(root or cwd))
    return problems, {"kind": ev.get("kind") or "quote", "file": rel, "line": f"{a}" if a == b else f"{a}-{b}", "lines": rows}


# ------------------------------------------------------------------------------------------------ one mark

def parse_answer(text: str) -> list[dict[str, Any]] | None:
    """The checker's answer: the last ```json block that holds an array, else a bare array at the answer's end. The
    array is read as JSON from the block's start, so a quote in it that holds ``` does not end it."""
    text = text or ""
    dec = json.JSONDecoder()
    found = None
    for m in re.finditer(r"```json[ \t]*\n?", text):
        try:
            v, _ = dec.raw_decode(text, m.end() + (len(text[m.end():]) - len(text[m.end():].lstrip())))
        except ValueError:
            continue
        if isinstance(v, list):
            found = v
    if found is None:
        i = text.rfind("\n[")
        if i >= 0:
            try:
                found, _ = dec.raw_decode(text, i + 1)
            except ValueError:
                return None
    return [x for x in found if isinstance(x, dict)] if isinstance(found, list) else None


def check_evidence(target: str, kind: Any, ev: dict[str, Any], calls: list[dict[str, Any]], cwd: str, root: str | None) -> tuple[list[str], dict[str, Any] | None]:
    """The problems of one piece of evidence for `target`, and the evidence to show."""
    if kind == "computed":
        return check_computed(target, str(ev.get("code") or ""), calls)
    if kind in ("quote", "code"):
        return check_quote(target, {**ev, "kind": kind}, cwd, root)
    return [f"the evidence is of no known kind ({kind!r})"], None


def check_mark(mark: dict[str, Any], item: dict[str, Any] | None, calls: list[dict[str, Any]], cwd: str, root: str | None = None) -> dict[str, Any]:
    """What the person sees of one mark: {n, status, shown, reason, failedBy?, evidence?}. `mark` is {n, words}; `item`
    the checker's object for it (or None); `calls` the real Bash calls of the session ({command, output, by}).

    A correction whose evidence does not show the new words, but shows the marked words, leaves the mark verified: the
    words held at the precision they were written in. A mark the checker failed keeps the evidence it gave, when that
    evidence is real, so the person sees what the check found. `failedBy` is `check` when the checker failed the mark,
    `evidence` when its evidence did not hold."""
    n, words = mark["n"], str(mark["words"])
    out: dict[str, Any] = {"n": n, "status": "unchecked", "shown": words, "reason": "the check gave no answer for this mark"}
    if not item:
        return out
    status, kind = item.get("status"), item.get("kind")
    ev = item.get("evidence") if isinstance(item.get("evidence"), dict) else {}
    reason = norm_ws(item.get("reason") or "")
    corr = item.get("correction") if isinstance(item.get("correction"), dict) else None
    new = norm_ws(corr.get("words") or "") if status == "corrected" and corr else ""
    if status == "corrected" and (not new or unmark(new) == unmark(words)):
        # a correction that leaves the words as they were found an error around them (a wrong place, a wrong
        # condition), which the words cannot show: the mark fails, with the checker's reason
        status = "failed"
        reason = reason or "the check gave no corrected words"
    if status == "failed":
        failed = {**out, "status": "failed", "reason": reason or "no source supports this claim", "failedBy": "check"}
        if ev:
            _, evidence = check_evidence(unmark(words), kind, ev, calls, cwd, root)
            if evidence and (evidence.get("kind") != "computed" or evidence.get("output")):
                failed["evidence"] = evidence
        return failed
    if status not in ("verified", "corrected"):
        return {**out, "reason": f"the check gave the status {status!r}"}
    problems, evidence = check_evidence(unmark(new or words), kind, ev, calls, cwd, root)
    if problems and new:
        kept, kept_ev = check_evidence(unmark(words), kind, ev, calls, cwd, root)
        if not kept:
            return {"n": n, "status": "verified", "shown": words, "reason": reason, **({"evidence": kept_ev} if kept_ev else {})}
    res: dict[str, Any] = {"n": n, "status": status, "shown": new or words, "reason": reason}
    if evidence:
        res["evidence"] = evidence
    if status == "corrected":
        res["was"] = words
    if problems:
        res.update(status="failed", shown=words, failedBy="evidence", reason=f"The check's evidence does not hold: {problems[0]}.")
        res.pop("was", None)
    return res


def check_all(marks: list[dict[str, Any]], answer: str, calls: list[dict[str, Any]], cwd: str, root: str | None = None) -> dict[str, Any]:
    """Every mark of a reply: {parsed, results}. `answer` is the checker's last message."""
    items = parse_answer(answer)
    by_n: dict[int, dict[str, Any]] = {}
    for it in items or []:
        try:
            by_n.setdefault(int(it.get("mark")), it)
        except (TypeError, ValueError):
            continue
    return {"parsed": items is not None, "results": [check_mark(m, by_n.get(int(m["n"])), calls, cwd, root) for m in marks]}
