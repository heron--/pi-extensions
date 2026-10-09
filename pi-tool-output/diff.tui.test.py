#!/usr/bin/env python3
"""Real Pi/PTY test of the edit and write diff view, no model calls. Requires pyte.

Run: python3 pi-tool-output/diff.tui.test.py [--output-dir /tmp/tool-output-diff]
Seeds a session with an edit, a write that created a file, and a write that
overwrote one, expands them with Ctrl+O, and checks decoded screens at 80,
130 and 170 columns: one column below the split width and side by side above
it, removed lines facing their replacements, tinted rows with the changed words
tinted more strongly, and no row wider than the terminal.
"""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import tempfile
import termios
import time
import uuid

import pyte

ROOT = Path(__file__).resolve().parent.parent
USAGE = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
         "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
EDIT_DIFF = "\n".join([
    " 1 export function greet(name: string) {",
    "-2   return 'hello ' + name;",
    "+2   return 'hello there, ' + name;",
    " 3 }",
    "+4 export const PUNCTUATION_ADDED = '!';",
])
OVERWRITE_DIFF = " 1 title: notes\n-2 status: DRAFT_STATUS\n+2 status: FINAL_STATUS"


def seed(cwd):
    entries = [{"type": "session", "version": 3, "id": str(uuid.uuid4()),
                "timestamp": "2026-01-01T00:00:00Z", "cwd": str(cwd)}]
    parent = None

    def push(message):
        nonlocal parent
        entry_id = uuid.uuid4().hex[:8]
        entries.append({"type": "message", "id": entry_id, "parentId": parent,
                        "timestamp": "2026-01-01T00:00:00Z", "message": message})
        parent = entry_id

    def result(call_id, name, text, details):
        push({"role": "toolResult", "toolCallId": call_id, "toolName": name,
              "content": [{"type": "text", "text": text}], "isError": False, "timestamp": 0, "details": details})

    push({"role": "user", "content": "Diff view fixture", "timestamp": 0})
    calls = [
        ("e1", "edit", {"path": "src/greet.ts", "edits": [
            {"oldText": "  return 'hello ' + name;", "newText": "  return 'hello there, ' + name;"}]}),
        ("w1", "write", {"path": "docs/new.md", "content": "# NEW_FILE_TITLE\n\nNEW_FILE_BODY\n"}),
        ("w2", "write", {"path": "notes.yaml", "content": "title: notes\nstatus: FINAL_STATUS\n"}),
    ]
    push({"role": "assistant", "content": [{"type": "toolCall", "id": cid, "name": name, "arguments": args}
                                           for cid, name, args in calls],
          "api": "openai-completions", "provider": "openai", "model": "gpt-4o", "timestamp": 0,
          "stopReason": "toolUse", "usage": USAGE})
    result("e1", "edit", "Successfully replaced 1 block(s) in src/greet.ts.", {"diff": EDIT_DIFF, "firstChangedLine": 2})
    result("w1", "write", "Successfully wrote to docs/new.md", {"created": True})
    result("w2", "write", "Successfully wrote to notes.yaml", {"created": False, "diff": OVERWRITE_DIFF})
    return "\n".join(json.dumps(entry) for entry in entries) + "\n"


def run(width, output_dir):
    with tempfile.TemporaryDirectory(prefix="pi-diff-tui-") as scratch:
        cwd = Path(scratch)
        agent = cwd / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"theme": "dark", "quietStartup": True}))
        session = cwd / "session.jsonl"
        session.write_text(seed(cwd))
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ.update({"PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color",
                               "COLORTERM": "truecolor"})
            os.execvp("pi", ["pi", "--no-extensions", "-e", str(ROOT / "pi-tool-output/index.ts"),
                            "--offline", "--no-skills", "--no-prompt-templates", "--no-themes",
                            "--provider", "openai", "--model", "gpt-4o", "--session", str(session)])
        rows = 60
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, width, 0, 0))
        screen = pyte.Screen(width, rows)
        stream = pyte.Stream(screen)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        raw = bytearray()

        def capture():
            return "\n".join(screen.display)

        def receive_until(predicate, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.1)[0]:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        raise AssertionError("Pi exited before expected screen")
                    raw.extend(chunk)
                    stream.feed(decoder.decode(chunk))
                if predicate(capture()) and not select.select([fd], [], [], 0.15)[0]:
                    return capture()
            raise AssertionError("Expected screen did not appear:\n" + capture())

        def row_of(needle):
            for row, line in enumerate(screen.display):
                if needle in line:
                    return row
            raise AssertionError(f"{needle} not on screen:\n{capture()}")

        def backgrounds(row, start, end):
            return {screen.buffer[row][col].bg for col in range(start, end)}

        try:
            collapsed = receive_until(lambda t: "Ran 3 tools" in t and "ctrl+o" in t)
            Path(output_dir / f"diff-{width}-collapsed.txt").write_text(collapsed)
            assert "+2 -1" in collapsed, "the edit's change counts"
            assert "+3 -0" in collapsed, "a created file counts its lines"
            assert "+1 -1" in collapsed, "an overwrite counts its recorded diff"
            assert "FINAL_STATUS" not in collapsed

            os.write(fd, b"\x0f")  # Ctrl+O: expand every call
            expanded = receive_until(lambda t: "FINAL_STATUS" in t and "NEW_FILE_BODY" in t)
            Path(output_dir / f"diff-{width}-expanded.txt").write_text(expanded)
            headings = sum(1 for line in screen.display if "old" in line and "new" in line and "│" in line)
            split = headings > 0
            # The box takes 6 columns, so the diff reaches the 120-column split width at a 126-column terminal.
            assert split == (width >= 126), f"split view at {width}: {split}\n{expanded}"
            assert headings in (0, 2), "the edit and the overwrite go side by side; the new file has nothing to compare"
            removed, added = row_of("'hello ' + name"), row_of("'hello there, ' + name")
            if split:
                assert removed == added, "a removed line faces its replacement"
            else:
                assert added == removed + 1, "the replacement follows the removed line"
            # Backgrounds behind the added line's unchanged `return`, its new words, and an unchanged line.
            line = screen.display[added]
            word = line.index("there,")
            row_bg = screen.buffer[added][line.rfind("return", 0, word)].bg
            context = row_of("export function greet")
            ground = screen.buffer[context][screen.display[context].rfind("export")].bg
            assert row_bg != ground, f"a changed row is tinted ({row_bg} on {ground})"
            assert screen.buffer[added][word].bg not in (row_bg, ground), "the changed words are tinted more strongly"
            assert "new file" in expanded and "NEW_FILE_TITLE" in expanded, "a created file shows its contents as added"
            assert "DRAFT_STATUS" in expanded, "an overwrite shows what it replaced"
            assert "Successfully" not in expanded, "the diff replaces pi's result text"
            assert b"exceeds terminal width" not in raw
            assert b"Failed to load extension" not in raw
            print(f"PASS diff view at {width} columns ({'split' if split else 'unified'})", flush=True)
            return screen
        finally:
            Path(output_dir / f"diff-{width}.ansi").write_bytes(raw)
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    options = parser.parse_args()
    output = options.output_dir or Path(tempfile.mkdtemp(prefix="pi-diff-tui-screens-"))
    output.mkdir(parents=True, exist_ok=True)
    print(f"Screens: {output}", flush=True)
    for columns in [80, 130, 170]:
        run(columns, output)
