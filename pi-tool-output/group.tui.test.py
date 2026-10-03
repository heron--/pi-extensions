#!/usr/bin/env python3
"""Real Pi/PTY test of the grouped layout, no model calls. Requires pyte.

Run: python3 pi-tool-output/group.tui.test.py [--output-dir /tmp/tool-output-group]
Seeds a session with a three-call turn, assistant text, then a background-task
call, and checks decoded screens for: one box per run, size lines instead of
output, the hint only under the most recent call, Alt+O expanding only that
call, a mouse click expanding only the clicked call, and Ctrl+O for all.
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

    def assistant(content):
        push({"role": "assistant", "content": content, "api": "openai-completions",
              "provider": "openai", "model": "gpt-4o", "timestamp": 0,
              "stopReason": "toolUse", "usage": USAGE})

    def result(call_id, name, text, details=None):
        push({"role": "toolResult", "toolCallId": call_id, "toolName": name,
              "content": [{"type": "text", "text": text}], "isError": False, "timestamp": 0,
              **({"details": details} if details else {})})

    push({"role": "user", "content": "Grouped tool-call fixture", "timestamp": 0})
    calls = [("c1", "read", {"path": "lib/box.ts"}, "\n".join(f"READ_OUT_{i}" for i in range(12))),
             ("c2", "grep", {"pattern": "TODO", "path": "src"}, "GREP_OUT a.ts:1\nGREP_OUT b.ts:2"),
             ("c3", "bash", {"command": "npm test"}, "BASH_OUT ok")]
    assistant([{"type": "toolCall", "id": cid, "name": name, "arguments": args} for cid, name, args, _ in calls])
    for cid, name, _, text in calls:
        result(cid, name, text)
    assistant([{"type": "text", "text": "EDIT_TEXT"},
               {"type": "toolCall", "id": "e1", "name": "edit", "arguments": {
                   "path": "lib/box.ts", "edits": [{"oldText": "const A = 1;", "newText": "const A = 2;\nconst B = 3;"}]}}])
    result("e1", "edit", "Successfully replaced 1 block(s) in lib/box.ts.",
           {"diff": " 1 // top\n-2 const A = 1;\n+2 EDIT_ADDED_A\n+3 EDIT_ADDED_B", "firstChangedLine": 2})
    assistant([{"type": "text", "text": "BETWEEN_TEXT"},
               {"type": "toolCall", "id": "c4", "name": "bg_status", "arguments": {"taskId": "job-1"}}])
    result("c4", "bg_status", "BG_OUT running")
    return "\n".join(json.dumps(entry) for entry in entries) + "\n"


def run(width, output_dir):
    with tempfile.TemporaryDirectory(prefix="pi-group-tui-") as scratch:
        cwd = Path(scratch)
        agent = cwd / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"theme": "dark", "quietStartup": True}))
        fixtures = cwd / "fixtures.ts"
        fixtures.write_text('''
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
export default function(pi) {
  pi.registerTool({ name: "bg_status", label: "bg_status", description: "Rendering fixture",
    parameters: Type.Object({}), execute: async () => ({ content: [] }),
    renderCall: () => new Text("UNDECORATED_FIXTURE", 0, 0),
    renderResult: () => new Text("UNDECORATED_RESULT", 0, 0),
  });
}
''')
        session = cwd / "session.jsonl"
        session.write_text(seed(cwd))
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ.update({"PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color",
                               "COLORTERM": "truecolor"})
            os.execvp("pi", ["pi", "--no-extensions", "-e", str(ROOT / "pi-tool-output/index.ts"),
                            "-e", str(fixtures), "--offline", "--no-skills", "--no-prompt-templates",
                            "--no-themes", "--provider", "openai", "--model", "gpt-4o",
                            "--session", str(session)])
        rows = 50
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

        def save(stage, text):
            Path(output_dir / f"group-{width}-{stage}.txt").write_text(text)

        def click(needle):
            for row, line in enumerate(screen.display):
                col = line.find(needle)
                if col >= 0:
                    x, y = col + 1, row + 1
                    os.write(fd, f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m".encode())
                    return
            raise AssertionError(f"{needle} not on screen:\n{capture()}")

        outputs = ["READ_OUT_0", "GREP_OUT", "BASH_OUT", "BG_OUT"]
        try:
            collapsed = receive_until(lambda t: "BETWEEN_TEXT" in t and "ctrl+o" in t)
            save("collapsed", collapsed)
            assert "Ran 3 tools" in collapsed, collapsed
            assert "Ran 1 tool" in collapsed, collapsed
            assert collapsed.count("╭") >= 2, collapsed
            assert "12 lines" in collapsed, collapsed
            # An edit shows +added -removed in diff colors, not sizes or its arguments.
            assert "+2 -1" in collapsed, collapsed
            assert "edits:" not in collapsed and "EDIT_ADDED" not in collapsed, collapsed
            def fg_at(needle):
                for row, line in enumerate(screen.display):
                    col = line.find(needle)
                    if col >= 0:
                        return screen.buffer[row][col].fg
                raise AssertionError(needle)
            assert fg_at("+2") != fg_at("-1"), "added and removed have their own colors"
            assert "UNDECORATED" not in collapsed, collapsed
            assert not any(out in collapsed for out in outputs), collapsed
            assert collapsed.count("ctrl+o") == 1, collapsed
            hint = collapsed.index("ctrl+o")
            assert collapsed.index("BETWEEN_TEXT") < hint, "hint belongs to the most recent call"

            os.write(fd, b"\x1bo")  # Alt+O: only the most recent call
            last = receive_until(lambda t: "BG_OUT" in t)
            save("alt-o", last)
            assert not any(out in last for out in outputs[:3]), last

            click("Search Files")  # only the clicked call
            clicked = receive_until(lambda t: "GREP_OUT" in t)
            save("click", clicked)
            assert "BG_OUT" in clicked and "READ_OUT_0" not in clicked and "BASH_OUT" not in clicked, clicked

            os.write(fd, b"\x0f")  # Ctrl+O: everything
            receive_until(lambda t: "BASH_OUT" in t)
            os.write(fd, b"\x0f")  # and back: individual expansions reset too
            reset = receive_until(lambda t: "BETWEEN_TEXT" in t and not any(out in t for out in outputs))
            save("ctrl-o-reset", reset)
            assert b"exceeds terminal width" not in raw
            assert b"Failed to load extension" not in raw
            print(f"PASS grouped layout at {width} columns", flush=True)
        finally:
            Path(output_dir / f"group-{width}.ansi").write_bytes(raw)
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    options = parser.parse_args()
    output = options.output_dir or Path(tempfile.mkdtemp(prefix="pi-group-tui-screens-"))
    output.mkdir(parents=True, exist_ok=True)
    print(f"Screens: {output}", flush=True)
    for columns in [100, 60, 40]:
        run(columns, output)
