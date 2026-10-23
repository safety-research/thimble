#!/bin/sh
# scan.sh: looks for private details in commits before they reach the public repository. It checks the lines each
# commit adds, the names of the files it adds, and its message, for:
#
#   - absolute home folder paths (/home/<name>/, /Users/<name>/) and paths under /mnt, except the tests' made-up
#     homes and mounts (/home/t/, /home/dev/, /Users/sam/, /mnt/data/, ... in GENERIC_ALLOW) and the placeholders
#     /home/you/, /home/user/ and /home/<name>/;
#   - private key headers and token shapes (Anthropic, OpenAI, GitHub, AWS, Google, Slack, Hugging Face, npm, Stripe,
#     JSON web tokens);
#   - what gitleaks finds, when gitleaks is installed;
#   - the patterns in your private deny-list and the values in your private env files (below), which never go in
#     the repository.
#
#   scripts/scan.sh                      the commits on HEAD that no remote branch has yet
#   scripts/scan.sh origin/main..HEAD    the commits of a range (any git rev-list arguments)
#   scripts/scan.sh --all                every commit of the remote branches and the tags
#   scripts/scan.sh --tree REV           every line of every file at REV
#   scripts/scan.sh --generic ...        only the generic checks, as CI runs them: the private lists are not read
#
# The pre-push hook (scripts/hooks/pre-push) runs `scan.sh --pre-push` on every commit a push sends, and stops the
# push on a finding. A finding names the commit, the file and line, and the pattern, never the text that matched.
#
# The private lists, both optional, are in ~/.config/thimble/ ($XDG_CONFIG_HOME/thimble/ when that is set):
#
#   deny-patterns    one Python regular expression per line. A comment line names the patterns below it in a
#                    finding. A pattern can start with [content], [message] or [name] (or several, as
#                    [content, name]) to check only added lines, commit messages or file names. A line that starts
#                    with ! is an allow-pattern: the text it matches is never a finding, here or in the generic checks.
#   deny-env-files   one path or glob per line (~ works), of KEY=VALUE files. Every value of 8 or more characters in
#                    them is searched for as it is; a finding names the file and the key, never the value.
#
# Exit status: 0 nothing found, 1 findings, 2 the scan did not finish. Needs git 2.36 or later and Python 3.6 or later.
''':'
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 6))' 2>/dev/null; then
    exec "$py" "$0" "$@"
  fi
done
echo "scan.sh: needs Python 3.6 or later, and found none, so nothing was scanned (a push stops until it can scan)." >&2
exit 2
'''
"""The scanner. The comments at the top of this file say what it checks and how to run it.

It reads what git shows of each commit: the lines it adds, the names of the files it adds, and its message. A merge
shows only what its author wrote while merging (git's remerge diff); the commits it merges are scanned on their own.
A finding names the commit, the place and the pattern, never the text that matched.
"""
import bisect
import glob
import json
import os
import re
import subprocess
import sys

USAGE = """usage: scripts/scan.sh [--generic] [REVISION...]   the commits git rev-list REVISION... lists
                                              (default: HEAD --not --remotes)
       scripts/scan.sh [--generic] --all          every commit of the remote branches and the tags
       scripts/scan.sh [--generic] --tree REV     every line of every file at REV
       scripts/scan.sh --pre-push REMOTE          what a push sends (the pre-push hook runs this)"""

SCOPES = ('content', 'message', 'name')

# The generic patterns, the same in every checkout and in CI: (name, pattern, characters that must not come right
# before a match). A path is absolute when no character of a longer path or a URL comes before it.
PATH_BEFORE = r'[\w.~$-]'
WORD_BEFORE = r'[\w-]'
NAME = r'[A-Za-z0-9._-]+'
GENERIC = [
    ('home folder path', r'/(?:home|Users)/' + NAME, PATH_BEFORE),
    ('mount path', r'/mnt[/]', PATH_BEFORE),
    ('private key', r'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----', None),
    ('Anthropic API key', r'sk-ant-[a-z]{2,8}\d{2}-[A-Za-z0-9_-]{20,}', WORD_BEFORE),
    ('OpenAI API key', r'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}',
     WORD_BEFORE),
    ('GitHub token', r'gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}', WORD_BEFORE),
    ('AWS access key', r'(?:AKIA|ASIA)[A-Z0-9]{16}\b', WORD_BEFORE),
    ('Google API key', r'AIza[0-9A-Za-z_-]{35}', WORD_BEFORE),
    ('Google OAuth token', r'ya29\.[0-9A-Za-z_-]{20,}', WORD_BEFORE),
    ('Slack token', r'xox[abposr]-[A-Za-z0-9-]{10,}|hooks\.slack\.com/services/T[A-Za-z0-9_/]{8,}', WORD_BEFORE),
    ('Hugging Face token', r'hf_[A-Za-z0-9]{30,}', WORD_BEFORE),
    ('npm token', r'npm_[A-Za-z0-9]{36}\b', WORD_BEFORE),
    ('Stripe key', r'[rs]k_live_[A-Za-z0-9]{20,}', WORD_BEFORE),
    ('JSON web token', r'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}', WORD_BEFORE),
]
# Text these match is never a finding: the made-up home folders and mounts the tests and their fixtures use (a home of
# one letter, such as /home/t/; a role, such as /home/dev/; the two made-up people ana and sam; /mnt/data/, /mnt/disk/,
# /mnt/d/), a path cut short with … (/mnt/…/x), and the placeholders the docs use, such as /home/you/. A placeholder in
# angle brackets or with a $ (/home/<name>/, /home/$USER/) never matches.
GENERIC_ALLOW = [
    r'/(?:home|Users)/(?:[a-z]|you|user|username|name|me|someone|dev|ci|analyst|kept|ana|sam)(?![\w.-])',
    r'/mnt[/](?:data|disk|d|…)(?![\w.-])',
]

# The author and owner of a plugin are public on purpose: their values in a plugin's manifest are never findings.
MANIFEST = re.compile(r'(^|/)\.claude-plugin/(plugin|marketplace)\.json$')

ZERO = re.compile(r'^0+$')
HUNK = re.compile(rb'^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
INDEX = re.compile(rb'^index [0-9a-f]+\.\.([0-9a-f]+)')
SCOPE_TAG = re.compile(r'^\[\s*((?:content|message|name)(?:\s*,\s*(?:content|message|name))*)\s*\]\s*')
HOME = os.path.expanduser('~')


class Stop(Exception):
    """The scan cannot run; exit 2."""


def git(*args, stdin=None, check=True):
    p = subprocess.run(['git', *args], input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        raise Stop('git %s failed: %s' % (args[0], p.stderr.decode('utf-8', 'replace').strip()))
    return p


def shown(path):
    return '~' + path[len(HOME):] if HOME and path.startswith(HOME + os.sep) else path


def config_dir():
    return os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config'), 'thimble')


class Rules:
    def __init__(self, generic_only):
        self.deny = [(label, re.compile(rx), SCOPES, before and re.compile(before)) for label, rx, before in GENERIC]
        self.allow = [(re.compile(rx), SCOPES) for rx in GENERIC_ALLOW]
        self.values = []  # (value, file, key): searched for as they are, never printed
        self.private = 0
        self.missing = []
        if not generic_only:
            self.load_patterns(os.path.join(config_dir(), 'deny-patterns'))
            self.load_env_files(os.path.join(config_dir(), 'deny-env-files'))

    def load_patterns(self, path):
        if not os.path.exists(path):
            return
        name = ''
        try:
            lines = open(path, encoding='utf-8').read().splitlines()
        except OSError as e:
            raise Stop('cannot read %s: %s' % (shown(path), e.strerror))
        for n, line in enumerate(lines, 1):
            s = line.strip()
            if not s:
                continue
            if s.startswith('#'):
                name = s.lstrip('#').strip() or name
                continue
            allow = s.startswith('!')
            if allow:
                s = s[1:].lstrip()
            scopes = SCOPES
            tag = SCOPE_TAG.match(s)
            if tag:
                scopes = tuple(x.strip() for x in tag.group(1).split(','))
                s = s[tag.end():]
            try:
                rx = re.compile(s, re.MULTILINE)
            except re.error as e:  # its message gives a position, not the pattern
                raise Stop('%s line %d is not a valid regular expression: %s' % (shown(path), n, e.msg))
            if allow:
                self.allow.append((rx, scopes))
            else:
                label = 'private pattern, %s line %d' % (os.path.basename(path), n) + (' (%s)' % name if name else '')
                self.deny.append((label, rx, scopes, None))
                self.private += 1

    def load_env_files(self, path):
        if not os.path.exists(path):
            return
        try:
            lines = open(path, encoding='utf-8').read().splitlines()
        except OSError as e:
            raise Stop('cannot read %s: %s' % (shown(path), e.strerror))
        for n, line in enumerate(lines, 1):
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            files = sorted(glob.glob(os.path.expanduser(os.path.expandvars(s))))
            if not files:
                self.missing.append('%s line %d (%s) matches no file' % (os.path.basename(path), n, s))
            for f in files:
                try:
                    text = open(f, encoding='utf-8', errors='replace').read()
                except OSError as e:
                    raise Stop('cannot read %s, which %s lists: %s' % (shown(f), shown(path), e.strerror))
                for entry in text.splitlines():
                    entry = entry.strip()
                    if not entry or entry.startswith('#') or '=' not in entry:
                        continue
                    key, value = entry.split('=', 1)
                    key = key.strip()
                    if key.startswith('export '):
                        key = key[len('export '):].strip()
                    value = value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                        value = value[1:-1]
                    if len(value) >= 8:
                        self.values.append((value, shown(f), key))

    def describe(self):
        parts = ['the generic patterns']
        if self.private:
            parts.append('%d private patterns' % self.private)
        if self.values:
            parts.append('%d private values' % len(self.values))
        return ', '.join(parts)

    def check(self, text, scope, keep=()):
        """[(offset, label)] for each finding in text. The strings in keep are allowed here, as allow-patterns are."""
        blank = list(text)
        for rx, scopes in self.allow:
            if scope in scopes:
                for m in rx.finditer(text):
                    blank[m.start():m.end()] = '\0' * (m.end() - m.start())
        for s in keep:
            for form in {s, json.dumps(s)[1:-1]}:
                i = text.find(form)
                while form and i >= 0:
                    blank[i:i + len(form)] = '\0' * len(form)
                    i = text.find(form, i + 1)
        blanked = ''.join(blank)
        found = []
        for label, rx, scopes, before in self.deny:
            if scope in scopes:
                found += [(m.start(), label) for m in rx.finditer(blanked)
                          if not (before and m.start() and before.match(blanked, m.start() - 1))]
        for value, f, key in self.values:  # a secret is never allowed
            i = text.find(value)
            while i >= 0:
                found.append((i, 'value of %s from %s' % (key, f)))
                i = text.find(value, i + 1)
        return found

    def mask(self, text):
        """text with every part a pattern or a value matches replaced by *, to print it."""
        out = list(text)
        for _, rx, _, _ in self.deny:
            for m in rx.finditer(text):
                out[m.start():m.end()] = '*' * (m.end() - m.start())
        for value, _, _ in self.values:
            i = text.find(value)
            while i >= 0:
                out[i:i + len(value)] = '*' * len(value)
                i = text.find(value, i + 1)
        return ''.join(out)


def unquote(raw):
    """A path as git prints it, quoted C-style when it has unusual characters."""
    if not raw.startswith(b'"'):
        return raw.decode('utf-8', 'replace')
    out, i, body = bytearray(), 0, raw[1:-1]
    simple = {ord('n'): 10, ord('t'): 9, ord('a'): 7, ord('b'): 8, ord('f'): 12, ord('r'): 13, ord('v'): 11}
    while i < len(body):
        c = body[i]
        if c == 92 and i + 1 < len(body):  # backslash
            d = body[i + 1]
            if 48 <= d <= 55:
                out.append(int(body[i + 1:i + 4], 8))
                i += 4
                continue
            out.append(simple.get(d, d))
            i += 2
            continue
        out.append(c)
        i += 1
    return out.decode('utf-8', 'replace')


def strip_side(path):
    return path[2:] if path[:2] in ('a/', 'b/') else path


def same_path(rest):
    """The path of a `diff --git a/P b/P` line, or None when the two sides differ (a rename shows its own lines)."""
    if rest.startswith(b'"'):
        return None
    n = (len(rest) - 5) // 2
    if rest[:2] == b'a/' and rest[2 + n:5 + n] == b' b/' and rest[2:2 + n] == rest[5 + n:]:
        return rest[2:2 + n].decode('utf-8', 'replace')
    return None


class FileDiff:
    def __init__(self, path):
        self.path, self.new_name, self.blob, self.binary, self.added = path, False, None, False, []


def parse(stream, on_commit, on_file):
    """Reads git log or diff-tree output: a line \\0<sha> starts a commit, its message ends at a line \\0."""
    commit, message, in_message, cur = None, [], False, None
    old_left = new_left = lineno = 0
    for line in stream:
        line = line.rstrip(b'\n')
        if old_left > 0 or new_left > 0:
            first = line[:1]
            if first == b'+':
                cur.added.append((lineno, line[1:].decode('utf-8', 'replace')))
                lineno += 1
                new_left -= 1
            elif first == b'-':
                old_left -= 1
            elif first == b' ':
                lineno += 1
                old_left -= 1
                new_left -= 1
            elif first != b'\\':  # not a hunk line: the hunk ended early, so read the line as a header
                old_left = new_left = 0
            if old_left > 0 or new_left > 0 or first in (b'+', b'-', b' ', b'\\'):
                continue
        if in_message:
            end = line.find(b'\0')
            if end < 0:
                message.append(line.decode('utf-8', 'replace'))
                continue
            if end > 0:  # a message whose last line has no newline
                message.append(line[:end].decode('utf-8', 'replace'))
            in_message = False
            on_commit(commit, '\n'.join(message))
            continue
        if line.startswith(b'\0'):
            if cur:
                on_file(commit, cur)
            cur, commit, message, in_message = None, line[1:].decode(), [], True
        elif line.startswith(b'diff --git '):
            if cur:
                on_file(commit, cur)
            cur = FileDiff(same_path(line[len(b'diff --git '):]))
        elif cur is None:
            continue
        elif line.startswith(b'new file mode'):
            cur.new_name = True
        elif line.startswith(b'rename to ') or line.startswith(b'copy to '):
            cur.path, cur.new_name = unquote(line.split(b' to ', 1)[1]), True
        elif line.startswith(b'+++ '):
            if line[4:] != b'/dev/null':
                cur.path = strip_side(unquote(line[4:]))
        elif line.startswith(b'index '):
            m = INDEX.match(line)
            cur.blob = m.group(1).decode() if m else None
        elif line.startswith(b'Binary files '):
            cur.binary = True
        elif line.startswith(b'@@ '):
            m = HUNK.match(line)
            if m:
                old_left = int(m.group(1)) if m.group(1) is not None else 1
                lineno = int(m.group(2))
                new_left = int(m.group(3)) if m.group(3) is not None else 1
    if cur:
        on_file(commit, cur)


class Scan:
    def __init__(self, rules):
        self.rules = rules
        self.findings = []  # (commit, place, label, sort key)
        self.order = {}

    def add(self, commit, place, label, key=()):
        self.order.setdefault(commit, len(self.order))
        self.findings.append((commit, place, label, key))

    def block(self, commit, lines, scope, place, key, keep=()):
        """Checks lines [(lineno, text)] as one text, so that a pattern runs once over a whole file's added lines."""
        if not lines:
            return
        starts, offset = [], 0
        for _, text in lines:
            starts.append(offset)
            offset += len(text) + 1
        for at, label in self.rules.check('\n'.join(t for _, t in lines), scope, keep):
            n = lines[bisect.bisect_right(starts, at) - 1][0]
            self.add(commit, place(n), label, key + (n,))

    def on_commit(self, commit, message):
        lines = list(enumerate(message.split('\n'), 1))
        self.block(commit, lines, 'message', lambda n: 'commit message, line %d' % n, (0, ''))

    def on_file(self, commit, f):
        if f.path is None:
            return
        shown_path = self.rules.mask(f.path)
        if f.new_name:
            self.block(commit, [(0, f.path)], 'name', lambda n: 'file name %s' % shown_path, (1, f.path))
        added = f.added
        if f.binary and f.blob and not ZERO.match(f.blob):
            data = git('cat-file', 'blob', f.blob).stdout
            if b'\0' not in data[:8000]:  # text that .gitattributes shows as binary: check all of it
                added = list(enumerate(data.decode('utf-8', 'replace').split('\n'), 1))
        keep = ()
        if added and MANIFEST.search(f.path) and f.blob and not ZERO.match(f.blob):
            keep = manifest_people(git('cat-file', 'blob', f.blob, check=False).stdout)
        self.block(commit, added, 'content', lambda n: '%s:%d' % (shown_path, n), (1, f.path), keep)

    def commits(self, shas):
        cmd = ['git', '-c', 'core.quotePath=false', 'log', '--no-walk=unsorted', '--stdin', '--format=%x00%H%n%B%x00',
               '--remerge-diff', '-U0', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative',
               '--src-prefix=a/', '--dst-prefix=b/']
        self.run(cmd, ('\n'.join(shas) + '\n').encode())

    def tree(self, rev):
        empty = git('hash-object', '-t', 'tree', '--stdin', stdin=b'').stdout.decode().strip()
        sha = git('rev-parse', '--verify', rev + '^{commit}').stdout.decode().strip()
        cmd = ['git', '-c', 'core.quotePath=false', 'diff-tree', '-r', '-p', '-U0', '--full-index', '--no-color',
               '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', empty, sha]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        parse(p.stdout, self.on_commit, lambda _, f: self.on_file(sha, f))
        if p.wait() != 0:
            raise Stop('git diff-tree failed: %s' % p.stderr.read().decode('utf-8', 'replace').strip())

    def run(self, cmd, stdin):
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p.stdin.write(stdin)
        p.stdin.close()
        parse(p.stdout, self.on_commit, self.on_file)
        if p.wait() != 0:
            raise Stop('git log failed: %s' % p.stderr.read().decode('utf-8', 'replace').strip())

    def gitleaks(self, shas):
        """gitleaks over the same commits, when it is installed. It reports the rule, never the secret (--redact)."""
        exe = which('gitleaks')
        if not exe or not shas:
            return False
        cmd = [exe, 'git', '--log-opts=--no-walk=unsorted ' + ' '.join(shas), '--redact', '--no-banner',
               '--no-color', '--log-level', 'error', '--exit-code', '0', '--report-format', 'json',
               '--report-path', '-', '.']
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        err = p.stderr.decode('utf-8', 'replace').strip()
        if p.returncode != 0 or err:  # gitleaks exits 0 when git fails, so its error output counts too
            raise Stop('gitleaks failed (exit %d): %s' % (p.returncode, err[-600:]))
        try:
            found = json.loads(p.stdout.decode('utf-8'))
        except ValueError:
            raise Stop('gitleaks gave a report that is not JSON')
        for f in found:
            line = int(f.get('StartLine') or 0)
            self.add(f['Commit'], '%s:%d' % (self.rules.mask(f['File']), line), 'gitleaks rule %s' % f['RuleID'],
                     (1, f['File'], line))
        return True

    def rows(self):
        seen, rows = set(), []
        for commit, place, label, key in sorted(self.findings, key=lambda r: (self.order[r[0]],) + r[3] + (r[2],)):
            if (commit, place, label) not in seen:
                seen.add((commit, place, label))
                rows.append((commit, place, label))
        return rows

    @staticmethod
    def report(rows, out):
        width = max(len(r[1]) for r in rows)
        for commit, place, label in rows:
            out.write('  %s  %s  %s\n' % (commit[:12], place.ljust(width), label))
        counts = {}
        for _, _, label in rows:
            counts[label] = counts.get(label, 0) + 1
        if len(rows) > 5:
            out.write('\nBy pattern:\n')
            for label, n in sorted(counts.items(), key=lambda kv: -kv[1]):
                out.write('  %5d  %s\n' % (n, label))


def manifest_people(data):
    """The strings under author and owner in a plugin manifest."""
    try:
        doc = json.loads(data.decode('utf-8'))
    except ValueError:
        return ()
    found = []

    def strings(x):
        if isinstance(x, str):
            found.append(x)
        elif isinstance(x, dict):
            for v in x.values():
                strings(v)
        elif isinstance(x, list):
            for v in x:
                strings(v)

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                (strings if k in ('author', 'owner') else walk)(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(doc)
    return tuple(s for s in found if s)


def which(name):
    for d in os.environ.get('PATH', '').split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def rev_list(args):
    return [s for s in git('rev-list', *args).stdout.decode().split('\n') if s]


def pushed_commits(stdin):
    """The commits a push sends, from the lines git gives the pre-push hook: <local ref> <sha> <remote ref> <sha>.
    A commit a remote branch already has is public already, and is not scanned again."""
    shas, seen = [], set()
    for line in stdin.splitlines():
        parts = line.split()
        if len(parts) != 4 or ZERO.match(parts[1]):  # a malformed line, or a deletion
            continue
        local, remote = parts[1], parts[3]
        args = [local, '--not', '--remotes']
        if not ZERO.match(remote) and git('cat-file', '-e', remote + '^{commit}', check=False).returncode == 0:
            args.append(remote)
        for s in rev_list(args):
            if s not in seen:
                seen.add(s)
                shas.append(s)
    return shas


PUSH_HELP = """Nothing was pushed. To go on:
  - Take the text out of the commit that holds it. A new commit on top does not help: the old one still holds it.
    Amend the last commit (git commit --amend), or rewrite an older one (git rebase -i <commit>^), then push again.
  - If a finding is wrong, change the line so it no longer matches (tests use /home/t/ and made-up names), or add an
    allow-pattern, a line that starts with !, to %s.
  - Never push with --no-verify: it skips this check. An agent never uses it; it asks its user instead.
"""


def main(argv):
    generic = '--generic' in argv
    argv = [a for a in argv if a != '--generic']
    if argv[:1] in (['-h'], ['--help']):
        print(USAGE)
        return 0
    top = git('rev-parse', '--show-toplevel').stdout.decode().strip()
    os.chdir(top)
    rules = Rules(generic)
    scan = Scan(rules)
    who = 'scan'
    if argv[:1] == ['--pre-push']:
        who = 'pre-push'
        shas = pushed_commits(sys.stdin.read())
        what = '%d commits this push sends' % len(shas)
    elif argv[:1] == ['--tree']:
        if len(argv) != 2:
            raise Stop(USAGE)
        shas = None
        what = 'the files at %s' % argv[1]
    else:
        args = ['--remotes', '--tags'] if argv == ['--all'] else (argv or ['HEAD', '--not', '--remotes'])
        if '--all' in args and argv != ['--all']:
            raise Stop(USAGE)
        shas = rev_list(args)
        what = '%d commits' % len(shas)
    for note in rules.missing:
        sys.stderr.write('%s: note: %s\n' % (who, note))
    if shas is None:
        scan.tree(argv[1])
        leaks = False
    else:
        if shas:
            scan.commits(shas)
        leaks = scan.gitleaks(shas)
    checks = rules.describe() + (', gitleaks' if leaks else '')
    if not scan.findings:
        sys.stderr.write('%s: nothing private in %s (checked %s).\n' % (who, what, checks))
        return 0
    rows = scan.rows()
    hit = len({r[0] for r in rows})
    where = what if shas is None else '%d of %s' % (hit, what)
    sys.stderr.write('%s: %d findings in %s, text that must not reach the public repository (checked %s):\n'
                     % (who, len(rows), where, checks))
    sys.stderr.flush()
    scan.report(rows, sys.stdout)
    sys.stdout.flush()
    if who == 'pre-push':
        sys.stderr.write(PUSH_HELP % shown(os.path.join(config_dir(), 'deny-patterns')))
    return 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Stop as e:
        sys.stderr.write('scan: %s\nscan: the scan did not finish, so it fails (a push stops until it passes).\n' % e)
        sys.exit(2)
    except BrokenPipeError:
        sys.exit(1)
