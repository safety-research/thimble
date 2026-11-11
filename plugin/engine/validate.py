"""The marks' check after the checker fork answered, as the plugin's hooks run it (marks/checker.ts): JSON on stdin,
JSON on stdout. No model call, and no code run: kernel/evidence.py reads the files and the calls' real outputs.

    stdin   {"cwd": the working folder, "root": the folder the session started in, which the paths shown start from,
             "tmp": the session's temp folders, where Claude keeps its own code (a list: thimble's, and the one
             Claude Code's Bash sandbox gives a command; or one folder),
             "marks": [{"n", "words", "sentence"}], "answer": the checker's last message,
             "calls": [{"command", "output", "by": "checker" | "main"}],
             "cards": the session's cards' outputs (kernel/evidence.py check_card), or "cards_dir": the terminal's
             cards folder (cards/store.ts), read with terminal_cards,
             "labels_dir"?: the conversation's labels of the folder (labels.py), whose kept versions are cards too
             (terminal_label_cards),
             "at"?: when the marks' words were written, in seconds since the epoch: a label is read as it was then,
             "unread"?: the files the check could not read, by their absolute paths,
             "fresh"?: true for a check of citations whose source changed after their first check: computed evidence
             is then a call of this check's own (kernel/evidence.py check_mark)}
    stdout  {"parsed": bool, "results": [{"n", "status", "shown", "reason", "was"?, "failedBy"?, "evidence"?, "note"?,
             "sources"?}], "outside"?: those of the "unread" files no evidence may cite, outside every folder a cited
             file may lie in (kernel/evidence.py uncitable)}

With "index": a path instead, it writes the cards' places and values there for the checker to grep (card_index), the
labels as they were at "at", and answers {"cards": the number of cards}. With "cited": checked citations instead, each
{"sources"}, it answers {"cited": each as it stands now} (kernel/evidence.py examine), in the same order.
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kernel.evidence import card_index, check_all, examine, terminal_cards, terminal_label_cards, uncitable  # noqa: E402


def main() -> int:
    req = json.load(sys.stdin)
    if isinstance(req.get("cited"), list):
        json.dump({"cited": examine(req["cited"])}, sys.stdout, ensure_ascii=False)
        return 0
    cards = req.get("cards") if isinstance(req.get("cards"), list) else terminal_cards(req.get("cards_dir"))
    cards = [*cards, *terminal_label_cards(req.get("labels_dir"))]
    at = req.get("at")
    at = float(at) if isinstance(at, (int, float)) and not isinstance(at, bool) and math.isfinite(at) else None
    if req.get("index"):
        Path(str(req["index"])).write_text(card_index(cards, at), encoding="utf-8")
        json.dump({"cards": len({str(c.get("id")) for c in cards})}, sys.stdout)
        return 0
    cwd, root, tmp = str(req.get("cwd") or "."), req.get("root") or None, req.get("tmp") or None
    out = check_all(req.get("marks") or [], str(req.get("answer") or ""), req.get("calls") or [], cwd, root, tmp, cards, at=at,
                    fresh=req.get("fresh") is True)
    if isinstance(req.get("unread"), list) and req["unread"]:
        out["outside"] = uncitable([str(f) for f in req["unread"]], cwd, root, tmp)
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
