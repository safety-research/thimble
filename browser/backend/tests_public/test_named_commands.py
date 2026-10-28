"""The commands that the CLI's and the server's texts name are commands this version has (I48): the browser workbench's
`thimble-browser` (browser/scripts/thimble-browser) and the terminal plugin's `thimble` (plugin/engine/kernel/cli.py).
thimble 0.8's commands (`thimble up`, `thimble server restart`, `thimble doctor`, `thimble feedback`, ...) are gone."""
import ast
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
APP = REPO / "browser" / "backend" / "app"
# a command in code (`thimble-browser --link`), or one a text gives bare after "In a shell:", "run" or "then"
IN_CODE = re.compile(r"`(thimble(?:-browser)?(?: [^`]*)?)`")
BARE = re.compile(r"(?:[Ss]hell:|\b[Rr]un|\bthen)\s+(thimble(?:-browser)?(?: (?:--?[\w-]+|[a-z][\w-]*))+)")


def accepts() -> tuple[set[str], set[str], set[str]]:
    """What the current CLIs accept: the options `thimble-browser --help` lists, and the terminal plugin's thimble
    commands and options (its parser's)."""
    usage = "\n".join((REPO / "browser" / "scripts" / "thimble-browser").read_text().splitlines()[1:22])
    kernel = (REPO / "plugin" / "engine" / "kernel" / "cli.py").read_text()
    browser_opts = set(re.findall(r"(?<![\w-])(--?[a-z][\w-]*)", usage))
    commands = set(re.findall(r'sub\.add_parser\("([\w-]+)"', kernel)) | {"fixes", "help", "-h", "--help"}
    opts = set(re.findall(r'add_argument\("(--?[\w-]+)"', kernel)) | {"-h", "--help"}
    return browser_opts, commands, opts


def texts(node: ast.AST):
    """The strings of a constant's value: an f-string with {} for each value it fills in."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        yield node.value
    elif isinstance(node, ast.JoinedStr):
        yield "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in node.values)
    else:
        for child in ast.iter_child_nodes(node):
            yield from texts(child)


def test_every_command_the_cli_and_server_texts_name_is_one_the_current_clis_accept():
    """Each module-level text of the CLI and the server (backend/app: the lines the CLI prints, the server's notices,
    messages and log lines) that names a `thimble …` or `thimble-browser …` command names one the current CLIs accept:
    thimble-browser with options its --help lists, or thimble alone or with a command and options its parser has."""
    browser_opts, commands, opts = accepts()
    assert {"--link", "--continue", "--port"} <= browser_opts and {"update", "fix", "label"} <= commands

    def accepted(command: str) -> bool:
        words = command.split()
        if words[0] == "thimble-browser":
            return all(w.split("=")[0] in browser_opts for w in words[1:] if w.startswith("-"))
        return len(words) == 1 or (words[1] in commands
                                   and all(w.split("=")[0] in opts for w in words[2:] if w.startswith("-")))

    named, wrong = 0, []
    for f in sorted(APP.rglob("*.py")):
        for st in ast.parse(f.read_text()).body:
            target = st.targets[0] if isinstance(st, ast.Assign) else st.target if isinstance(st, ast.AnnAssign) else None
            if not isinstance(target, ast.Name) or target.id.startswith("_") or not target.id.isupper() or not st.value:
                continue
            for text in texts(st.value):
                for m in [*IN_CODE.finditer(text), *BARE.finditer(text)]:
                    named += 1
                    command = re.sub(r"[.,;:)]+$", "", m.group(1).strip())
                    if not accepted(command):
                        wrong.append(f"{f.relative_to(APP)} {target.id}: {command}")
    assert named > 10, "the texts name thimble-browser's commands"
    assert wrong == []
