#!/usr/bin/env python3
"""Real Pi/PTY smoke test, no model calls. Requires Python's pyte package.

Run: python3 pi-tool-output/tui.test.py [--output-dir /tmp/tool-output-screens]
Uses scratch settings/sessions, loads only this checkout's renderer, and tests
actual Ctrl+O keypresses against decoded terminal screens, not raw ANSI matches.
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


def seed(cwd, name, args):
    entries = [{"type": "session", "version": 3, "id": str(uuid.uuid4()),
                "timestamp": "2026-01-01T00:00:00Z", "cwd": str(cwd)}]
    parent = None

    def push(message):
        nonlocal parent
        entry_id = uuid.uuid4().hex[:8]
        entries.append({"type": "message", "id": entry_id, "parentId": parent,
                        "timestamp": "2026-01-01T00:00:00Z", "message": message})
        parent = entry_id

    push({"role": "user", "content": "Tool-call rendering fixture", "timestamp": 0})
    push({"role": "assistant", "content": [{"type": "toolCall", "id": "fixture",
          "name": name, "arguments": args}], "api": "openai-completions",
          "provider": "openai", "model": "gpt-4o", "timestamp": 0,
          "stopReason": "toolUse", "usage": {"input": 0, "output": 0, "cacheRead": 0,
          "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0,
          "cacheRead": 0, "cacheWrite": 0, "total": 0}}})
    push({"role": "toolResult", "toolCallId": "fixture", "toolName": name,
          "content": [{"type": "text", "text": "RESULT_VISIBLE"}],
          "isError": False, "timestamp": 0})
    return "\n".join(json.dumps(entry) for entry in entries) + "\n"


def run_case(name, args, summary, width, output_dir):
    with tempfile.TemporaryDirectory(prefix="pi-call-tui-") as scratch:
        cwd = Path(scratch)
        agent = cwd / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"theme": "dark", "quietStartup": True}))
        (agent / "pi-tool-output").mkdir()
        (agent / "pi-tool-output" / "config.json").write_text(json.dumps({
            "customToolOverrides": {"unknown_fixture": {"enabled": True, "outputMode": "preview"}}}))
        # Pi intentionally uses raw fallback rendering for historical tool names
        # with no installed definition. Register inert definitions to exercise
        # the late-render adapter seam without loading/executing those tools.
        fixtures = cwd / "fixtures.ts"
        fixtures.write_text('''
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
export default function(pi) {
  for (const name of ["subagent", "mcp", "unknown_fixture"]) {
    pi.registerTool({ name, label: name, description: "Rendering fixture",
      parameters: Type.Object({}), execute: async () => ({ content: [] }),
      renderCall: () => new Text("UNDECORATED_FIXTURE", 0, 0),
      renderResult: () => new Text("UNDECORATED_RESULT", 0, 0),
    });
  }
}
''')
        session = cwd / "session.jsonl"
        session.write_text(seed(cwd, name, args))
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ.update({"PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color",
                               "COLORTERM": "truecolor"})
            os.execvp("pi", ["pi", "--no-extensions", "-e", str(ROOT / "pi-tool-output/index.ts"),
                            "-e", str(fixtures), "--no-skills", "--no-prompt-templates", "--no-themes",
                            "--provider", "openai", "--model", "gpt-4o",
                            "--session", str(session)])
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, width, 0, 0))
        screen = pyte.Screen(width, 40)
        stream = pyte.Stream(screen)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        raw = bytearray()
        prefix = output_dir / f"{name}-{width}"

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
            Path(f"{prefix}-{stage}.txt").write_text(text)

        try:
            collapsed = receive_until(lambda text: "RESULT_VISIBLE" in text and summary in text)
            save("collapsed", collapsed)
            assert "BODY_MARKER" not in collapsed, collapsed
            assert "UNDECORATED" not in collapsed, collapsed
            # Summary and results have different real theme foregrounds.
            def color_at(needle):
                for row, line in enumerate(screen.display):
                    col = line.find(needle)
                    if col >= 0:
                        return screen.buffer[row][col].fg
                raise AssertionError(needle)
            assert color_at(summary) != color_at("RESULT_VISIBLE")
            os.write(fd, b"\x0f")  # app.tools.expand: Ctrl+O
            expanded = receive_until(lambda text: "BODY_MARKER" in text and "arguments capped" in text)
            save("expanded", expanded)
            assert "RESULT_VISIBLE" in expanded, expanded
            os.write(fd, b"\x0f")
            collapsed_again = receive_until(lambda text: "BODY_MARKER" not in text and "RESULT_VISIBLE" in text and summary in text)
            save("recollapsed", collapsed_again)
            assert b"exceeds terminal width" not in raw
            assert b"Failed to load extension" not in raw
            print(f"PASS {name} at {width} columns: summary, visible result, Ctrl+O round trip", flush=True)
        finally:
            Path(f"{prefix}.ansi").write_bytes(raw)
            # The fixture has no live work or durable session to save. Pi can
            # intercept TERM, so force-stop this isolated child rather than hang
            # the test waiting for an interactive shutdown.
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    options = parser.parse_args()
    output = options.output_dir or Path(tempfile.mkdtemp(prefix="pi-call-tui-screens-"))
    output.mkdir(parents=True, exist_ok=True)
    print(f"Screens: {output}", flush=True)
    body = "BODY_MARKER\n" * 1000
    for columns in [100, 40, 26]:
        run_case("bash", {"command": f"python3 - <<'PY'\n{body}PY"}, "python3", columns, output)
        run_case("subagent", {"workflowScript": body, "async": True}, "Scripted workflow", columns, output)
        run_case("mcp", {"server": "linear", "args": {"query": body}}, "server: linear", columns, output)
        run_case("unknown_fixture", {"prompt": body}, "prompt:", columns, output)
