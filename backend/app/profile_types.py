"""Main's description of the data, checked against the records (views round 5; exploration). The engine of the
profile_data tool (profile_data.py runs it in the card kernel's sandbox) and of `thimble-profile` (plugin/bin).

    thimble-profile types [FILE] [--out DIR] [--ws WS] [--budget N]        TypeScript types (FILE or stdin), checked
    thimble-profile files [GLOB ...] [--input FILE] [--out DIR] [--ws WS]  a simple per-file profile, with no types

`types` reads TypeScript types. A type whose doc comment has `@records <glob>[#<place>]` (or `@from`) is a kind of
record: the lines of jsonl files, the values of a JSON document (a document that is an array: its items; `#/runs/*`
the values a pointer names, `*` matching every key or item), the rows of a CSV file or of a database's table
(`#<table>`), the lines of a text file, or one record per file with `@file` (also `#file`), such as a video. Every
record also carries `_path` and `_ref`, its citation. In a field, `Time` is a time in any format, `Other["key"]` (or
`Ref<Other, "key">`) joins to another type's key, `@label [name]` takes the value of the workspace's label of that
name (else the field's), and `@derived <code>` computes a field the files do not hold, from the record and from all
records by type: JavaScript, `(p, all) => all.Post.filter((q) => q.reply_to === p.id).length`, run by node
(profile_derive.mjs), or Python of `r` with rows("Type"), by("Type", "field"), time(x) and seconds(a, b). Unions
(including unions of object types, each record profiled as the one it fits), optional fields and `unknown` keep the
types workable on messy data.

It checks each type against its records and profiles every field: how many records have it, nulls, distinct values,
the commonest values, ranges, how well each join holds, what each derived field computes, and the keys the records hold
that the types do not name. A value that does not fit is reported as a fit ("parses for 97%") with a few of the rest
and their citations, never as a failure. Large data is read on a sample (`--budget` records per type, default 20000,
spread over the files and through each file), and the profile says so.

`files` profiles the files themselves with no types: files grouped by pattern, and for each group of data files its
records and the fields they hold, with counts and distinct values. Its input, main's plain description, is saved beside
the profile.

Both print the profile (at most PRINT_MAX characters) and save it whole with their input in the workspace's
views-work/profile folder (or --out). Exit 0, or 2 when the types do not parse (the message names the line)."""
from __future__ import annotations

import argparse
import csv
import importlib
import io
import json
import math
import os
import re
import shutil
import sqlite3
import statistics
import sys
import time as _time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BUDGET = 20_000  # records read of one kind, at most; past it the records are a sample spread over the files
FULL_BYTES = 48 * 1024 * 1024  # bytes read of one kind's line files before reading by windows
FILES_MAX = 400  # files read of one kind, at most, spread through the sorted list
JSON_FILE_MAX = 64 * 1024 * 1024  # a JSON document larger than this is left out (named in the profile)
DISTINCT_MAX = 50_000  # distinct values counted of one field
TOP = 5  # commonest values shown
EXAMPLES = 3  # values that do not fit, shown with their citations
SNIP = 48  # chars of a value shown
DEPTH_MAX = 6  # nesting profiled, at most
FIELDS_PLAIN = 15  # fields shown of one group in the plain profile
GROUPS_PLAIN = 30  # file groups shown in the plain profile
PRINT_MAX = 28_000  # chars printed (Claude Code cuts a longer Bash output); the saved profile is whole
PROFILE_DIR = "views-work/profile"  # workspace-relative: the last input and profile, and their history

LINE_EXT = {".jsonl", ".ndjson"}
CSV_EXT = {".csv", ".tsv"}
DB_EXT = {".db", ".sqlite", ".sqlite3"}
TEXT_EXT = {".md", ".txt", ".log", ".vtt", ".srt", ".py", ".ts", ".js", ".html", ".yaml", ".yml", ".toml", ".cfg",
            ".ini", ".sh", ".rst", ".tex", ".sql", ".css", ".xml", ".r", ".ipynb_checkpoints", ".out", ".err"}
META = ("_path", "_ref", "_line", "_key", "_bytes")


# ----------------------------------------------------------------------------------------------------------------------
# the types: a tokenizer and parser for the part of TypeScript that describes data
# ----------------------------------------------------------------------------------------------------------------------


class TypesError(ValueError):
    pass


@dataclass
class Comment:
    text: str
    line: int
    trailing: bool  # on the line of the token before it


@dataclass
class Tok:
    kind: str  # id, str, num, tmpl, p (punctuation), eof
    val: str
    line: int
    pre: list[Comment] = field(default_factory=list)


_PUNCT2 = ("=>", "...", "?.")
_ID = re.compile(r"[A-Za-z_$][\w$]*")
_NUM = re.compile(r"\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+")


def tokenize(src: str) -> list[Tok]:
    toks: list[Tok] = []
    pre: list[Comment] = []
    i, n, line = 0, len(src), 1
    last_line = 0
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c in " \t\r\f\v":
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            pre.append(Comment(src[i + 2:j], line, bool(toks) and last_line == line))
            i = j
            continue
        # a comment trails the token before it only when it ends its line: `a: T; /** d */ b: U` documents b
        if src.startswith("/*", i):
            # a glob or a regex in a doc comment, such as @records runs/*/events.jsonl, **/x.json or /a\*\*/, holds
            # `*/`: one directly before a path's character, or followed on its line by another `*/`, does not close it
            j = i + 2
            while True:
                j = src.find("*/", j)
                if j < 0:
                    break
                eol = src.find("\n", j)
                rest = src[j + 2:eol if eol >= 0 else n]
                if not ((j + 2 < n and re.match(r"[\w.*{\[-]", src[j + 2])) or "*/" in rest):
                    break
                j += 2
            if j < 0:
                raise TypesError(f"line {line}: a /* comment is not closed")
            body = src[i + 2:j]
            eol = src.find("\n", j + 2)
            ends_line = not src[j + 2:eol if eol >= 0 else n].strip()
            pre.append(Comment(body[1:] if body.startswith("*") else body, line,
                               bool(toks) and last_line == line and ends_line))
            line += body.count("\n")
            i = j + 2
            continue
        start_line = line
        if c in "'\"":
            j, buf = i + 1, []
            while j < n and src[j] != c:
                if src[j] == "\\" and j + 1 < n:
                    buf.append(src[j + 1])
                    j += 2
                    continue
                if src[j] == "\n":
                    raise TypesError(f"line {line}: a string is not closed")
                buf.append(src[j])
                j += 1
            toks.append(Tok("str", "".join(buf), start_line, pre))
            i = j + 1
        elif c == "`":
            j = src.find("`", i + 1)
            if j < 0:
                raise TypesError(f"line {line}: a template literal is not closed")
            line += src[i:j].count("\n")
            toks.append(Tok("tmpl", src[i + 1:j], start_line, pre))
            i = j + 1
        elif (m := _NUM.match(src, i)) and (c.isdigit() or c == "."):
            toks.append(Tok("num", m.group(0), start_line, pre))
            i = m.end()
        elif m := _ID.match(src, i):
            toks.append(Tok("id", m.group(0), start_line, pre))
            i = m.end()
        else:
            two = next((p for p in _PUNCT2 if src.startswith(p, i)), None)
            toks.append(Tok("p", two or c, start_line, pre))
            i += len(two) if two else 1
        pre = []
        last_line = line
    toks.append(Tok("eof", "", line, pre))
    return toks


# type expressions
@dataclass
class Ty:
    k: str  # prim lit union arr tup obj name any fn
    name: str = ""  # prim: string number boolean null undefined bigint object never; name: the referenced name
    value: Any = None  # lit
    items: list["Ty"] = field(default_factory=list)  # union options, tuple items, name's type arguments
    elem: "Ty | None" = None  # arr
    fields: list["Field"] = field(default_factory=list)  # obj
    index: "Ty | None" = None  # obj: [key: string]: T


@dataclass
class Field:
    name: str
    ty: Ty
    optional: bool = False
    doc: str = ""
    derive: str | None = None
    label: str | None = None  # the label's name, '' for the field's own name
    line: int = 0


@dataclass
class Decl:
    name: str
    ty: Ty
    doc: str
    sources: list[str]
    line: int
    bases: list[str] = field(default_factory=list)


PRIMS = {"string", "number", "boolean", "null", "undefined", "bigint", "object", "never", "symbol", "void"}
ANYS = {"unknown", "any"}
TAG = re.compile(r"(?m)(?:^|(?<=\s))@(\w+)")


def doc_text(comments: list[Comment]) -> str:
    out = []
    for cm in comments:
        lines = [re.sub(r"^\s*\*?\s?", "", ln) for ln in cm.text.splitlines()]
        out.append("\n".join(lines).strip())
    return "\n".join(x for x in out if x)


def tags(doc: str) -> dict[str, list[str]]:
    """{tag: [its text]}: each `@tag` runs to the next tag at a line's start or the end; the text before the first tag is
    `''`. A comment that starts with `=` is a derived field's code."""
    out: dict[str, list[str]] = defaultdict(list)
    s = doc.strip()
    if s.startswith("="):
        out["derived"].append(s[1:].strip())
        return out
    known = ("from", "records", "file", "derived", "derive", "computed", "label", "key")
    marks = [m for m in TAG.finditer(doc)
             if m.group(1).lower() in known or doc[:m.start()].rsplit("\n", 1)[-1].strip() == ""]
    if not marks:
        out[""].append(s)
        return out
    out[""].append(doc[:marks[0].start()].strip())
    for a, b in zip(marks, [*marks[1:], None]):
        text = doc[a.end():b.start() if b else len(doc)].strip()
        name = a.group(1).lower()
        name = {"derive": "derived", "computed": "derived"}.get(name, name)
        out[name].append(text)
    return out


class Parser:
    def __init__(self, toks: list[Tok]) -> None:
        self.t = toks
        self.i = 0
        self.last = toks[0]

    def peek(self, k: int = 0) -> Tok:
        return self.t[min(self.i + k, len(self.t) - 1)]

    def next(self) -> Tok:
        tok = self.t[self.i]
        self.i = min(self.i + 1, len(self.t) - 1)
        self.last = tok
        return tok

    def at(self, val: str, kind: str = "") -> bool:
        tok = self.peek()
        return tok.val == val and (not kind or tok.kind == kind) and tok.kind in ("p", "id")

    def eat(self, val: str) -> bool:
        if self.at(val):
            self.next()
            return True
        return False

    def need(self, val: str) -> Tok:
        tok = self.peek()
        if not self.at(val):
            got = tok.val or "the end"
            raise TypesError(f"line {tok.line}: expected {val!r}, found {got!r}")
        return self.next()

    # -- declarations
    def program(self) -> list[Decl]:
        out: list[Decl] = []
        while self.peek().kind != "eof":
            start = self.peek()
            doc = doc_text([c for c in start.pre if not c.trailing])
            while self.peek().val in ("export", "declare", "default") and self.peek().kind == "id":
                self.next()
            tok = self.peek()
            if tok.kind == "id" and tok.val == "interface":
                out.append(self.interface(doc, start.line))
            elif tok.kind == "id" and tok.val == "type" and self.peek(1).kind == "id":
                out.append(self.alias(doc, start.line))
            elif tok.kind == "id" and tok.val == "enum":
                out.append(self.enum(doc, start.line))
            else:
                self.skip_statement()
        return out

    def skip_statement(self) -> None:
        depth = 0
        while self.peek().kind != "eof":
            tok = self.next()
            if tok.val in "{([" and tok.kind == "p":
                depth += 1
            elif tok.val in "})]" and tok.kind == "p":
                depth -= 1
                if depth <= 0 and tok.val == "}":
                    return
            elif tok.val == ";" and depth <= 0:
                return
            nxt = self.peek()
            if depth <= 0 and nxt.kind == "id" and nxt.val in ("interface", "type", "export", "enum") and nxt.line > tok.line:
                return

    def type_params(self) -> None:
        if self.at("<"):
            depth = 0
            while self.peek().kind != "eof":
                tok = self.next()
                depth += {"<": 1, ">": -1}.get(tok.val, 0) if tok.kind == "p" else 0
                if depth == 0:
                    return

    def interface(self, doc: str, line: int) -> Decl:
        self.need("interface")
        name = self.next().val
        self.type_params()
        bases = []
        if self.eat("extends"):
            while True:
                b = self.postfix()
                if b.k == "name":
                    bases.append(b.name)
                if not self.eat(","):
                    break
        ty = self.object_body()
        return Decl(name, ty, doc, sources_of(doc), line, bases)

    def alias(self, doc: str, line: int) -> Decl:
        self.need("type")
        name = self.next().val
        self.type_params()
        self.need("=")
        ty = self.union()
        self.eat(";")
        return Decl(name, ty, doc, sources_of(doc), line)

    def enum(self, doc: str, line: int) -> Decl:
        self.need("enum")
        name = self.next().val
        self.need("{")
        opts, n = [], 0
        while not self.at("}") and self.peek().kind != "eof":
            key = self.next()
            if self.eat("="):
                v = self.next()
                opts.append(Ty("lit", value=v.val if v.kind == "str" else float(v.val) if "." in v.val else int(v.val)))
            else:
                opts.append(Ty("lit", value=n if key.kind != "str" else key.val))
                n += 1
            self.eat(",")
        self.need("}")
        return Decl(name, Ty("union", items=opts), doc, sources_of(doc), line)

    # -- type expressions
    def union(self) -> Ty:
        self.eat("|")
        opts = [self.inter()]
        while self.eat("|"):
            opts.append(self.inter())
        return opts[0] if len(opts) == 1 else Ty("union", items=opts)

    def inter(self) -> Ty:
        self.eat("&")
        parts = [self.postfix()]
        while self.eat("&"):
            parts.append(self.postfix())
        if len(parts) == 1:
            return parts[0]
        return Ty("name", name="&", items=parts)  # resolved by merging the objects

    def postfix(self) -> Ty:
        ty = self.primary()
        while self.at("["):
            if self.peek(1).val == "]":
                self.next(), self.next()
                ty = Ty("arr", elem=ty)
            else:  # an indexed access: Other["key"], the type of another type's key, is a join to it
                self.next()
                key = self.union()
                self.need("]")
                if ty.k == "name" and key.k == "lit" and isinstance(key.value, str):
                    ty = Ty("name", name="Ref", items=[ty, key])
                else:
                    ty = Ty("any")
        return ty

    def primary(self) -> Ty:
        tok = self.peek()
        if tok.kind == "p" and tok.val == "(":
            # a function type, (a: X) => Y, or a parenthesized type
            j, depth = self.i, 0
            while j < len(self.t):
                if self.t[j].val == "(" and self.t[j].kind == "p":
                    depth += 1
                elif self.t[j].val == ")" and self.t[j].kind == "p":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            if j + 1 < len(self.t) and self.t[j + 1].val == "=>":
                self.i = j + 2
                self.union()
                return Ty("fn")
            self.next()
            ty = self.union()
            self.need(")")
            return ty
        if tok.kind == "p" and tok.val == "{":
            return self.object_body()
        if tok.kind == "p" and tok.val == "[":
            self.next()
            items = []
            while not self.at("]") and self.peek().kind != "eof":
                if self.peek().kind == "id" and self.peek(1).val in (":", "?"):  # a named member, [a: X]
                    self.next()
                    self.eat("?")
                    self.need(":")
                self.eat("...")
                items.append(self.union())
                self.eat("?")
                if not self.eat(","):
                    break
            self.need("]")
            return Ty("tup", items=items)
        if tok.kind == "str":
            self.next()
            return Ty("lit", value=tok.val)
        if tok.kind == "tmpl":
            self.next()
            return Ty("prim", name="string")
        if tok.kind == "num":
            self.next()
            return Ty("lit", value=float(tok.val) if re.search(r"[.eE]", tok.val) else int(tok.val))
        if tok.kind == "p" and tok.val == "-" and self.peek(1).kind == "num":
            self.next()
            v = self.next().val
            return Ty("lit", value=-(float(v) if re.search(r"[.eE]", v) else int(v)))
        if tok.kind == "id":
            self.next()
            if tok.val in ("true", "false"):
                return Ty("lit", value=tok.val == "true")
            if tok.val in ("keyof", "typeof", "readonly", "unique", "infer"):
                inner = self.postfix()
                return Ty("prim", name="string") if tok.val == "keyof" else inner if tok.val == "readonly" else Ty("any")
            name = tok.val
            while self.at("."):
                self.next()
                name += "." + self.next().val
            args = []
            if self.at("<"):
                self.next()
                while not self.at(">") and self.peek().kind != "eof":
                    args.append(self.union())
                    if not self.eat(","):
                        break
                self.need(">")
            if name in PRIMS:
                return Ty("prim", name=name)
            if name in ANYS:
                return Ty("any")
            return Ty("name", name=name, items=args)
        raise TypesError(f"line {tok.line}: a type cannot start with {tok.val or 'the end'!r}")

    def object_body(self) -> Ty:
        self.need("{")
        out = Ty("obj")
        while not self.at("}"):
            if self.peek().kind == "eof":
                raise TypesError(f"line {self.peek().line}: a {{ is not closed")
            start = self.peek()
            doc = doc_text([c for c in start.pre if not c.trailing])
            if self.eat(";") or self.eat(","):
                continue
            self.eat("readonly")
            if self.at("["):  # an index signature, [key: string]: T, or a mapped type
                self.next()
                self.next()
                if self.eat(":") or self.eat("in"):
                    self.union()
                self.need("]")
                self.eat("?")
                self.need(":")
                out.index = self.union()
                self.eat(";") or self.eat(",")
                continue
            key = self.next()
            if key.kind not in ("id", "str", "num"):
                raise TypesError(f"line {key.line}: expected a field's name, found {key.val!r}")
            optional = self.eat("?")
            if self.at("("):  # a method: data has none
                self.skip_parens()
                if self.eat(":"):
                    self.union()
                self.eat(";") or self.eat(",")
                continue
            self.need(":")
            ty = self.union()
            sep_line = self.last.line
            if self.at(";") or self.at(","):
                sep_line = self.next().line
            trail = [c for c in self.peek().pre if c.trailing and c.line == sep_line]
            text = "\n".join(x for x in (doc, doc_text(trail)) if x)
            tg = tags(text)
            f = Field(key.val, ty, optional, text, line=key.line)
            if tg.get("derived"):
                f.derive = tg["derived"][-1]
            if "label" in tg:  # the label's name or id is the rest of the tag's line, else the field's name
                m = re.search(r"@label[ \t]*([^\n]*)", text)
                f.label = (m.group(1) if m else "").replace("*/", "").strip().strip("`'\"")
            if ty.k == "name" and ty.name == "Label":
                f.label = f.label or ""
            out.fields.append(f)
        self.need("}")
        return out

    def skip_parens(self) -> None:
        depth = 0
        while self.peek().kind != "eof":
            tok = self.next()
            if tok.kind == "p" and tok.val == "(":
                depth += 1
            elif tok.kind == "p" and tok.val == ")":
                depth -= 1
                if depth == 0:
                    return


def sources_of(doc: str) -> list[str]:
    """The record globs a doc comment names with `@records` (or `@from`); with `@file`, each file is one record."""
    tg = tags(doc)
    out = []
    for text in [*tg.get("records", []), *tg.get("from", [])]:
        out += [s.strip().strip("`'\",") for s in re.split(r"[\s,]+", text) if s.strip().strip("`'\",")]
    if "file" in tg:
        out = [x if "#" in x else f"{x}#file" for x in out]
    return out


def parse(src: str) -> dict[str, Decl]:
    decls = Parser(tokenize(src)).program()
    out: dict[str, Decl] = {}
    for d in decls:
        out[d.name] = d
    return out


# ----------------------------------------------------------------------------------------------------------------------
# resolving names: declared types, Time, Ref, Label, Array, Record, Partial and intersections
# ----------------------------------------------------------------------------------------------------------------------


class Types:
    def __init__(self, decls: dict[str, Decl]) -> None:
        self.decls = decls
        self.unknown_names: set[str] = set()

    def resolve(self, ty: Ty, seen: frozenset = frozenset()) -> Ty:
        """`ty` with a name replaced by what it names, one level: Time, Ref, Label stay names, which the profile reads."""
        if ty.k != "name":
            return ty
        n = ty.name
        if n in ("Time", "Date", "Ref", "Label"):
            return ty
        if n == "&":
            merged = Ty("obj")
            for part in ty.items:
                p = self.resolve(part, seen)
                if p.k == "obj":
                    merged.fields += [f for f in p.fields if f.name not in {g.name for g in merged.fields}]
                    merged.index = merged.index or p.index
            return merged
        if n in ("Array", "ReadonlyArray", "Set"):
            return Ty("arr", elem=ty.items[0] if ty.items else Ty("any"))
        if n in ("Record", "Map"):
            return Ty("obj", index=ty.items[1] if len(ty.items) > 1 else Ty("any"))
        if n in ("Partial", "Required", "Readonly") and ty.items:
            inner = self.resolve(ty.items[0], seen)
            if inner.k == "obj" and n == "Partial":
                return Ty("obj", fields=[Field(f.name, f.ty, True, f.doc, f.derive, f.label, f.line) for f in inner.fields],
                          index=inner.index)
            return inner
        if n in ("Int", "Integer", "Float"):
            return Ty("prim", name="number")
        if n in ("Url", "URL", "Path", "Id", "ID", "Text", "Markdown"):
            return Ty("prim", name="string")
        if n in ("Json", "JSON", "Object", "Function"):
            return Ty("any")
        d = self.decls.get(n)
        if d is None:
            self.unknown_names.add(n)
            return Ty("any")
        if n in seen:
            return Ty("any")
        out = self.resolve(d.ty, seen | {n})
        if d.bases and out.k == "obj":
            fields = list(out.fields)
            names = {f.name for f in fields}
            for b in d.bases:
                bt = self.resolve(Ty("name", name=b), seen | {n})
                if bt.k == "obj":
                    fields += [f for f in bt.fields if f.name not in names]
            out = Ty("obj", fields=fields, index=out.index)
        return out

    def show(self, ty: Ty, depth: int = 0) -> str:
        """A short name of a type for the profile."""
        k = ty.k
        if k == "prim":
            return ty.name
        if k == "lit":
            return json.dumps(ty.value)
        if k == "any":
            return "unknown"
        if k == "fn":
            return "function"
        if k == "arr":
            inner = self.show(ty.elem or Ty("any"), depth + 1)
            return f"({inner})[]" if "|" in inner else f"{inner}[]"
        if k == "tup":
            return "[" + ", ".join(self.show(x, depth + 1) for x in ty.items) + "]"
        if k == "obj":
            return "{…}" if ty.fields else "Record<…>"
        if k == "union":
            lits = [x for x in ty.items if x.k == "lit"]
            if len(lits) == len(ty.items) and len(lits) > 3:
                return f"{len(lits)} values"
            s = " | ".join(self.show(x, depth + 1) for x in ty.items)
            return s if len(s) <= 40 else f"{len(ty.items)} kinds"
        if k == "name":
            if ty.name == "Ref":
                tgt, f = ref_target(ty)
                return f"Ref<{tgt}.{f}>"
            if ty.name == "Label":
                return "label"
            return ty.name
        return k


# ----------------------------------------------------------------------------------------------------------------------
# values against types
# ----------------------------------------------------------------------------------------------------------------------

_TIME_PATTERNS = ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%Y-%m-%d",
                  "%a, %d %b %Y %H:%M:%S %Z", "%a %b %d %H:%M:%S %Y", "%Y%m%dT%H%M%S", "%H:%M:%S", "%d %b %Y")


def parse_time(x: Any) -> datetime | None:
    """A time from an ISO string, a common date string, or epoch seconds or milliseconds, in UTC (naive taken as UTC)."""
    if x is None or isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        v = float(x)
        if 1e12 <= abs(v) < 1e14:
            v /= 1000.0
        elif 1e15 <= abs(v) < 1e17:
            v /= 1e6
        if not (1e8 <= abs(v) < 1e11):
            return None
        try:
            return datetime.fromtimestamp(v, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(x, str):
        return None
    s = x.strip()
    if not s or len(s) > 40:
        return None
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return parse_time(float(s))
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00") if s.endswith("Z") else s)
    except ValueError:
        d = None
        for p in _TIME_PATTERNS:
            try:
                d = datetime.strptime(s, p)
                break
            except ValueError:
                continue
        if d is None:
            return None
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


def jtype(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def snip(v: Any, n: int = SNIP) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    s = " ".join(str(s).split())
    return json.dumps(s[:n] + "…" if len(s) > n else s, ensure_ascii=False) if isinstance(v, str) else (s[:n] + "…" if len(s) > n else s)


def key_of(v: Any) -> Any:
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, sort_keys=True, default=str)[:200]
    return v


# ----------------------------------------------------------------------------------------------------------------------
# records: loading what a type's @from names
# ----------------------------------------------------------------------------------------------------------------------


@dataclass
class Source:
    spec: str
    files: list[Path] = field(default_factory=list)
    files_read: int = 0
    bytes_total: int = 0
    bytes_read: int = 0
    records_read: int = 0
    records_est: int = 0
    sampled: bool = False
    notes: list[str] = field(default_factory=list)
    bad_lines: int = 0
    bad_refs: list[str] = field(default_factory=list)
    keyvals: dict[str, set] = field(default_factory=dict)  # a join's target fields: every value read, before sampling
    keys_whole: bool = True  # whether keyvals hold every record's value (False when lines were read on a sample)


def expand(root: Path, pattern: str) -> list[Path]:
    """The files a glob names, relative to the corpus folder (an absolute one inside it is read as relative)."""
    while pattern.startswith("./"):
        pattern = pattern[2:]
    if pattern.startswith(str(root) + "/"):
        pattern = pattern[len(str(root)) + 1:]
    if pattern.startswith("/"):
        p = Path(pattern)
        return [p] if p.is_file() else []
    if not any(ch in pattern for ch in "*?["):
        p = root / pattern
        return [p] if p.is_file() else sorted(q for q in p.rglob("*") if q.is_file()) if p.is_dir() else []
    return sorted(p for p in root.glob(pattern) if p.is_file())


def spread(items: list, n: int) -> list:
    """At most n of `items`, evenly spread, the first and the last among them."""
    if len(items) <= n:
        return list(items)
    if n <= 1:
        return items[:1]
    step = (len(items) - 1) / (n - 1)
    return [items[round(i * step)] for i in range(n)]


def rel(root: Path, p: Path) -> str:
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


def read_lines(path: Path, budget_bytes: int, want: int) -> tuple[list[tuple[int, bytes]], int, bool]:
    """(line number, line) pairs of a line file: all of it when it fits `budget_bytes`, else lines read in windows spread
    through it, each window's first part line dropped and its line numbers counted. (pairs, bytes read, sampled)."""
    size = path.stat().st_size
    out: list[tuple[int, bytes]] = []
    with open(path, "rb") as f:
        if size <= budget_bytes:
            for i, ln in enumerate(f, 1):
                if ln.strip():
                    out.append((i, ln))
            return out, size, False
        windows = max(4, min(64, want // 50 or 4))
        span = max(64 * 1024, budget_bytes // windows)
        starts = spread(list(range(0, max(1, size - span), max(1, (size - span) // windows))), windows)
        line_no, pos = 1, 0
        read = 0
        for s in starts:
            if s < pos:
                continue
            # count the newlines between pos and s, so the window's line numbers are right
            f.seek(pos)
            left = s - pos
            while left > 0:
                chunk = f.read(min(left, 16 * 1024 * 1024))
                if not chunk:
                    break
                line_no += chunk.count(b"\n")
                left -= len(chunk)
            f.seek(s)
            buf = f.read(span)
            read += len(buf)
            pos = s + len(buf)
            parts = buf.split(b"\n")
            first = 1 if s > 0 else 0  # a window that does not start the file starts mid-line
            if first:
                line_no += 1
            for j, ln in enumerate(parts[first:-1]):
                if ln.strip():
                    out.append((line_no + j, ln))
            line_no += len(parts) - 1 - first
            # the window's last part is a line cut short: its newline, if any, is counted when the next window starts
            pos -= len(parts[-1])
        return out, read, True


def pointer_walk(doc: Any, pointer: str) -> list[tuple[str, Any]]:
    """(pointer, value) pairs a JSON pointer names, `*` matching every element or key. A pointer whose last value is an
    array names its elements."""
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.strip("/").split("/")] if pointer.strip("/") else []
    nodes = [("", doc)]
    for part in parts:
        nxt = []
        for at, v in nodes:
            if part == "*":
                if isinstance(v, list):
                    nxt += [(f"{at}/{i}", x) for i, x in enumerate(v)]
                elif isinstance(v, dict):
                    nxt += [(f"{at}/{k}", x) for k, x in v.items()]
            elif isinstance(v, dict) and part in v:
                nxt.append((f"{at}/{part}", v[part]))
            elif isinstance(v, list) and part.isdigit() and int(part) < len(v):
                nxt.append((f"{at}/{part}", v[int(part)]))
        nodes = nxt
    if parts and parts[-1] != "*" and len(nodes) == 1 and isinstance(nodes[0][1], list):
        at, v = nodes[0]
        return [(f"{at}/{i}", x) for i, x in enumerate(v)]
    if not parts and isinstance(doc, list):
        return [(f"/{i}", x) for i, x in enumerate(doc)]
    return nodes


def as_record(v: Any, meta: dict[str, Any]) -> dict[str, Any]:
    if isinstance(v, dict):
        r = dict(v)
    else:
        r = {"value": v}
    r.update(meta)
    return r


def load(root: Path, spec: str, budget: int, files: list[Path] | None = None,
         keys: set[str] | frozenset = frozenset()) -> tuple[list[dict[str, Any]], Source]:
    """The records `spec` names (`<glob>[#<place>]`, or `files` with its place), at most about `budget` of them,
    spread over its files. The values of `keys`, the fields joins point at, are kept from every record read."""
    glob, _, place = spec.partition("#")
    src = Source(spec)
    src.keyvals = {k: set() for k in keys}
    files = expand(root, glob) if files is None else files
    src.files = files
    src.bytes_total = sum(p.stat().st_size for p in files)
    if not files:
        src.notes.append(f"no file matches {glob}")
        return [], src
    chosen = spread(files, FILES_MAX)
    if len(chosen) < len(files):
        src.sampled = True
    ext = files[0].suffix.lower()
    out: list[dict[str, Any]] = []
    per_file = max(1, budget // len(chosen))
    if ext in LINE_EXT or (ext in TEXT_EXT and place in ("", "lines")) or place == "lines":
        as_json = ext in LINE_EXT
        sub = place if as_json and place.startswith("/") else ""
        chosen_bytes = sum(p.stat().st_size for p in chosen)
        budget_bytes = FULL_BYTES if chosen_bytes > FULL_BYTES else chosen_bytes + 1
        for p in chosen:
            size = p.stat().st_size
            share = max(256 * 1024, int(budget_bytes * size / max(1, chosen_bytes)))
            lines, nread, sampled = read_lines(p, share, per_file)
            src.bytes_read += nread
            src.files_read += 1
            src.sampled |= sampled
            if len(lines) > per_file * 2 and len(chosen) > 1:
                lines = spread(lines, per_file * 2)
                src.sampled = True
            src.keys_whole &= not sampled and not src.sampled
            path = rel(root, p)
            for n, ln in lines:
                ref = f"{path}#L{n}"
                if as_json:
                    try:
                        v = json.loads(ln)
                    except ValueError:
                        src.bad_lines += 1
                        if len(src.bad_refs) < EXAMPLES:
                            src.bad_refs.append(ref)
                        continue
                    if sub:
                        for at, x in pointer_walk(v, sub):
                            out.append(as_record(x, {"_path": path, "_ref": ref, "_line": n, "_key": at}))
                    else:
                        out.append(as_record(v, {"_path": path, "_ref": ref, "_line": n}))
                else:
                    out.append({"text": ln.decode("utf-8", "replace").rstrip("\r\n"), "_path": path, "_ref": ref,
                                "_line": n})
    elif ext == ".json" or place.startswith("/") and ext not in DB_EXT:
        for p in chosen:
            path = rel(root, p)
            size = p.stat().st_size
            if size > JSON_FILE_MAX:
                src.notes.append(f"{path} left out: {size / 1e6:.0f} MB")
                continue
            try:
                with open(p, "rb") as f:
                    doc = json.loads(f.read())
            except ValueError:
                src.bad_lines += 1
                if len(src.bad_refs) < EXAMPLES:
                    src.bad_refs.append(path)
                continue
            src.bytes_read += size
            src.files_read += 1
            nodes = pointer_walk(doc, place or "/")  # a document that is an array: its elements
            src.records_est += len(nodes)
            for k, vals in src.keyvals.items():
                vals.update(key_of(x.get(k)) for _, x in nodes if isinstance(x, dict) and x.get(k) is not None)
            if len(nodes) > per_file * 2:
                nodes = spread(nodes, per_file * 2)
                src.sampled = True
            for at, x in nodes:
                out.append(as_record(x, {"_path": path, "_ref": f"{path}#{at}" if at else path, "_key": at}))
    elif ext in CSV_EXT:
        for p in chosen:
            path = rel(root, p)
            with open(p, newline="", encoding="utf-8", errors="replace") as f:
                text = f.read()
            src.bytes_read += len(text)
            src.files_read += 1
            rows = list(csv.DictReader(io.StringIO(text), delimiter="\t" if p.suffix.lower() == ".tsv" else ","))
            idx = list(range(len(rows)))
            if len(idx) > per_file * 2:
                idx = spread(idx, per_file * 2)
                src.sampled = True
            for i in idx:
                out.append(as_record(rows[i], {"_path": path, "_ref": f"{path}#row={i + 1}", "_line": i + 2}))
    elif ext in DB_EXT:
        table = place.strip("/")
        for p in chosen:
            path = rel(root, p)
            try:
                with open(p, "rb") as f:  # read through open(), as thimble counts reads
                    data = f.read()
                conn = sqlite3.connect(":memory:")
                conn.deserialize(data)
            except (OSError, sqlite3.Error) as e:
                src.notes.append(f"{path}: {e}")
                continue
            src.bytes_read += len(data)
            src.files_read += 1
            names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")]
            if not table or table not in names:
                src.notes.append(f"{path}: name a table, as {glob}#<table>; its tables: {', '.join(names)}")
                conn.close()
                continue
            conn.row_factory = sqlite3.Row
            total = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            step = max(1, math.ceil(total / (per_file * 2)))
            if step > 1:
                src.sampled = True
            try:
                rows = conn.execute(f'SELECT rowid AS _rowid, * FROM "{table}" WHERE rowid % {step} = 0 OR {step} = 1')
            except sqlite3.Error:
                rows = conn.execute(f'SELECT * FROM "{table}"')
            for row in rows:
                d = dict(row)
                rid = d.pop("_rowid", None)
                out.append(as_record(d, {"_path": path, "_ref": f"{path}#{table}/{rid}" if rid is not None else path}))
            src.records_est += total
            cols = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}
            for k, vals in src.keyvals.items():
                if k in cols:
                    vals.update(key_of(r[0]) for r in conn.execute(f'SELECT DISTINCT "{k}" FROM "{table}"') if r[0] is not None)
            conn.close()
    else:  # one record per file: media, PDFs, binaries, or text read whole (#file)
        for p in chosen:
            path = rel(root, p)
            size = p.stat().st_size
            r: dict[str, Any] = {"_path": path, "_ref": path, "_bytes": size}
            if place == "file" and size <= 8 * 1024 * 1024:
                with open(p, "rb") as f:
                    r["text"] = f.read().decode("utf-8", "replace")
                src.bytes_read += size
            out.append(r)
            src.files_read += 1
    loaded = len(out)
    if src.keyvals and not (ext == ".json" or place.startswith("/") and ext not in DB_EXT) and ext not in DB_EXT:
        for k, vals in src.keyvals.items():
            vals.update(key_of(r.get(k)) for r in out if r.get(k) is not None)
    if loaded > budget * 3 // 2:
        out = spread(out, budget)
        src.sampled = True
    src.records_read = len(out)
    if not src.records_est:
        if src.bytes_read and src.bytes_read < src.bytes_total:
            src.records_est = int(loaded * src.bytes_total / src.bytes_read)
        elif src.files_read < len(files):
            src.records_est = int(loaded * len(files) / max(1, src.files_read))
        else:
            src.records_est = loaded
    return out, src


# ----------------------------------------------------------------------------------------------------------------------
# derived fields
# ----------------------------------------------------------------------------------------------------------------------


class Rec(dict):
    """A record as derived code reads it: r.field or r["field"], a missing field None, nested objects alike."""

    def __getattr__(self, k: str) -> Any:
        return wrap(self.get(k))

    def __getitem__(self, k: Any) -> Any:
        return wrap(dict.get(self, k))


def wrap(v: Any) -> Any:
    if isinstance(v, dict) and not isinstance(v, Rec):
        return Rec(v)
    if isinstance(v, list):
        return [wrap(x) for x in v] if any(isinstance(x, dict) for x in v[:50]) else v
    return v


def compile_code(code: str, where: str):
    code = code.strip().rstrip(";")
    lam = re.fullmatch(r"(?:lambda\s+\w+\s*:|\(?\s*\w+\s*\)?\s*=>)\s*(.+)", code, re.S)
    if lam:
        code = lam.group(1)
    if "\n" in code or re.search(r"(^|\s)return\s", code):
        body = "\n".join("    " + ln for ln in code.splitlines())
        src = f"def _derived(r):\n{body}\n"
        return compile(src, where, "exec"), True
    return compile(code, where, "eval"), False


def is_js(code: str) -> bool:
    """Whether a derived field's code is JavaScript: an arrow function or a function, or code that is no Python."""
    c = (code or "").strip()
    if "=>" in c or c.startswith("function") or "===" in c:
        return True
    try:
        compile_code(c, "<derived>")
        return False
    except SyntaxError:
        return True


ALL_READ = re.compile(r"all\s*(?:\.\s*(\w+)|\[\s*[\"'](\w+)[\"']\s*\])")
JS_STRING_MAX = 20_000  # chars of a string value passed to the JavaScript of derived fields


def js_safe(v: Any) -> Any:
    if isinstance(v, str) and len(v) > JS_STRING_MAX:
        return v[:JS_STRING_MAX]
    if isinstance(v, dict):
        return {k: js_safe(x) for k, x in v.items()}
    if isinstance(v, list):
        return [js_safe(x) for x in v]
    if isinstance(v, (bytes, bytearray)):
        return f"<{len(v)} bytes>"
    return v


# ----------------------------------------------------------------------------------------------------------------------
# the profile of one field
# ----------------------------------------------------------------------------------------------------------------------


@dataclass
class Stat:
    path: str
    ty: Ty
    optional: bool
    derived: bool = False
    label: str | None = None
    n: int = 0  # records or parent objects seen
    present: int = 0
    nulls: int = 0
    fits: int = 0
    misfits: list[tuple[Any, str]] = field(default_factory=list)  # (value, ref)
    misfit_count: Counter = field(default_factory=Counter)
    values: Counter = field(default_factory=Counter)
    capped: bool = False
    nums: list[float] = field(default_factory=list)
    times: list[datetime] = field(default_factory=list)
    lens: list[int] = field(default_factory=list)
    jtypes: Counter = field(default_factory=Counter)
    errors: int = 0
    error_eg: list[str] = field(default_factory=list)
    extra_keys: Counter = field(default_factory=Counter)  # an object's keys the type does not name
    objects: int = 0
    label_found: bool | None = None
    join_used: set = field(default_factory=set)
    kinds: Counter = field(default_factory=Counter)  # a union of object types: records per branch

    def add_value(self, v: Any) -> None:
        k = key_of(v)
        if k in self.values or len(self.values) < DISTINCT_MAX:
            self.values[k] += 1
        else:
            self.capped = True


class Profiler:
    def __init__(self, root: Path, types: Types, budget: int, labels: "Labels") -> None:
        self.root = root
        self.types = types
        self.budget = budget
        self.labels = labels
        self.records: dict[str, list[dict[str, Any]]] = {}
        self.sources: dict[str, list[Source]] = {}
        self.state: dict[str, str] = {}
        self.index: dict[tuple[str, str], dict[Any, list]] = {}
        self.code: dict[tuple[str, str], Any] = {}
        self.derive_errors: dict[tuple[str, str], list] = {}
        self.branch_of: dict[str, list[int]] = {}
        self.node: str | None = None  # node, for derived fields in JavaScript (main sets it)
        self.work: Path | None = None  # a folder for the input of node (main sets it)
        self.ns = {"rows": self.rows, "by": self.by, "one": self.one, "time": parse_time, "seconds": self.seconds,
                   "re": re, "math": math, "statistics": statistics, "json": json, "Counter": Counter,
                   "defaultdict": defaultdict, "datetime": datetime, "timedelta": timedelta, "timezone": timezone}

    # -- loading
    def join_targets(self) -> dict[str, set[str]]:
        """{type: the fields Refs point at}, from every declaration."""
        out: dict[str, set[str]] = defaultdict(set)
        seen: set[int] = set()

        def visit(ty: Ty) -> None:
            if id(ty) in seen:
                return
            seen.add(id(ty))
            if ty.k == "name" and ty.name == "Ref":
                t, f = ref_target(ty)
                out[t].add(f)
            for x in [*ty.items, *([ty.elem] if ty.elem else []), *([ty.index] if ty.index else []),
                      *(f.ty for f in ty.fields)]:
                visit(x)

        for d in self.types.decls.values():
            visit(d.ty)
        return out

    def load_all(self) -> None:
        targets = self.join_targets()
        for name, d in self.types.decls.items():
            if not d.sources:
                continue
            recs: list[dict[str, Any]] = []
            srcs = []
            for spec in d.sources:
                got, src = load(self.root, spec, self.budget // max(1, len(d.sources)), keys=targets.get(name, set()))
                recs += got
                srcs.append(src)
            self.records[name] = recs
            self.sources[name] = srcs
            self.state[name] = "raw"
        self.derive_js()

    def derive_js(self) -> None:
        """Every derived field whose code is JavaScript, computed by node in one run (profile_derive.mjs) over the
        records of its type and of every type its code reads as all.<Type>; its values and errors merged back."""
        fields = []
        for name in self.records:
            bs, which = self.branches(name)
            for bi, (_bname, bty) in enumerate(bs):
                for f in bty.fields if bty.k == "obj" else []:
                    if f.derive and is_js(f.derive):
                        only = None if which is None else [i for i, w in enumerate(which) if w == bi]
                        fields.append({"type": name, "field": f.name, "code": f.derive, "only": only})
        if not fields:
            return
        script = Path(__file__).with_name("profile_derive.mjs")
        node = self.node or shutil.which("node")
        need = {f["type"] for f in fields}
        for f in fields:  # the types its code reads, as all.Post or all["Post"]
            need |= {a or b for a, b in ALL_READ.findall(f["code"])}
        need &= set(self.records)
        problem = None
        if not node or not script.is_file():
            problem = "derived code in JavaScript needs node, which this sandbox cannot run"
        else:
            import subprocess  # noqa: PLC0415
            import tempfile  # noqa: PLC0415

            folder = self.work or Path(tempfile.gettempdir())
            folder.mkdir(parents=True, exist_ok=True)
            inp = folder / f"derive-{os.getpid()}.json"
            try:
                inp.write_text(json.dumps({"types": {t: [js_safe(r) for r in self.records[t]] for t in need},
                                           "derived": fields}, default=str), "utf-8")
                r = subprocess.run([node, str(script), str(inp)], capture_output=True, text=True, timeout=240)
                if r.returncode != 0:
                    problem = "node stopped: " + " ".join((r.stderr or "").split())[-200:]
                else:
                    got = json.loads(r.stdout)
                    for f in fields:
                        key = f"{f['type']}.{f['field']}"
                        rows = self.records[f["type"]]
                        for i, v in got.get("values", {}).get(key, []):
                            rows[i][f["field"]] = v
                        e = got.get("errors", {}).get(key)
                        if e:
                            self.derive_errors[(f["type"], f["field"])] = [e[0], list(e[1])]
            except (OSError, ValueError, subprocess.SubprocessError) as e:
                problem = f"node could not run: {type(e).__name__}"
            finally:
                inp.unlink(missing_ok=True)
        if problem:
            for f in fields:
                self.derive_errors[(f["type"], f["field"])] = [-1, [problem]]

    # -- helpers derived code calls
    def rows(self, name: str) -> list:
        if name not in self.records:
            raise KeyError(f"rows({name!r}): no type of records named {name!r}")
        self.derive(name)
        return [wrap(r) for r in self.records[name]]

    def by(self, name: str, fieldname: str) -> dict:
        key = (name, fieldname)
        if key not in self.index:
            idx: dict[Any, list] = defaultdict(list)
            for r in self.rows(name):
                v = dict.get(r, fieldname)
                idx[key_of(v)].append(r)
            self.index[key] = idx
        return _Default(self.index[key])

    def one(self, name: str, fieldname: str) -> dict:
        return {k: v[0] for k, v in self.by(name, fieldname).items()}

    @staticmethod
    def seconds(a: Any, b: Any) -> float | None:
        ta, tb = parse_time(a), parse_time(b)
        return (tb - ta).total_seconds() if ta and tb else None

    def branches(self, name: str) -> tuple[list[tuple[str, Ty]], list[int] | None]:
        """The object types of a union record type, as (name, type), and each record's branch (-1: none fits); for a
        plain record type, its one type and None."""
        ty = self.types.resolve(Ty("name", name=name))
        if ty.k == "union" and all(self.types.resolve(b).k == "obj" for b in ty.items):
            bs = [(b.name if b.k == "name" else self.tag(b, self.types.resolve(b), i), self.types.resolve(b))
                  for i, b in enumerate(ty.items)]
            if name not in self.branch_of:
                self.branch_of[name] = [self.best_branch(r, [b for _, b in bs]) for r in self.records.get(name, [])]
            return bs, self.branch_of[name]
        return [("", ty)], None

    def derive(self, name: str) -> None:
        """Each derived field of the records of `name`, computed once, in the order the type lists them (a union's on
        the records of its own branch); a field whose code raises is None on that record, and its errors are counted."""
        if self.state.get(name) != "raw":
            return
        self.state[name] = "deriving"
        bs, which = self.branches(name)
        recs = self.records[name]
        for bi, (_bname, bty) in enumerate(bs):
            if bty.k != "obj":
                continue
            mine = recs if which is None else [r for r, w in zip(recs, which) if w == bi]
            for f in bty.fields:
                if not f.derive or is_js(f.derive):
                    continue
                st = self.derive_errors.setdefault((name, f.name), [0, []])
                try:
                    code, is_def = compile_code(f.derive, f"<{name}.{f.name}>")
                except SyntaxError as e:
                    st[0] = -1
                    st[1].append(f"its code does not compile: {e.msg} at line {e.lineno}")
                    continue
                fn = None
                if is_def:
                    env = dict(self.ns)
                    exec(code, env)  # noqa: S102 — main's own code, in main's sandbox
                    fn = env["_derived"]
                for r in mine:
                    try:
                        v = fn(Rec(r)) if fn else eval(code, self.ns, {"r": Rec(r)})  # noqa: S307
                        r[f.name] = unwrap(v)
                    except Exception as e:  # noqa: BLE001
                        r[f.name] = None
                        st[0] += 1
                        if len(st[1]) < 2:
                            st[1].append(f"{type(e).__name__}: {str(e)[:80]} at {r.get('_ref')}")
        self.state[name] = "done"

    # -- profiling
    def profile_type(self, name: str) -> dict[str, Any]:
        self.derive(name)
        recs = self.records.get(name, [])
        out: dict[str, Any] = {"name": name, "records": recs, "branches": []}
        bs, which = self.branches(name)
        if which is not None:
            # a union of object types: each record goes to the branch it fits best, by literal fields first
            groups: dict[int, list] = defaultdict(list)
            for r, w in zip(recs, which):
                groups[w].append(r)
            for i, (bname, bty) in enumerate(bs):
                stats: dict[str, Stat] = {}
                fit_all = self.walk_records(groups.get(i, []), bty, stats, name)
                out["branches"].append({"name": bname, "n": len(groups.get(i, [])), "stats": stats, "fit_all": fit_all})
            out["other"] = groups.get(-1, [])
        else:
            stats = {}
            fit_all = self.walk_records(recs, bs[0][1], stats, name)
            out["branches"].append({"name": None, "n": len(recs), "stats": stats, "fit_all": fit_all})
        return out

    def best_branch(self, r: dict[str, Any], branches: list[Ty]) -> int:
        best, score = -1, -1.0
        for i, b in enumerate(branches):
            lits = [f for f in b.fields if self.lit_values(f.ty) is not None and not f.optional]
            if any(key_of(r.get(f.name)) not in self.lit_values(f.ty) for f in lits):
                continue
            req = [f for f in b.fields if not f.optional and not f.derive]
            s = (sum(1 for f in req if f.name in r) / len(req)) if req else 0.5
            s += 0.001 * len(lits)
            if s > score:
                best, score = i, s
        return best

    def lit_values(self, ty: Ty) -> set | None:
        ty = self.types.resolve(ty)
        if ty.k == "lit":
            return {ty.value}
        if ty.k == "union":
            opts = [self.types.resolve(x) for x in ty.items]
            if opts and all(o.k == "lit" for o in opts):
                return {o.value for o in opts}
        return None

    def walk_records(self, recs: list[dict[str, Any]], ty: Ty, stats: dict[str, Stat], name: str) -> int:
        fit_all = 0
        for r in recs:
            ok = self.walk(r, ty, "", stats, r.get("_ref", ""), 0, top=True)
            fit_all += ok
        return fit_all

    def walk(self, v: Any, ty: Ty, path: str, stats: dict[str, Stat], ref: str, depth: int, top: bool = False) -> bool:
        """Profile the object `v` against the object type `ty`, its fields under `path`. True when every required field
        fits."""
        ty = self.types.resolve(ty)
        if ty.k != "obj" or not isinstance(v, dict):
            return True
        ok = True
        named = {f.name for f in ty.fields}
        holder = stats.setdefault(path or "(record)", Stat(path or "(record)", ty, False))
        holder.objects += 1
        for k in v if ty.index is None else ():
            if k not in named and not (top and k in META):
                holder.extra_keys[k] += 1
        for f in ty.fields:
            p = f"{path}.{f.name}" if path else f.name
            if f.derive and f.name not in v and not top:
                continue  # a derived field is computed on the records of its own type, not where the type is nested
            st = stats.get(p)
            if st is None:
                st = stats[p] = Stat(p, f.ty, f.optional, derived=bool(f.derive), label=f.label)
            st.n += 1
            if f.label is not None:
                self.label_value(st, f, v, ref)
                continue
            if f.name not in v:
                if not f.optional:
                    ok = False
                continue
            val = v[f.name]
            st.present += 1
            if val is None:
                st.nulls += 1
                if not f.optional and not self.allows(f.ty, None):
                    ok = False
                continue
            fits = self.value(st, f.ty, val, p, stats, ref, depth)
            ok &= fits or f.optional
        if ty.index is not None:
            p = f"{path}{{}}" if path else "{}"
            for k, val in v.items():
                if k in named or (top and k in META):
                    continue
                st = stats.get(p) or stats.setdefault(p, Stat(p, ty.index, True))
                st.n += 1
                st.present += 1
                self.value(st, ty.index, val, p, stats, ref, depth)
        return ok

    def allows(self, ty: Ty, v: Any) -> bool:
        ty = self.types.resolve(ty)
        if ty.k == "any":
            return True
        if ty.k == "prim":
            return ty.name in ("null", "undefined") and v is None
        if ty.k == "lit":
            return ty.value is None and v is None
        if ty.k == "union":
            return any(self.allows(x, v) for x in ty.items)
        return False

    def fits(self, ty: Ty, v: Any) -> bool:
        """Whether `v` fits `ty` (objects by their kind alone: their fields are profiled one by one)."""
        ty = self.types.resolve(ty)
        k = ty.k
        if k in ("any", "fn"):
            return True
        if k == "prim":
            jt = jtype(v)
            return (ty.name == jt or (ty.name in ("null", "undefined") and v is None) or
                    (ty.name == "object" and jt in ("object", "array")) or (ty.name == "bigint" and jt == "number"))
        if k == "lit":
            if isinstance(ty.value, bool):
                return v is ty.value
            if isinstance(ty.value, (int, float)):
                return isinstance(v, (int, float)) and not isinstance(v, bool) and v == ty.value
            return v == ty.value
        if k == "union":
            return any(self.fits(x, v) for x in ty.items)
        if k == "arr":
            return isinstance(v, list)
        if k == "tup":
            return isinstance(v, list)
        if k == "obj":
            return isinstance(v, dict)
        if k == "name":
            if ty.name in ("Time", "Date"):
                return parse_time(v) is not None
            if ty.name == "Ref":
                return True  # judged by the join
            if ty.name == "Label":
                return True
        return True

    def core(self, ty: Ty) -> Ty:
        """`ty` resolved, and a union of one type with null or undefined read as that one type (Time | null is a Time)."""
        ty = self.types.resolve(ty)
        if ty.k == "union":
            rest = [x for x in ty.items if not (self.types.resolve(x).k == "prim" and self.types.resolve(x).name in
                                                ("null", "undefined")) and not (x.k == "lit" and x.value is None)]
            if len(rest) == 1:
                return self.types.resolve(rest[0])
        return ty

    def value(self, st: Stat, ty: Ty, val: Any, path: str, stats: dict[str, Stat], ref: str, depth: int) -> bool:
        rty = self.types.resolve(ty)
        cty = self.core(rty)
        is_time = cty.k == "name" and cty.name in ("Time", "Date")
        st.jtypes[jtype(val)] += 1
        ok = self.fits(rty, val)
        branch = self.object_branch(cty, val)  # (type, tag): the object type `val` is profiled as, tag for a union's
        if branch is not None and branch[1] == "":  # a dict that fits none of a union's object types
            ok = False
        if ok:
            st.fits += 1
        else:
            mk = key_of(val) if not isinstance(val, (dict, list)) else f"<{jtype(val)}>"
            if len(st.misfits) < EXAMPLES and mk not in st.misfit_count:
                st.misfits.append((val, ref))
            st.misfit_count[mk] += 1
        if isinstance(val, (str, int, float, bool)) or val is None:
            st.add_value(val)
        if isinstance(val, (int, float)) and not isinstance(val, bool) and not is_time:
            if len(st.nums) < 200_000 and not math.isnan(val):
                st.nums.append(float(val))
        if isinstance(val, str) and len(st.lens) < 200_000:
            st.lens.append(len(val))
        if is_time:
            t = parse_time(val)
            if t is not None and len(st.times) < 200_000:
                st.times.append(t)
        if depth >= DEPTH_MAX:
            return ok
        # nested: an object's fields (a union's object type under <its tag>), an array's elements
        if branch is not None and isinstance(val, dict):
            bty, tag = branch
            if tag is not None:
                st.kinds[tag or "(none)"] += 1
            if bty is not None:
                ok &= self.walk(val, bty, f"{path}<{tag}>" if tag else path, stats, ref, depth + 1)
        elif isinstance(val, list):
            if len(st.lens) < 200_000:
                st.lens.append(len(val))
            arr = cty if cty.k == "arr" else None
            if cty.k == "union":
                arr = next((self.types.resolve(x) for x in cty.items if self.types.resolve(x).k == "arr"), None)
            el = arr.elem if arr is not None else None
            if el is not None:
                p = f"{path}[]"
                est = stats.get(p) or stats.setdefault(p, Stat(p, el, False))
                for x in val[:2000]:
                    est.n += 1
                    est.present += 1
                    if x is None:
                        est.nulls += 1
                        continue
                    self.value(est, el, x, p, stats, ref, depth + 1)
        return ok

    def object_branch(self, ty: Ty, val: Any) -> tuple[Ty | None, str | None] | None:
        """(the object type `val` is profiled as, its tag) for an object type (tag None) or a union of object types (the
        tag names the branch: its literal field's value, or its type's name; '' when `val` fits none); None otherwise."""
        if ty.k == "obj":
            return ty, None
        if ty.k == "union" and isinstance(val, dict):
            named = [x for x in ty.items if self.types.resolve(x).k == "obj"]
            objs = [self.types.resolve(x) for x in named]
            if not objs:
                return None
            if len(objs) == 1:
                return objs[0], None
            i = self.best_branch(val, objs)
            if i < 0:
                return None, ""
            return objs[i], self.tag(named[i], objs[i], i)
        return None

    def tag(self, raw: Ty, ty: Ty, i: int) -> str:
        """A branch's name: its type's name, else the values of its single-valued literal fields (system/init)."""
        if raw.k == "name":
            return raw.name
        vals = []
        for f in ty.fields:
            lits = self.lit_values(f.ty)
            if lits is not None and len(lits) == 1 and not f.optional:
                vals.append(str(next(iter(lits))))
        return "/".join(vals) if vals else f"#{i + 1}"

    def label_value(self, st: Stat, f: Field, rec: dict[str, Any], ref: str) -> None:
        values = self.labels.values(f.label) if f.label else None
        if values is None:
            values = self.labels.values(f.name)
        st.label_found = values is not None
        if values is None:
            return
        v = values.get(ref)
        if v is None:
            return
        st.present += 1
        lits = self.lit_values(f.ty.items[0]) if f.ty.k == "name" and f.ty.name == "Label" and f.ty.items else self.lit_values(f.ty)
        if lits is None or v in lits:
            st.fits += 1
        else:
            st.misfit_count[v] += 1
        st.add_value(v)


class _Default(dict):
    """by()'s answer: a missing key gives an empty list."""

    def __missing__(self, k: Any) -> list:
        return []

    def get(self, k: Any, default: Any = None) -> Any:  # noqa: D102
        return dict.get(self, key_of(k), default if default is not None else [])

    def __getitem__(self, k: Any) -> Any:
        return dict.get(self, key_of(k), [])


def unwrap(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, timedelta):
        return v.total_seconds()
    if isinstance(v, (set, tuple)):
        return list(v)
    return v


# ----------------------------------------------------------------------------------------------------------------------
# labels: a field's values from the workspace's label of its name
# ----------------------------------------------------------------------------------------------------------------------


class Labels:
    def __init__(self, ws: Path | None) -> None:
        self.ws = ws
        self.cache: dict[str, dict[str, Any] | None] = {}

    def values(self, name: str) -> dict[str, Any] | None:
        """{record ref: the label's value} of the label `name`, or None when the workspace has no such label."""
        if name in self.cache:
            return self.cache[name]
        out = None
        if self.ws is not None:
            try:
                try:
                    from . import kernel_thimble as kt  # noqa: PLC0415
                except ImportError:  # run as a script beside a copy of it (profile_data.run_engine), by its file's name
                    kt = importlib.import_module("kernel_thimble")

                kt.WS = str(self.ws)
                df = kt.labels(name, negatives=True)
                out = {str(r["ref"]): r["effective"] for _, r in df.iterrows()}
            except Exception:  # noqa: BLE001 — no such label, or none can be read: the profile says it is not defined
                out = None
        self.cache[name] = out
        return out


def workspace(given: str | None = None) -> Path | None:
    """The workspace folder of the corpus this runs in: `given` (--ws), THIMBLE_WS (terminal mode), else the one
    registered for the folder; None outside thimble."""
    for ws in (given, os.environ.get("THIMBLE_WS")):
        if ws and Path(ws).is_dir():
            return Path(ws)
    try:
        from . import config  # noqa: PLC0415

        name = config.workspace_for_cwd(Path.cwd())
        if name:
            p = config.workspace_dir(name)
            return p if p.is_dir() else None
    except Exception:  # noqa: BLE001
        return None
    return None


# ----------------------------------------------------------------------------------------------------------------------
# the report
# ----------------------------------------------------------------------------------------------------------------------


def ref_target(ty: Ty) -> tuple[str, str]:
    """(type, field) a Ref names: Ref<Agent, "id">, Ref<Agent> (its `id`) or Ref<"Agent.id">."""
    a = ty.items[0] if ty.items else None
    if a is not None and a.k == "lit" and isinstance(a.value, str):
        t, _, f = a.value.partition(".")
        return t, f or "id"
    t = a.name if a is not None and a.k == "name" else "?"
    f = ty.items[1].value if len(ty.items) > 1 and ty.items[1].k == "lit" else "id"
    return t, str(f)


def num(x: float) -> str:
    if isinstance(x, float) and not x.is_integer():
        return f"{x:,.3g}" if abs(x) < 1000 else f"{x:,.0f}"
    return f"{int(x):,}"


def pct(a: int, b: int) -> str:
    if not b:
        return "–"
    p = 100.0 * a / b
    if 0 < a < b and p >= 99.95:
        return ">99.9%"
    if 0 < a and p < 0.05:
        return "<0.1%"
    return f"{p:.0f}%" if p == int(p) or 1 <= p <= 99 else f"{p:.1f}%"


def span_text(lo: datetime, hi: datetime) -> str:
    d = (hi - lo).total_seconds()
    if d < 120:
        s = f"{d:.0f} s"
    elif d < 7200:
        s = f"{d / 60:.0f} min"
    elif d < 2 * 86400:
        s = f"{d / 3600:.1f} h"
    else:
        s = f"{d / 86400:.1f} days"
    return f"{lo:%Y-%m-%d %H:%M:%S} .. {hi:%Y-%m-%d %H:%M:%S} UTC ({s})"


def show_value(k: Any, n: int = 32) -> str:
    if isinstance(k, str):
        return snip(k, n)
    return json.dumps(k) if k is None or isinstance(k, bool) else str(k)


def top_text(c: Counter, n: int = TOP, total: int | None = None) -> str:
    items = c.most_common(n)
    s = ", ".join(f"{show_value(k)} {v:,}" for k, v in items)
    rest = len(c) - len(items)
    return s + (f", +{rest:,} more" if rest > 0 else "")


class Report:
    def __init__(self, prof: Profiler) -> None:
        self.p = prof
        self.lines: list[str] = []

    def w(self, s: str = "") -> None:
        self.lines.append(s)

    def source_line(self, name: str) -> str:
        parts = []
        for s in self.p.sources.get(name, []):
            nf = len(s.files)
            what = f"{s.spec}: {nf:,} file{'s' if nf != 1 else ''}, {s.bytes_total / 1e6:,.1f} MB"
            if s.sampled:
                what += f", {s.records_read:,} records read of ~{s.records_est:,} (a sample"
                what += f" of {s.files_read:,} files)" if s.files_read < nf else ")"
            else:
                what += f", {s.records_read:,} records (all read)"
            parts.append(what)
            for note in s.notes:
                parts.append(f"  note: {note}")
            if s.bad_lines:
                parts.append(f"  {s.bad_lines:,} lines or files are not JSON, e.g. {', '.join(s.bad_refs)}")
        return "\n  ".join(parts)

    def run(self) -> str:
        t = self.p.types
        rec_types = [n for n, d in t.decls.items() if d.sources]
        for name in rec_types:
            self.w(f"{name}  ←  {self.source_line(name)}")
            prof = self.p.profile_type(name)
            total = len(prof["records"])
            multi = len(prof["branches"]) > 1
            if multi:
                shares = ", ".join(f"{b['name']} {b['n']:,} ({pct(b['n'], total)})" for b in prof["branches"])
                other = prof.get("other") or []
                self.w(f"  kinds: {shares}" + (f"; fits none of them: {len(other):,} ({pct(len(other), total)}), "
                                              f"{self.other_text(name, other)}" if other else ""))
            for b in prof["branches"]:
                if multi and not b["n"]:
                    continue
                if multi:
                    self.w(f"  {b['name']} ({b['n']:,} records)")
                ind = "    " if multi else "  "
                if b["n"]:
                    self.w(f"{ind}every required field fits: {b['fit_all']:,} of {b['n']:,} ({pct(b['fit_all'], b['n'])})")
                self.fields(b["stats"], ind, name)
            self.w()
        free = [n for n, d in t.decls.items() if not d.sources]
        if t.unknown_names:
            self.w(f"Names the types use but do not declare (read as unknown): {', '.join(sorted(t.unknown_names))}")
        if free:
            self.w(f"Types with no @from, profiled where a record type uses them: {', '.join(free)}")
        if not rec_types:
            self.w("No type names its records: give a type `/** @from <glob> */` in its doc comment.")
        return "\n".join(self.lines).rstrip() + "\n"

    def other_text(self, name: str, recs: list) -> str:
        """What the records that fit no branch hold: the values of the field every branch gives a literal, such as
        `type`, else examples."""
        bs, _ = self.p.branches(name)
        tags = None
        for _, b in bs:
            lit = {f.name for f in b.fields if self.p.lit_values(f.ty) is not None and not f.optional}
            tags = lit if tags is None else tags & lit
        if tags:
            f = sorted(tags)[0]
            return f"by {f}: " + top_text(Counter(key_of(r.get(f)) for r in recs), 6) + f"; e.g. {recs[0].get('_ref')}"
        return "e.g. " + self.eg_records(recs)

    def eg_records(self, recs: list) -> str:
        out = []
        for r in recs[:EXAMPLES]:
            keys = [k for k in r if k not in META][:4]
            out.append(f"{r.get('_ref')} {{{', '.join(keys)}}}")
        return "; ".join(out)

    def fields(self, stats: dict[str, Stat], ind: str, tname: str) -> None:
        width = min(28, max([len(self.label(s)) for s in stats.values() if s.path != "(record)"] or [8]))
        for path, st in stats.items():
            if path == "(record)" or (st.objects and not st.n):
                continue
            self.w(f"{ind}{self.label(st).ljust(width)}  {self.describe(st, tname)}")
        # untyped keys, at each object level
        for path, st in stats.items():
            if st.objects and st.extra_keys:
                where = "the record" if path == "(record)" else path
                keys = ", ".join(f"{k} ({pct(c, st.objects)})" for k, c in st.extra_keys.most_common(8))
                more = len(st.extra_keys) - 8
                self.w(f"{ind}in {where} but not in the types: {keys}" + (f", +{more} more" if more > 0 else ""))

    @staticmethod
    def label(st: Stat) -> str:
        return st.path + ("?" if st.optional else "")

    def describe(self, st: Stat, tname: str) -> str:
        t = self.p.types
        rty = self.p.core(st.ty)
        kind = "derived " if st.derived else ""
        tshow = t.show(st.ty)
        parts = [f"{kind}{tshow}"]
        if st.label is not None:
            name = st.label or st.path.split(".")[-1]
            if st.label_found is False or st.label_found is None:
                return f"label  not defined yet (no label {name!r} in this workspace; apply_label defines it)"
            parts = [f"label {name!r}"]
            parts.append(f"on {st.present:,} of {st.n:,} records ({pct(st.present, st.n)})")
            if st.values:
                parts.append(top_text(st.values))
            if st.misfit_count:
                parts.append(f"values the type does not list: {top_text(st.misfit_count, 3)}")
            return "  ".join(parts)
        if st.derived:
            err = self.p.derive_errors.get((tname, st.path), [0, []])
            if err[0] == -1:
                return f"derived  {err[1][0]}"
            if err[0]:
                parts.append(f"code raised on {err[0]:,} records ({pct(err[0], st.n)}), e.g. {err[1][0]}")
        if st.n and (st.present < st.n):
            parts.append(f"present {pct(st.present, st.n)}" + ("" if st.optional else f" ({st.n - st.present:,} lack it)"))
        if st.nulls:
            parts.append(f"null {st.nulls:,}")
        vals = st.present - st.nulls
        if vals <= 0:
            return "  ".join(parts)
        # the fit, in the type's own words
        if st.fits < vals:
            verb = "parses for" if rty.k == "name" and rty.name in ("Time", "Date") else "fits"
            rest = ", ".join(f"{snip(v)} at {r}" for v, r in st.misfits)
            others = top_text(st.misfit_count, 3)
            parts.append(f"{verb} {pct(st.fits, vals)}; the rest: {others}; e.g. {rest}")
        # what the values are
        lits = self.p.lit_values(rty)
        if st.kinds:
            parts.append("kinds: " + top_text(st.kinds, 8))
        elif rty.k == "name" and rty.name in ("Time", "Date"):
            if st.times:
                parts.append(span_text(min(st.times), max(st.times)))
        elif rty.k == "name" and rty.name == "Ref":
            parts.append(self.join(st, rty))
        elif lits is not None:
            parts.append(top_text(Counter({k: v for k, v in st.values.items() if k in lits}), 8))
        elif st.jtypes.get("number") and st.nums:
            xs = sorted(st.nums)
            parts.append(f"{num(xs[0])} .. {num(xs[-1])}, median {num(xs[len(xs) // 2])}, "
                         f"{self.distinct(st)} distinct")
            if len(st.values) <= 6:
                parts.append(top_text(st.values, 6))
        elif st.jtypes.get("boolean") and set(st.jtypes) <= {"boolean", "null"}:
            parts.append(top_text(st.values, 2))
        elif st.jtypes.get("string"):
            d = len(st.values)
            lens = sorted(st.lens)
            if d <= 12 or st.values.most_common(1)[0][1] >= 0.05 * vals:
                parts.append(f"{self.distinct(st)} distinct: {top_text(st.values)}")
            else:
                parts.append(f"{self.distinct(st)} distinct, e.g. {', '.join(snip(k, 24) for k, _ in st.values.most_common(2))}")
            if lens and lens[-1] > 40:
                parts.append(f"length {lens[0]:,} .. {lens[-1]:,}, median {lens[len(lens) // 2]:,}")
        elif st.jtypes.get("array"):
            lens = sorted(st.lens)
            if lens:
                parts.append(f"length {lens[0]:,} .. {lens[-1]:,}, median {lens[len(lens) // 2]:,}")
        elif rty.k in ("any",):
            parts.append("as " + ", ".join(f"{k} {pct(v, vals)}" for k, v in st.jtypes.most_common()))
        if rty.k == "any" and st.jtypes and "as " not in parts[-1]:
            parts.append("as " + ", ".join(f"{k} {pct(v, vals)}" for k, v in st.jtypes.most_common()))
        return "  ".join(parts)

    def distinct(self, st: Stat) -> str:
        return f"{len(st.values):,}+" if st.capped else f"{len(st.values):,}"

    def join(self, st: Stat, rty: Ty) -> str:
        tgt, f = ref_target(rty)
        if tgt not in self.p.records:
            return f"join to {tgt}.{f}: {tgt} names no records (give it @from)"
        srcs = self.p.sources.get(tgt, [])
        self.p.derive(tgt)  # a join can point at a derived field
        whole = bool(srcs) and all(x.keyvals.get(f) for x in srcs)
        keys = set().union(*(x.keyvals[f] for x in srcs)) if whole else {key_of(r.get(f)) for r in self.p.records[tgt]}
        keys.discard(None)
        hit = sum(c for k, c in st.values.items() if k in keys)
        allv = sum(st.values.values())
        miss = Counter({k: c for k, c in st.values.items() if k not in keys})
        s = f"join to {tgt}.{f} holds for {pct(hit, allv)} ({hit:,} of {allv:,})"
        if miss:
            s += f"; not found: {top_text(miss, 3)}"
        used = sum(1 for k in keys if k in st.values)
        s += f"; {used:,} of {len(keys):,} {tgt}.{f} used"
        if not (whole and all(x.keys_whole for x in srcs)) and any(x.sampled for x in srcs):
            s += f" ({tgt} was read on a sample)"
        return s


# ----------------------------------------------------------------------------------------------------------------------
# the plain profile: files grouped by pattern, their fields with counts and distinct values
# ----------------------------------------------------------------------------------------------------------------------

_IDISH = re.compile(r"[0-9a-f]*\d[0-9a-f]*(?:-[0-9a-f]+)+|(?=[0-9a-f]*\d)[0-9a-f]{6,}|\d+", re.I)


def norm_seg(s: str) -> str:
    """A path segment with its ids and numbers as `*`, its suffix kept: agent-a0269b83.jsonl is agent-*.jsonl."""
    stem, dot, ext = s.rpartition(".") if "." in s[1:] else (s, "", "")
    return _IDISH.sub("*", stem) + dot + ext


def group_files(root: Path, files: list[Path]) -> dict[str, list[Path]]:
    by: dict[tuple, list[Path]] = defaultdict(list)
    for p in files:
        parts = p.relative_to(root).parts
        base = norm_seg(parts[-1])
        # files named by ids (notebook/3df2.json) group by their folder's name too; files with names of their own
        # (runs/<run>/events.jsonl) group across folders
        parent = norm_seg(parts[-2]) if "*" in base and len(parts) > 1 else None
        by[(len(parts), base, parent)].append(p)
    out: dict[str, list[Path]] = {}
    for (_depth, base, _parent), ps in by.items():
        rels = [p.relative_to(root).parts for p in ps]
        segs = []
        for i in range(len(rels[0]) - 1):
            vals = {r[i] for r in rels}
            segs.append(rels[0][i] if len(vals) == 1 else "*")
        last = {r[-1] for r in rels}
        segs.append(rels[0][-1] if len(last) == 1 else base)
        out["/".join(segs)] = sorted(ps)
    return out


def plain_fields(recs: list[dict[str, Any]]) -> list[tuple[str, int, Counter, bool]]:
    counts: dict[str, Counter] = {}
    present: Counter = Counter()
    capped: set[str] = set()
    for r in recs:
        for k, v in r.items():
            if k in META:
                continue
            present[k] += 1
            c = counts.setdefault(k, Counter())
            kv = key_of(v)
            if kv in c or len(c) < DISTINCT_MAX:
                c[kv] += 1
            else:
                capped.add(k)
    return [(k, present[k], counts[k], k in capped) for k in present]


def is_text(ps: list[Path]) -> bool:
    """Whether a group holds text or code files with no records to count, such as .py, .md or files with no suffix."""
    ext = ps[0].suffix.lower()
    if ext in LINE_EXT or ext in CSV_EXT or ext in DB_EXT or ext == ".json":
        return False
    if ext in TEXT_EXT:
        return True
    try:
        with open(ps[0], "rb") as f:
            head = f.read(2048)
    except OSError:
        return False
    return b"\0" not in head and bool(head)


def plain(root: Path, globs: list[str], budget: int) -> str:
    files: list[Path] = []
    for g in globs or ["**/*"]:
        files += expand(root, g)
    files = sorted({p for p in files if not any(part.startswith(".") for part in p.relative_to(root).parts)})
    groups = group_files(root, files)
    size = {k: sum(p.stat().st_size for p in ps) for k, ps in groups.items()}
    data = sorted((k for k in groups if not is_text(groups[k])), key=lambda k: -size[k])
    text = [k for k in groups if is_text(groups[k])]
    lines = [f"{len(files):,} files, {sum(size.values()) / 1e6:,.1f} MB: text and code files by folder, then "
             f"{len(data):,} groups of data or media files, largest first"]
    texts: list[str] = []
    # text and code files, by their first folder, ahead of the data since their lines are few
    by_dir: dict[str, list[Path]] = defaultdict(list)
    for k in text:
        for p in groups[k]:
            parts = p.relative_to(root).parts
            by_dir[parts[0] + "/" if len(parts) > 1 else "(top folder)"].append(p)
    for d in sorted(by_dir):
        ps = by_dir[d]
        exts = Counter(p.suffix.lower() or "(none)" for p in ps)
        nlines = 0
        for p in spread(ps, 200):
            with open(p, "rb") as f:
                nlines += sum(1 for _ in f)
        est = nlines * len(ps) // max(1, min(len(ps), 200))
        texts.append(f"{d}  {len(ps):,} text file{'s' if len(ps) != 1 else ''} ({top_text(exts, 6)}), "
                     f"{sum(p.stat().st_size for p in ps) / 1e6:,.1f} MB, {est:,} lines")
    lines += texts
    for pat in data[:GROUPS_PLAIN]:
        ps = groups[pat]
        ext = ps[0].suffix.lower()
        head = f"{pat}  {len(ps):,} file{'s' if len(ps) != 1 else ''}, {size[pat] / 1e6:,.1f} MB"
        if ext in DB_EXT:
            lines.append(head)
            for p in ps[:3]:
                try:
                    with open(p, "rb") as f:
                        blob = f.read()
                    conn = sqlite3.connect(":memory:")
                    conn.deserialize(blob)
                    names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                    conn.close()
                except (OSError, sqlite3.Error) as e:
                    lines.append(f"  {rel(root, p)}: {e}")
                    continue
                for t in names:
                    recs, src = load(root, f"{rel(root, p)}#{t}", budget // max(1, len(names)), files=[p])
                    lines.append(f"  table {t} in {rel(root, p)}: {src.records_est:,} rows")
                    lines += plain_block(recs, "    ")
            if len(ps) > 3:
                lines.append(f"  (and {len(ps) - 3:,} more files like these)")
            continue
        if ext in LINE_EXT or ext == ".json" or ext in CSV_EXT:
            recs, src = load(root, pat + ("#/" if ext == ".json" else ""), budget, files=ps)
            what = f"{src.records_est:,} records" + (" (counts from a sample)" if src.sampled else "")
            lines.append(f"{head}, {what}")
            if src.bad_lines:
                lines.append(f"  {src.bad_lines:,} lines are not JSON")
            if ext == ".json" and recs and all(set(r) - set(META) <= {"value"} for r in recs[:20]):
                kinds = Counter(jtype(r.get("value")) for r in recs)
                lines.append(f"  each file: {top_text(kinds)}")
                continue
            lines += plain_block(recs, "  ")
            continue
        lines.append(head)
    if len(data) > GROUPS_PLAIN:
        rest = data[GROUPS_PLAIN:]
        exts = Counter(groups[k][0].suffix.lower() or "(none)" for k in rest)
        lines.append(f"(and {len(rest):,} smaller groups: {top_text(exts, 8)})")
    return "\n".join(lines) + "\n"


def plain_block(recs: list[dict[str, Any]], ind: str) -> list[str]:
    out = []
    fields = plain_fields(recs)
    if not fields:
        return out
    width = min(24, max(len(k) for k, *_ in fields))
    for k, n, c, capped in fields[:FIELDS_PLAIN]:
        d = f"{len(c):,}+" if capped else f"{len(c):,}"
        s = f"{ind}{k.ljust(width)}  {n:,}  distinct {d}"
        if len(c) <= 8:
            s += ": " + ", ".join(f"{show_value(v, 28)} {m:,}" for v, m in c.most_common(8))
        out.append(s)
    if len(fields) > FIELDS_PLAIN:
        out.append(f"{ind}(and {len(fields) - FIELDS_PLAIN} more fields)")
    return out


# ----------------------------------------------------------------------------------------------------------------------
# the command
# ----------------------------------------------------------------------------------------------------------------------


def save(out: Path | None, input_name: str, text_in: str, profile: str) -> Path | None:
    if out is None:
        return None
    try:
        out.mkdir(parents=True, exist_ok=True)
        hist = out / "history"
        hist.mkdir(exist_ok=True)
        n = 1 + max([int(p.name.split("-")[0]) for p in hist.glob("*-profile.txt") if p.name.split("-")[0].isdigit()]
                    or [0])
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (hist / f"{n:02d}-{input_name}").write_text(text_in, "utf-8")
        (hist / f"{n:02d}-profile.txt").write_text(f"# {stamp}\n{profile}", "utf-8")
        for stale in ("types.ts", "description.md"):
            if stale != input_name and (out / stale).exists():
                (out / stale).unlink()
        (out / input_name).write_text(text_in, "utf-8")
        (out / "profile.txt").write_text(profile, "utf-8")
        return out
    except OSError:
        return None


def out_dir(given: str | None, ws: Path | None) -> Path | None:
    if given:
        return Path(given)
    return ws / PROFILE_DIR if ws else None


def run(cmd: str, text_in: str, *, root: Path, globs: list[str] | None = None, budget: int = BUDGET,
        ws: Path | None = None, out: Path | None = None, node: str | None = None) -> tuple[int, str, Path | None]:
    """(exit code, the profile, the folder it was saved in) of `types` (text_in: TypeScript types) or `files`
    (text_in: a plain description, globs: the files to profile)."""
    t0 = _time.monotonic()
    if cmd == "types":
        try:
            decls = parse(text_in)
        except TypesError as e:
            return 2, f"thimble-profile: the types do not parse: {e}\n", None
        prof = Profiler(root, Types(decls), budget, Labels(ws))
        prof.node = node
        prof.work = (out / "work") if out else None
        prof.load_all()
        body = Report(prof).run()
        n = len([d for d in decls.values() if d.sources])
        text = f"Profile of {n} record types in {root} ({_time.monotonic() - t0:.1f} s)\n\n{body}"
        return 0, text, save(out, "types.ts", text_in, text)
    body = plain(root, globs or [], budget)
    text = f"Files in {root} ({_time.monotonic() - t0:.1f} s)\n\n{body}"
    return 0, text, save(out, "description.md", text_in, text)


def cut(text: str, saved: Path | None) -> str:
    """The profile as printed: PRINT_MAX chars at most, the rest named in the saved file."""
    if len(text) <= PRINT_MAX:
        return text
    at = text.rfind("\n", 0, PRINT_MAX)
    where = f"{saved}/profile.txt" if saved else "the saved profile"
    return text[:at] + f"\n… cut here: {len(text) - at:,} more characters are in {where}\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="thimble-profile", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("types", help="check TypeScript types (stdin, or a file) against the records and profile them")
    t.add_argument("file", nargs="?", help="the types file (default: stdin)")
    f = sub.add_parser("files", help="a simple per-file profile with no types; stdin is your description of the data")
    f.add_argument("globs", nargs="*")
    f.add_argument("--input", help="the description's file (default: stdin)")
    for p in (t, f):
        p.add_argument("--out", help="the folder the input and profile are saved in (default: the workspace's "
                                     f"{PROFILE_DIR})")
        p.add_argument("--budget", type=int, default=BUDGET, help=f"records read of one kind (default {BUDGET})")
        p.add_argument("--root", default=".", help="the corpus folder (default: the current folder)")
        p.add_argument("--ws", help="the workspace folder (default: the one registered for the corpus)")
        p.add_argument("--node", help="node, for derived fields in JavaScript (default: node on PATH)")
    a = ap.parse_args(argv)
    ws = workspace(a.ws)
    if a.cmd == "types":
        text_in = Path(a.file).read_text("utf-8") if a.file else sys.stdin.read()
        globs = None
    else:
        text_in = Path(a.input).read_text("utf-8") if a.input else ("" if sys.stdin.isatty() else sys.stdin.read())
        globs = a.globs
    code, text, saved = run(a.cmd, text_in, root=Path(a.root).resolve(), globs=globs, budget=a.budget, ws=ws,
                            out=out_dir(a.out, ws), node=a.node)
    (sys.stdout if code == 0 else sys.stderr).write(cut(text, saved))
    if saved:
        sys.stdout.write(f"\n(saved in {saved})\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
