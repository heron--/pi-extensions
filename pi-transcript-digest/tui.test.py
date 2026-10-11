#!/usr/bin/env python3
"""Check digest message headers in real Pi screens without model calls.

Run: python3 pi-transcript-digest/tui.test.py [--output-dir /tmp/digest-screens]
Requires pyte. Uses scratch settings and a synthetic session, toggles the split
with real keystrokes, and checks colors and rules across terminal resizes.
"""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import tempfile
import termios
import time
import uuid

import pyte

ROOT = Path(__file__).resolve().parent.parent
ROWS = 80
USAGE = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
         "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}


def seed(cwd):
    entries = [{"type": "session", "version": 3, "id": str(uuid.uuid4()),
                "timestamp": "2026-01-02T09:05:00Z", "cwd": str(cwd)}]
    parent = None

    start = 1767344640000  # 2026-01-02 09:04 UTC

    def push(message, at):
        nonlocal parent
        entry_id = uuid.uuid4().hex[:8]
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at / 1000))
        entries.append({"type": "message", "id": entry_id, "parentId": parent,
                        "timestamp": stamp, "message": message})
        parent = entry_id

    def assistant(content, stop_reason, at):
        push({"role": "assistant", "content": content, "api": "openai-completions",
              "provider": "openai", "model": "fixture-model-with-long-name", "timestamp": at,
              "stopReason": stop_reason, "usage": USAGE}, at + 30_000)

    def result(call_id, at):
        push({"role": "toolResult", "toolCallId": call_id, "toolName": "read",
              "content": [{"type": "text", "text": "HIDDEN_TOOL_RESULT"}], "isError": False,
              "timestamp": at}, at)

    push({"role": "user", "content": "USER_BODY", "timestamp": start}, start)
    assistant([{"type": "thinking", "thinking": "HIDDEN_INITIAL_THINKING"},
               {"type": "thinking", "thinking": "HIDDEN_SECOND_THINKING"}], "toolUse", start + 60_000)
    for index, text in enumerate(["AGENT_BODY", "MIDDLE_BODY"], 1):
        at = start + (index + 1) * 60_000
        assistant([{"type": "text", "text": text},
                   {"type": "thinking", "thinking": "HIDDEN_THINKING"},
                   {"type": "toolCall", "id": f"c{index}", "name": "read", "arguments": {"path": "fixture.txt"}}], "toolUse", at)
        result(f"c{index}", at + 40_000)
    assistant([{"type": "text", "text": "FINAL_BODY"}], "stop", start + 240_000)
    push({"role": "user", "content": "NEXT_USER_BODY", "timestamp": start + 300_000}, start + 300_000)
    return "\n".join(json.dumps(entry) for entry in entries) + "\n"


def run(output_dir, theme_path=None):
    with tempfile.TemporaryDirectory(prefix="pi-digest-tui-") as scratch:
        cwd = Path(scratch)
        agent = cwd / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({
            "theme": theme_path.stem if theme_path else "dark", "quietStartup": True, "hideThinkingBlock": True,
            "terminal": {"trueColor": True},
        }))
        fixtures = cwd / "fixtures.ts"
        fixtures.write_text('''
import { truncateToWidth } from "@earendil-works/pi-tui";
export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("digest-color-fixture", (_tui, theme) => ({
      render: (width) => [truncateToWidth([
        theme.fg("syntaxType", "USER_COLOR"), theme.fg("warning", "AGENT_COLOR"),
        theme.fg("success", "ACTIVITY_COLOR"), theme.fg("dim", "TIME_COLOR"),
      ].join(" "), width)],
      invalidate() {},
    }));
  });
}
''')
        session = cwd / "session.jsonl"
        session.write_text(seed(cwd))
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ.update({"PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color",
                               "COLORTERM": "truecolor", "TZ": "UTC"})
            os.execvp("pi", ["pi", "--no-extensions", "-e", str(ROOT / "pi-transcript-digest/index.ts"),
                            "-e", str(fixtures), "--offline", "--no-skills", "--no-prompt-templates",
                            "--no-themes", "--no-context-files", "--tui-mode", "fullscreen",
                            "--provider", "openai", "--model", "gpt-4o", "--session", str(session),
                            *(["--theme", str(theme_path)] if theme_path else [])])
        width = 160
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, width, 0, 0))
        screen = pyte.Screen(width, ROWS)
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

        def color_at(needle):
            for row, line in enumerate(screen.display):
                col = line.find(needle)
                if col >= 0:
                    return screen.buffer[row][col].fg
            raise AssertionError(needle)

        def resize(columns):
            nonlocal width
            width = columns
            screen.resize(lines=ROWS, columns=columns)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, columns, 0, 0))
            os.kill(pid, signal.SIGWINCH)

        def command(text):
            os.write(fd, text.encode() + b"\r")

        def check_digest():
            split = (width - 1) // 2
            pane_width = width - split
            content_width = pane_width - 4
            right = [line[split:] for line in screen.display]
            assert any("Transcript Digest" in line for line in right), capture()
            assert not any("HIDDEN_" in line for line in right), capture()
            assert all(any(body in line for line in right) for body in
                       ["USER_BODY", "AGENT_BODY", "MIDDLE_BODY", "FINAL_BODY", "NEXT_USER_BODY"]), capture()
            headers = []
            for row, line in enumerate(right):
                match = re.match(r"^(User|Agent)(?: \(| \d|$)", line[2:-2].strip())
                if match:
                    headers.append((row, colors[match[1]]))
            assert len(headers) == 3, capture()
            agent_headers = [row for row, _ in headers if right[row][2:].startswith("Agent")]
            assert len(agent_headers) == 1, "all consecutive agent content shares one header"
            first_activity = next(row for row, line in enumerate(right) if "0 tool calls" in line)
            heading = "".join(right[row][2:-2].strip() for row in range(agent_headers[0], first_activity))
            assert "fixture-model-with-long-name" in heading.replace(" ", ""), heading
            assert "2026-01-0209:05" in heading.replace(" ", ""), "thinking-first headers retain model and timestamp"
            rules = []
            for row, line in enumerate(right):
                if line.startswith("│ ") and line[2:2 + content_width] == "─" * content_width:
                    rules.append(row)
                    role_color = next(color for start, color in reversed(headers) if start < row)
                    assert line[1] == " " and line[-2] == " ", line
                    assert all(screen.buffer[row][split + 2 + col].fg == role_color
                               for col in range(content_width)), "the whole rule has the role color"
            assert len(rules) == 4, "three headers and one agent closing rule"
            for row, color in headers:
                assert screen.buffer[row][split + 2].fg == color, "role labels have their own colors"
            for needle, color, count in [("0 tool calls", colors["activity"], 1),
                                         ("1 tool call", colors["activity"], 2),
                                         ("tool", colors["activity"], 4),
                                         ("thinking", colors["time"], 4)]:
                activity_rows = [row for row, line in enumerate(right) if needle in line]
                assert len(activity_rows) == count, capture()
                for row in activity_rows:
                    owner = next(start for start, _ in reversed(headers) if start < row)
                    assert right[owner][2:].startswith("Agent"), "activity and totals belong to Agent, not User"
                    col = split + right[row].index(needle)
                    assert all(screen.buffer[row][col + offset].fg == color for offset in range(len(needle))), \
                        "only tool calls are green; thinking stays subdued"
                    assert all(screen.buffer[row][col + offset].italics for offset in range(len(needle))), \
                        "both counts remain italic"
                    if "tool call" in needle:
                        assert screen.buffer[row][col + len(needle)].data == ","
                        assert screen.buffer[row][col + len(needle)].fg == colors["time"], "separator stays subdued"
            total = next(row for row, line in enumerate(right) if "Total:" in line)
            assert total - 1 in rules, "the totals follow the closing rule"
            assert agent_headers[0] < total < headers[-1][0], "the footer closes before the next user section"
            content = "".join(right[row][2:-2].strip() for row in range(agent_headers[0], headers[-1][0])).replace(" ", "")
            assert "Total:2toolcalls,4thinkingblocks" in content, "the footer sums all activity in the section"
            assert "(2026-01-02" not in content, "message bodies have no standalone timestamps"
            assert "0toolcalls,2thinkingblocks·1m00s" in content, "the first batch starts at the section timestamp"
            assert content.count("1toolcall,1thinkingblock·1m00s") == 2, "later batches show their own time gaps"
            duration_rows = [row for row, line in enumerate(right) if "1m" in line]
            assert len(duration_rows) == 3, capture()
            for row in duration_rows:
                col = split + right[row].index("1m")
                assert screen.buffer[row][col].fg == colors["time"] and screen.buffer[row][col].italics, "durations stay subdued"
            assert "Agentturn4m30s" in content and "Userturn30s" in content, "timing stays with section totals"
            stamp = next(row for row, line in enumerate(right) if "2026-01-02" in line)
            col = split + right[stamp].index("2026-01-02")
            assert screen.buffer[stamp][col].fg == colors["time"], "timestamps remain dim"

        try:
            receive_until(lambda text: "TIME_COLOR" in text and "FINAL_BODY" in text)
            colors = {"User": color_at("USER_COLOR"), "Agent": color_at("AGENT_COLOR"),
                      "activity": color_at("ACTIVITY_COLOR"), "time": color_at("TIME_COLOR")}
            assert len(set(colors.values())) == 4, colors
            command("/transcript-digest on")
            receive_until(lambda text: "Transcript Digest" in text and "1 tool call," in text)
            check_digest()
            (output_dir / f"digest-{width}.txt").write_text(capture())
            print(f"PASS digest headers at {width} columns", flush=True)
            for columns in [100, 60, 40]:
                resize(columns)
                receive_until(lambda text: "FINAL_BODY" in text and "1 tool call," in text)
                check_digest()
                (output_dir / f"digest-{width}.txt").write_text(capture())
                print(f"PASS digest headers at {width} columns", flush=True)

            resize(35)
            receive_until(lambda text: "Transcript Digest" not in text and "FINAL_BODY" in text)
            (output_dir / "digest-35-hidden.txt").write_text(capture())
            resize(100)
            receive_until(lambda text: "Transcript Digest" in text and "1 tool call," in text)
            check_digest()
            command("/transcript-digest off")
            receive_until(lambda text: "Transcript Digest" not in text and "FINAL_BODY" in text)
            command("/transcript-digest on")
            receive_until(lambda text: "Transcript Digest" in text and "1 tool call," in text)
            check_digest()
            assert b"exceeds terminal width" not in raw
            assert b"Failed to load extension" not in raw
            print("PASS hide, resize restore, and command toggles", flush=True)
        finally:
            (output_dir / "digest.ansi").write_bytes(raw)
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--theme", type=Path, help="Also load this theme instead of built-in dark")
    options = parser.parse_args()
    output = options.output_dir or Path(tempfile.mkdtemp(prefix="pi-digest-screens-"))
    output.mkdir(parents=True, exist_ok=True)
    print(f"Screens: {output}", flush=True)
    run(output, options.theme.resolve() if options.theme else None)
