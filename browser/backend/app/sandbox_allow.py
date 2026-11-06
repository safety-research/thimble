"""What counts as installing software or downloading files: `installs` for a Bash command line, which thimble's config's
`installs` sends to the analyst (userconf.Session.verdict), and `code_installs` for a card's code, which an agent may
not run (tools). Standard library only."""
from __future__ import annotations

import functools
import os
import re
import shlex

# The commands that install software or download files (installs), for thimble's config's `installs` (userconf): a
# program alone stands for every use of it, a command for the words it starts with, a module for `python -m <words>`.
INSTALL_PROGRAMS = ("curl", "wget", "aria2c", "pipx", "uvx", "npx", "pnpx", "bunx", "corepack", "conda", "mamba",
                    "micromamba", "apt", "apt-get", "aptitude", "dpkg", "snap", "brew", "port", "yum", "dnf", "zypper",
                    "pacman", "apk", "nix-env", "sudo")
INSTALL_COMMANDS = ("pip install", "pip3 install", "pip download", "pip3 download", "uv pip install", "uv add", "uv sync",
                    "uv tool install", "uv tool run", "poetry add", "poetry install", "pdm add", "pdm install",
                    "npm install", "npm i", "npm ci", "npm add", "npm exec", "npm update", "pnpm add", "pnpm install",
                    "pnpm i", "pnpm dlx", "yarn add", "yarn install", "yarn dlx", "bun add", "bun install", "bun i",
                    "bun x", "deno install", "gem install", "cargo install", "go install", "go get", "git clone",
                    "gh repo clone", "gh release download", "playwright install", "nix profile install")
INSTALL_MODULES = ("pip install", "pip download", "ensurepip", "playwright install")
# options that take the next word as their value, skipped with it between a program and its subcommand
VALUE_OPTIONS = ("-C", "-c", "--prefix", "--python", "-p", "--with", "--with-requirements", "--directory", "--project",
                 "--cwd", "--dir", "--git-dir", "--work-tree", "--log", "--cache-dir", "--index-url", "-i",
                 "--extra-index-url", "--target", "-t", "--config", "--userconfig", "--registry", "--filter", "-F",
                 "--workspace", "-w")
SHELLS = ("sh", "bash", "zsh", "dash", "ksh")
# words that run the command after them: skipped, with their own options, to find the command that runs
WRAPPERS = ("env", "command", "exec", "builtin", "nohup", "nice", "time", "timeout", "xargs", "stdbuf", "setsid", "chrt",
            "ionice", "caffeinate")
OPERATORS = re.compile(r"\$\(|`|&&|\|\||[;|&()\n]")


def _segments(command: str) -> list[list[str]]:
    """The simple commands of a command line, each its words: split at operators and command substitutions, quotes
    kept together. ValueError for a line shlex cannot read."""
    lex = shlex.shlex(OPERATORS.sub(" ; ", command), posix=True, punctuation_chars=";")
    lex.whitespace_split = True
    out: list[list[str]] = [[]]
    for word in lex:
        if word and set(word) <= {";"}:
            out.append([])
        else:
            out[-1].append(word)
    return [s for s in out if s]


def _operands(words: list[str]) -> list[str]:
    """The words that are not options, with the values of VALUE_OPTIONS: `-q install x` and `--prefix app ci` read as
    `install x` and `ci`."""
    out, skip = [], False
    for w in words:
        if skip:
            skip = False
        elif w in VALUE_OPTIONS:
            skip = True
        elif not w.startswith("-"):
            out.append(w)
    return out


def _installs(words: list[str], depth: int) -> bool:
    i = 0
    while i < len(words) and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[i]) or
                              os.path.basename(words[i]) in WRAPPERS or (i and words[i].startswith("-"))
                              or (i and re.fullmatch(r"[0-9.]+[smhd]?", words[i]))):
        i += 1
    words = words[i:]
    if not words:
        return False
    head = re.sub(r"^(pip3?)[0-9.]+$", r"\1", os.path.basename(words[0]))
    if head in INSTALL_PROGRAMS:
        return True
    plain = [head, *_operands(words[1:])]
    if any(plain[:len(c.split())] == c.split() for c in INSTALL_COMMANDS):
        return True
    if plain[:2] == ["uv", "run"] and any(w.split("=")[0] in ("--with", "--with-requirements", "--script")
                                          for w in words[1:]):
        return True
    if re.fullmatch(r"python[0-9.]*", head) and "-m" in words:
        rest = _operands(words[words.index("-m") + 1:])
        if any(rest[:len(m.split())] == m.split() for m in INSTALL_MODULES):
            return True
    if head in (*SHELLS, "eval") and depth < 3:
        inner = words[words.index("-c") + 1:words.index("-c") + 2] if "-c" in words else words[1:] if head == "eval" else []
        return any(installs(text, depth + 1) for text in inner)
    return False


# the words that can make a command line an install (installs): each INSTALL_PROGRAMS name, the first word of each
# INSTALL_COMMANDS and INSTALL_MODULES entry, and pip with a version, standing alone between the places shlex and
# OPERATORS split a line (shlex ends a word at a `#`, which starts a comment), or after a `/`
_INSTALL_WORD = re.compile(r"(?:^|[\s;&|()`$/])(?:%s|pip3?[0-9.]*)(?=$|[\s;&|()`$#])" % "|".join(
    re.escape(w) for w in sorted({*INSTALL_PROGRAMS, *(c.split()[0] for c in (*INSTALL_COMMANDS, *INSTALL_MODULES))},
                                 key=len, reverse=True)))
_QUOTES = str.maketrans("", "", "'\"\\")


@functools.lru_cache(maxsize=32)
def installs(command: str, depth: int = 0) -> bool:
    """Whether a command line installs software or downloads files: one of its commands is an INSTALL_* one, after
    variable assignments and WRAPPERS, at a path, or inside `sh -c` or `eval`. A line shlex cannot read counts when an
    install word appears in it. A line in which no install word appears, its quotes and backslashes taken out, is not
    read with shlex, which is slow on a long script."""
    if not _INSTALL_WORD.search(command.translate(_QUOTES)):
        return False
    try:
        return any(_installs(words, depth) for words in _segments(command))
    except ValueError:
        names = (*INSTALL_PROGRAMS, *INSTALL_COMMANDS)
        return any(re.search(rf"(^|[\s/;&|(`]){re.escape(n)}(\s|$)", command) for n in names)


SHELL_MAGICS = ("system", "sx", "pip", "conda", "mamba", "micromamba", "uv", "npm")
SHELL_CELLS = ("bash", "sh", "zsh", "script", "system")
RUNNERS = {("os", "system"), ("os", "popen"), ("subprocess", "run"), ("subprocess", "call"),
           ("subprocess", "check_call"), ("subprocess", "check_output"), ("subprocess", "Popen"),
           ("subprocess", "getoutput"), ("subprocess", "getstatusoutput")}


def _called(node: "ast.expr") -> str:
    """A literal command given to a runner: a string, or a list of words where any non-literal word reads as `python`
    (`[sys.executable, "-m", "pip", "install", x]`)."""
    import ast  # noqa: PLC0415 — only card code needs it

    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)):
        return " ".join(shlex.quote(e.value) if isinstance(e, ast.Constant) and isinstance(e.value, str) else "python"
                        for e in node.elts)
    return ""


def code_installs(code: str) -> bool:
    """Whether a notebook cell's code installs software or downloads files the ordinary ways: a shell line (`!`, a
    shell or package magic, a `%%bash` cell) or a literal command given to os.system or subprocess that `installs`
    matches."""
    import ast  # noqa: PLC0415

    lines = code.splitlines()
    first = lines[0].strip() if lines else ""
    if first.startswith("%%") and first[2:].split(" ", 1)[0] in SHELL_CELLS:
        return installs("\n".join(lines[1:]))
    shell: list[str] = []
    for line in lines:
        text = line.strip()
        if text.startswith("!"):
            shell.append(text.lstrip("!"))
        elif text.startswith("%") and not text.startswith("%%"):
            name, _, rest = text[1:].partition(" ")
            if name in SHELL_MAGICS:
                shell.append(rest if name in ("system", "sx") else f"{name} {rest}")
        elif "=" in text and ("!" in text.split("=", 1)[1][:3] or "%sx" in text):
            shell.append(text.split("=", 1)[1].strip().lstrip("!").removeprefix("%sx"))
    if any(installs(c) for c in shell):
        return True
    try:
        tree = ast.parse("\n".join("" if ln.strip().startswith(("!", "%")) else ln for ln in lines))
    except (SyntaxError, ValueError):
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and node.args and isinstance(node.func, ast.Attribute):
            owner = node.func.value.id if isinstance(node.func.value, ast.Name) else ""
            if (owner, node.func.attr) in RUNNERS and installs(_called(node.args[0])):
                return True
    return False
