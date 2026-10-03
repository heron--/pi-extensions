#!/usr/bin/env python3
"""Offline real-Pi cost-source check. Requires pyte; uses scratch config/sessions."""
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


def run_case(width, mode, output):
    with tempfile.TemporaryDirectory(prefix="pi-footer-cost-") as scratch:
        cwd = Path(scratch)
        agent = cwd / "agent"
        (agent / "pi-context-footer").mkdir(parents=True)
        (agent / "settings.json").write_text(json.dumps({"theme": "dark", "quietStartup": True}))
        (agent / "pi-context-footer/config.json").write_text(json.dumps({"costSource": {"id": "meter"}}))
        provider = cwd / "meter.ts"
        provider.write_text('''
export default function(pi) {
  let unsubscribe;
  pi.on("session_start", (_event, ctx) => {
    unsubscribe = pi.events.on("pi-context-footer:cost-request:v1", request => {
      if (request.source !== "meter" || request.sessionId !== ctx.sessionManager.getSessionId()) return;
      const timer = setTimeout(() => {
        if (!request.signal.aborted) request.respond({ costUsd: 3.25, partial: true });
      }, 300);
      request.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
  });
  pi.on("session_shutdown", () => unsubscribe?.());
}
''')
        session = cwd / "session.jsonl"
        session.write_text("\n".join(json.dumps(entry) for entry in [
            {"type": "session", "version": 3, "id": str(uuid.uuid4()), "timestamp": "2026-01-01T00:00:00Z", "cwd": str(cwd)},
            {"type": "message", "id": "abc123", "parentId": None, "timestamp": "2026-01-01T00:00:00Z", "message": {
                "role": "assistant", "content": [{"type": "text", "text": "Cost fixture"}], "api": "openai-completions",
                "provider": "openai", "model": "gpt-4o", "timestamp": 0, "stopReason": "stop",
                "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 12,
                          "cost": {"input": 7, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 7}}}},
        ]) + "\n")
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ.update({"PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color", "COLORTERM": "truecolor"})
            os.execvp("pi", ["pi", "--no-extensions", "-e", str(ROOT / "pi-context-footer/index.ts"), "-e", str(provider),
                            "--offline", "--no-skills", "--no-prompt-templates", "--no-themes", "--tui-mode", mode,
                            "--provider", "openai", "--model", "gpt-4o", "--session", str(session)])
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, width, 0, 0))
        screen = pyte.Screen(width, 40)
        stream = pyte.Stream(screen)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        raw = bytearray()
        prefix = output / f"{mode}-{width}"

        def receive_until(predicate, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.05)[0]:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        raise AssertionError("Pi exited early")
                    raw.extend(chunk)
                    if b"\x1b]11;?" in chunk:
                        os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
                    if b"\x1b]10;?" in chunk:
                        os.write(fd, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
                    if b"\x1b[c" in chunk:
                        os.write(fd, b"\x1b[?62;22c")
                    stream.feed(decoder.decode(chunk))
                text = "\n".join(screen.display)
                if predicate(text):
                    return text
            raise AssertionError("Expected screen did not appear:\n" + "\n".join(screen.display))

        try:
            external = receive_until(lambda text: "$3.25 (partial)" in text)
            Path(f"{prefix}-external.txt").write_text(external)
            assert "$7.00" not in external, external
            os.write(fd, b"/context-footer cost local\r")
            local = receive_until(lambda text: "$7.00" in text and "$3.25" not in text)
            Path(f"{prefix}-local.txt").write_text(local)
            os.write(fd, b"/context-footer cost meter\r")
            restored = receive_until(lambda text: "$3.25 (partial)" in text and "$7.00" not in text)
            Path(f"{prefix}-restored.txt").write_text(restored)
            assert b"exceeds terminal width" not in raw
            assert b"Failed to load extension" not in raw
            print(f"PASS {mode} at {width} columns: async override, partial label, local fallback, source restore", flush=True)
        finally:
            Path(f"{prefix}.ansi").write_bytes(raw)
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            os.close(fd)


if __name__ == "__main__":
    output = Path(tempfile.mkdtemp(prefix="pi-footer-cost-screens-"))
    print(f"Screens: {output}", flush=True)
    for mode in ["fullscreen", "regular"]:
        for width in [120, 23]:
            run_case(width, mode, output)
